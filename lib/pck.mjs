import { open } from 'node:fs/promises';

const MAGIC = 0x43504447;
const flagEncrypted = 1;
const flagRelativeBase = 2;
const maxPath = 4096;
const decoder = new TextDecoder('utf-8', { fatal: true });
const sceneExt = new Set(['tscn', 'scn', 'tres', 'res']);
const scriptExt = new Set(['gd', 'gdc', 'cs']);
const resourceExt = new Set(['png', 'svg', 'webp', 'jpg', 'jpeg', 'ttf', 'otf', 'woff', 'woff2', 'wav', 'ogg', 'mp3', 'mp4', 'webm', 'json', 'cfg']);

export async function readPck(path, size, { maxFiles = 20000, signal } = {}) {
  const handle = await open(path, 'r');
  try {
    const initial = await handle.stat();
    if (!initial.isFile()) throw new Error('PCK 输入不是普通文件。');
    if (initial.size !== size) throw new Error('PCK 文件在读取期间发生变化。');
    let cursor = 0;
    async function take(length) {
      signal?.throwIfAborted();
      if (length < 0 || cursor + length > size) throw new Error('PCK 文件范围越界。');
      const buffer = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer, done, length - done, cursor + done);
        if (!bytesRead) throw new Error('PCK 读取不完整。');
        done += bytesRead;
      }
      cursor += length;
      return buffer;
    }
    const head = await take(8);
    if (head.readUInt32LE(0) !== MAGIC) throw new Error('PCK 头标识无效。');
    const packFormat = head.readUInt32LE(4);
    if (packFormat !== 1 && packFormat !== 2) throw new Error(`PCK 包格式版本 ${packFormat} 暂不支持。`);
    const version = await take(12);
    const major = version.readUInt32LE(0);
    const minor = version.readUInt32LE(4);
    const patch = version.readUInt32LE(8);
    await take(64);
    let packFlags = 0;
    let fileBase = 0n;
    if (packFormat === 2) {
      packFlags = (await take(4)).readUInt32LE(0);
      fileBase = (await take(8)).readBigUInt64LE(0);
    }
    const total = (await take(4)).readUInt32LE(0);
    if (total > maxFiles) throw new Error('PCK 文件条目数超出读取上限。');
    const dirEncrypted = (packFlags & flagEncrypted) !== 0;
    const relative = (packFlags & flagRelativeBase) !== 0;
    const files = [];
    const counts = { entries: total, encrypted: 0, directories: 0, scenes: 0, scripts: 0, resources: 0 };
    let declaredBytes = 0n;
    for (let i = 0; i < total; i++) {
      const pathLength = (await take(4)).readUInt32LE(0);
      if (!pathLength || pathLength > maxPath) throw new Error('PCK 条目路径长度无效。');
      const raw = await take(pathLength);
      const pad = (4 - (pathLength % 4)) % 4;
      if (pad) await take(pad);
      let name;
      try { name = decoder.decode(raw); } catch { throw new Error('PCK 条目路径不是有效 UTF-8。'); }
      if (/[\x00-\x1f\\]/u.test(name) || name.split('/').includes('..')) throw new Error('PCK 条目路径含无效字符。');
      const offset = (await take(8)).readBigUInt64LE(0);
      const length = (await take(8)).readBigUInt64LE(0);
      await take(16);
      const flags = packFormat === 2 ? (await take(4)).readUInt32LE(0) : 0;
      if (name.endsWith('/')) { counts.directories++; continue; }
      const encrypted = dirEncrypted || (flags & flagEncrypted) !== 0;
      const absolute = relative ? fileBase + offset : offset;
      if (!encrypted && absolute + length > BigInt(size)) throw new Error('PCK 条目范围越界。');
      declaredBytes += length;
      if (encrypted) counts.encrypted++;
      const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
      if (sceneExt.has(ext)) counts.scenes++;
      else if (scriptExt.has(ext)) counts.scripts++;
      else if (resourceExt.has(ext)) counts.resources++;
      files.push({ path: name, bytes: Number(length), offset: Number(absolute), encrypted, ext });
    }
    return {
      format: 'pck',
      packFormat,
      engine: `Godot ${major}.${minor}.${patch}`,
      packFlags,
      fileBase: fileBase.toString(),
      counts,
      declaredBytes: declaredBytes.toString(),
      files,
    };
  } finally {
    await handle.close();
  }
}
