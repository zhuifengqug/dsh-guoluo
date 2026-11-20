import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const decoder = new TextDecoder('utf-8', { fatal: true });
const compressionNames = ['none', 'lzma', 'lz4', 'lz4hc', 'lzham'];

export function unityCandidate(path) {
  if (basename(path).toLowerCase() === 'global-metadata.dat') return 'il2cpp-metadata';
  if (['.bundle', '.unity3d'].includes(extname(path).toLowerCase())) return 'unity-bundle';
  return null;
}

function readHeader(buffer, fileSize, kind) {
  if (kind === 'il2cpp-metadata') {
    if (buffer.length < 8 || buffer.readUInt32LE(0) !== 0xfab11baf) throw new Error('IL2CPP 元数据头标识无效或不完整。');
    const metadataVersion = buffer.readInt32LE(4);
    if (metadataVersion <= 0) throw new Error('IL2CPP 元数据声明的版本无效。');
    return { format: 'il2cpp-metadata', metadataVersion };
  }
  const magic = Buffer.from('UnityFS\0');
  if (buffer.length < magic.length + 4 || !buffer.subarray(0, magic.length).equals(magic)) throw new Error('未识别到 UnityFS 头。');
  const formatVersion = buffer.readUInt32BE(magic.length);
  if (formatVersion < 6) throw new Error('暂不支持此 UnityFS 格式版本。');
  let cursor = magic.length + 4;
  function versionString() {
    const end = buffer.indexOf(0, cursor);
    if (end < cursor || end - cursor > 128) throw new Error('UnityFS 版本字符串缺终止符或超出长度上限。');
    const text = decoder.decode(buffer.subarray(cursor, end));
    if (/[\x00-\x1f\x7f]/u.test(text)) throw new Error('UnityFS 版本字符串含控制字符。');
    cursor = end + 1;
    return text;
  }
  const unityVersion = versionString();
  const unityRevision = versionString();
  if (cursor + 20 > buffer.length) throw new Error('UnityFS 头不完整。');
  const declaredSize = buffer.readBigInt64BE(cursor);
  const compressedBytes = buffer.readUInt32BE(cursor + 8);
  const uncompressedBytes = buffer.readUInt32BE(cursor + 12);
  const flags = buffer.readUInt32BE(cursor + 16);
  const compressionCode = flags & 0x3f;
  if (declaredSize < BigInt(cursor + 20 + compressedBytes) || declaredSize > BigInt(fileSize)) throw new Error('UnityFS 声明的包长或元数据块范围越界。');
  return {
    format: 'unityfs', formatVersion, unityVersion, unityRevision, declaredSize: declaredSize.toString(), flags,
    blocksInfo: { compressedBytes, uncompressedBytes, compressionCode, compression: compressionNames[compressionCode] ?? 'unknown', atEnd: Boolean(flags & 0x80) },
  };
}

export async function inspectUnityHeader(path, size, kind, signal) {
  signal?.throwIfAborted();
  const handle = await open(path, 'r');
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || !Number.isSafeInteger(size) || initial.size !== size) throw new Error('Unity 素材文件大小无效或已改变。');
    const buffer = Buffer.alloc(Math.min(size, kind === 'il2cpp-metadata' ? 8 : 512));
    let offset = 0;
    while (offset < buffer.length) {
      signal?.throwIfAborted();
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!bytesRead) throw new Error('Unity 素材头读取不完整。');
      offset += bytesRead;
    }
    const facts = readHeader(buffer, size, kind);
    const final = await handle.stat();
    signal?.throwIfAborted();
    if (initial.size !== final.size || initial.mtimeMs !== final.mtimeMs || initial.ctimeMs !== final.ctimeMs) throw new Error('Unity 素材在读取期间已改变。');
    return facts;
  } finally {
    await handle.close();
  }
}
