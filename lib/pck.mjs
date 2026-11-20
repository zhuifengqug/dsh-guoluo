import { open } from 'node:fs/promises';

const MAGIC = 0x43504447;
const decoder = new TextDecoder('utf-8', { fatal: true });
const sceneExt = new Set(['tscn', 'scn', 'tres', 'res']);
const scriptExt = new Set(['gd', 'gdc', 'cs']);
const resourceExt = new Set(['png', 'svg', 'webp', 'jpg', 'jpeg', 'ttf', 'otf', 'woff', 'woff2', 'wav', 'ogg', 'mp3', 'mp4', 'webm', 'json', 'cfg']);

export async function readPck(path, size, { maxFiles = 20000, signal } = {}) {
  const handle = await open(path, 'r');
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || !Number.isSafeInteger(size) || initial.size !== size) throw new Error('PCK 文件大小无效或已改变。');
    const fileSize = BigInt(size);
    let cursor = 0;
    async function take(length) {
      signal?.throwIfAborted();
      if (cursor + length > size) throw new Error('PCK 文件范围越界。');
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
    const head = await take(20);
    if (head.readUInt32LE(0) !== MAGIC) throw new Error('PCK 头标识无效。');
    const packFormat = head.readUInt32LE(4);
    if (packFormat < 1 || packFormat > 4) throw new Error(`PCK 包格式版本 ${packFormat} 暂不支持。`);
    const engine = `Godot ${head.readUInt32LE(8)}.${head.readUInt32LE(12)}.${head.readUInt32LE(16)}`;
    const modern = packFormat >= 2;
    const flags = modern ? await take(12) : null;
    const packFlags = flags?.readUInt32LE(0) ?? 0;
    // The parser reads standalone packs at offset zero. The relative-base flag affects embedded packs.
    const fileBase = flags?.readBigUInt64LE(4) ?? 0n;
    const directoryOffset = packFormat >= 3 ? (await take(8)).readBigUInt64LE(0) : BigInt(cursor + 64);
    const headerEnd = cursor + 64;
    if (fileBase > fileSize || directoryOffset < BigInt(headerEnd) || directoryOffset + 4n > fileSize) throw new Error('PCK 头部或目录范围越界。');
    cursor = Number(directoryOffset);
    const total = (await take(4)).readUInt32LE(0);
    const base = { format: 'pck', packFormat, engine, packFlags, fileBase: fileBase.toString() };
    const counts = { entries: total, encrypted: 0, directories: 0, scenes: 0, scripts: 0, resources: 0, removed: 0, delta: 0 };
    const directoryStatus = packFlags & 1 ? 'encrypted' : packFlags & 4 ? 'sparse' : 'parsed';
    const finish = async facts => {
      signal?.throwIfAborted();
      const final = await handle.stat();
      if (final.size !== size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) throw new Error('PCK 文件在读取期间发生变化。');
      return { ...base, directoryStatus, ...facts };
    };
    if (directoryStatus !== 'parsed') return await finish({ counts: { entries: total }, declaredBytes: null, files: [] });
    if (total > maxFiles) throw new Error('PCK 文件条目数超出读取上限。');
    const files = [];
    const ranges = [];
    let declaredBytes = 0n;
    for (let i = 0; i < total; i++) {
      const pathLength = (await take(4)).readUInt32LE(0);
      if (!pathLength || pathLength > 4096) throw new Error('PCK 条目路径长度无效。');
      const raw = await take(pathLength);
      const firstZero = raw.indexOf(0);
      if (firstZero !== -1 && raw.subarray(firstZero).some(byte => byte !== 0)) throw new Error('PCK 条目路径填充无效。');
      let name;
      try { name = decoder.decode(firstZero === -1 ? raw : raw.subarray(0, firstZero)); }
      catch { throw new Error('PCK 条目路径不是有效 UTF-8。'); }
      const logical = name.startsWith('res://') ? name.slice(6) : name;
      if (!logical || /[\x00-\x1f\\:]/u.test(logical) || logical.startsWith('/') || logical.split('/').some(part => part === '..' || part === '.')) throw new Error('PCK 条目路径含无效字符。');
      const entry = await take(modern ? 36 : 32);
      const absolute = fileBase + entry.readBigUInt64LE(0);
      const length = entry.readBigUInt64LE(8);
      const entryFlags = modern ? entry.readUInt32LE(32) : 0;
      if (entryFlags & 2) { counts.removed++; continue; }
      if (entryFlags & 4) { counts.delta++; continue; }
      if (name.endsWith('/')) { counts.directories++; continue; }
      const encrypted = (entryFlags & 1) !== 0;
      if (absolute > fileSize || length > fileSize || (!encrypted && absolute + length > fileSize)) throw new Error('PCK 条目范围越界。');
      ranges.push({ start: absolute, end: encrypted ? absolute : absolute + length });
      declaredBytes += length;
      if (encrypted) counts.encrypted++;
      const ext = logical.slice(logical.lastIndexOf('.') + 1).toLowerCase();
      if (sceneExt.has(ext)) counts.scenes++;
      else if (scriptExt.has(ext)) counts.scripts++;
      else if (resourceExt.has(ext)) counts.resources++;
      files.push({ path: name, bytes: Number(length), offset: Number(absolute), encrypted, ext });
    }
    if (ranges.some(({ start, end }) => start < BigInt(headerEnd) || (start < BigInt(cursor) && (start >= directoryOffset || end > directoryOffset)))) throw new Error('PCK 条目与头部或目录重叠。');
    return await finish({ counts, declaredBytes: declaredBytes.toString(), files });
  } finally {
    await handle.close();
  }
}
