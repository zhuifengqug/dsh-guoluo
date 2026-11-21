import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const compressionNames = ['none', 'lzma', 'lz4', 'lz4hc', 'lzham'];
const limits = { headerBytes: 512, tableBytes: 4 * 1024 * 1024, blocks: 4096, nodes: 512, pathBytes: 4096, detailBytes: 96 * 1024 };
const compressionName = code => compressionNames[code] ?? `unknown(${code})`;
const align16 = offset => Math.ceil(offset / 16) * 16;

// 已知 Unity 发行版写入的整数版本。v24 的子版共用同一整数，24.2 起少一对 RGCTX 字段。
// 头长按 Il2CppInspector / Il2CppDumper 的 Il2CppGlobalMetadataHeader 版本化字段计算。
const il2cppHeaderSizes = new Map([
  [16, [192]], [19, [216]], [20, [224]], [21, [240]], [22, [256]], [23, [264]],
  [24, [264, 272]], [27, [256]], [29, [256]], [31, [256]],
]);

export function unityCandidate(path) {
  if (basename(path).toLowerCase() === 'global-metadata.dat') return 'il2cpp-metadata';
  if (['.bundle', '.unity3d'].includes(extname(path).toLowerCase())) return 'unity-bundle';
  return null;
}

async function readAt(handle, offset, length, signal) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, done, length - done, offset + done);
    if (!bytesRead) throw new Error('Unity 素材读取不完整。');
    done += bytesRead;
  }
  return buffer;
}

function parseIl2cpp(buffer, fileSize) {
  if (buffer.length < 8 || buffer.readUInt32LE(0) !== 0xfab11baf) throw new Error('IL2CPP 元数据头标识无效或不完整。');
  const metadataVersion = buffer.readInt32LE(4);
  const sizes = il2cppHeaderSizes.get(metadataVersion);
  if (!sizes) throw new Error(`IL2CPP 元数据版本 ${metadataVersion} 不在已知白名单内。`);
  if (fileSize < sizes[0]) throw new Error(`IL2CPP 元数据文件短于版本 ${metadataVersion} 的最小头长 ${sizes[0]} 字节。`);
  const headerBytes = buffer.readUInt32LE(8);
  if (headerBytes < 16 || headerBytes > fileSize) {
    throw new Error(`IL2CPP 元数据版本 ${metadataVersion} 的首区段偏移 ${headerBytes} 越界（文件 ${fileSize} 字节）。`);
  }
  const facts = { format: 'il2cpp-metadata', metadataVersion, headerBytes };
  if (sizes.includes(headerBytes)) return facts;
  return { ...facts, headerLayout: 'unverified', reason: '声明头长与已知布局不一致，未核对字段表。' };
}

function parseUnityfsHeader(buffer, fileSize) {
  const magic = Buffer.from('UnityFS\0');
  if (buffer.length < 12 || !buffer.subarray(0, 8).equals(magic)) throw new Error('未识别到 UnityFS 头。');
  const formatVersion = buffer.readUInt32BE(8);
  if (formatVersion < 6) throw new Error('暂不支持此 UnityFS 格式版本。');
  let cursor = 12;
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
  const [major, minor, patch] = (/^(\d+)\.(\d+)\.(\d+)/u.exec(unityRevision)?.slice(1) ?? [0, 0, 0]).map(Number);
  const usesAlignment = formatVersion >= 7 || (major === 2019 && (minor > 4 || (minor === 4 && patch >= 15)));
  const headerEnd = cursor + 20;
  const blocksStart = usesAlignment ? align16(headerEnd) : headerEnd;
  if (declaredSize < 0n || declaredSize > BigInt(fileSize)) throw new Error('UnityFS 声明的包长越界。');
  const bundleSize = Number(declaredSize);
  const atEnd = Boolean(flags & 0x80);
  const offset = atEnd ? bundleSize - compressedBytes : blocksStart;
  if (atEnd ? offset < blocksStart : blocksStart + compressedBytes > bundleSize) {
    throw new Error('UnityFS 声明的包长或元数据块范围越界。');
  }
  // UnityPy 的版本阈值：旧枚举的 0x200 表示加密，新枚举的 0x200 表示数据区起点对齐。
  const legacy = major < 2020 || (major === 2020 && (minor < 3 || (minor === 3 && patch < 34)))
    || (major === 2021 && (minor < 3 || (minor === 3 && patch < 2)))
    || (major === 2022 && (minor < 1 || (minor === 1 && patch < 1)));
  const encrypted = Boolean(flags & (legacy ? 0x200 : 0x1400));
  const rawDataStart = atEnd ? blocksStart : offset + compressedBytes;
  const dataStart = !legacy && (flags & 0x200) ? align16(rawDataStart) : rawDataStart;
  const dataEnd = atEnd ? offset : bundleSize;
  if (dataEnd < dataStart) throw new Error(`UnityFS 数据区长度无效（起点 ${dataStart}，终点 ${dataEnd} 字节）。`);
  return {
    format: 'unityfs', formatVersion, unityVersion, unityRevision, declaredSize: declaredSize.toString(), flags,
    blocksInfo: { compressedBytes, uncompressedBytes, compressionCode, compression: compressionName(compressionCode), atEnd },
    offset, encrypted, dataBytes: dataEnd - dataStart,
  };
}

// 全表始终先校验。每张表只返回在 JSON 字节预算内的连续前缀，单条 dossier 记录留足余量。
function tableDetails(count) {
  const items = [];
  let bytes = 0;
  return {
    add(item) {
      if (item.index !== items.length) return;
      const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
      if (bytes + itemBytes > limits.detailBytes) return;
      bytes += itemBytes;
      items.push(item);
    },
    result: () => ({ count, returned: items.length, truncated: items.length < count, items }),
  };
}

function parseBlocksInfo(bytes, dataBytes) {
  if (bytes.length < 20) throw new Error('UnityFS 块信息段不完整（缺少内容哈希或块数）。');
  const hash = bytes.subarray(0, 16).toString('hex');
  const blockCount = bytes.readInt32BE(16);
  let cursor = 20;
  if (blockCount < 0 || blockCount > limits.blocks) throw new Error(`UnityFS 块数 ${blockCount} 超出 0–${limits.blocks} 上限。`);
  if (cursor + blockCount * 10 + 4 > bytes.length) throw new Error('UnityFS 块表不完整（块数与声明不一致）。');
  const blocks = tableDetails(blockCount);
  const codecs = new Set();
  let uncompressedTotal = 0;
  let compressedTotal = 0;
  for (let index = 0; index < blockCount; index++) {
    const uncompressedSize = bytes.readUInt32BE(cursor);
    const compressedSize = bytes.readUInt32BE(cursor + 4);
    const flags = bytes.readUInt16BE(cursor + 8);
    cursor += 10;
    const compression = compressionName(flags & 0x3f);
    if (compression === 'none' && uncompressedSize !== compressedSize) throw new Error(`UnityFS 第 ${index} 块声明未压缩，但存储长度与逻辑长度不一致。`);
    blocks.add({ index, uncompressedSize, compressedSize, flags, compression });
    codecs.add(compression);
    uncompressedTotal += uncompressedSize;
    compressedTotal += compressedSize;
  }
  if (compressedTotal > dataBytes) throw new Error(`UnityFS 块存储长度之和 ${compressedTotal} 超出数据区 ${dataBytes} 字节。`);
  const nodeCount = bytes.readInt32BE(cursor);
  cursor += 4;
  if (nodeCount < 0 || nodeCount > limits.nodes) throw new Error(`UnityFS 节点数 ${nodeCount} 超出 0–${limits.nodes} 上限。`);
  const nodes = tableDetails(nodeCount);
  // 至多 4096 个 uint32 块长，校验后的节点偏移与大小都可无损转为 JSON 数字。
  const logicalBytes = BigInt(uncompressedTotal);
  for (let index = 0; index < nodeCount; index++) {
    if (cursor + 20 > bytes.length) throw new Error('UnityFS 节点表不完整（节点数与声明不一致）。');
    const offset = bytes.readBigInt64BE(cursor);
    const size = bytes.readBigInt64BE(cursor + 8);
    const flags = bytes.readUInt32BE(cursor + 16);
    cursor += 20;
    const end = bytes.subarray(cursor, cursor + limits.pathBytes + 1).indexOf(0);
    if (end < 0) {
      if (bytes.length - cursor > limits.pathBytes) throw new Error(`UnityFS 节点路径超出 ${limits.pathBytes} 字节上限。`);
      throw new Error('UnityFS 节点路径缺终止符。');
    }
    const path = decoder.decode(bytes.subarray(cursor, cursor + end));
    cursor += end + 1;
    if (offset < 0n || size < 0n || offset + size > logicalBytes) throw new Error(`UnityFS 第 ${index} 个节点的偏移或大小越出数据区（${offset}+${size}，数据区 ${logicalBytes} 字节）。`);
    nodes.add({ index, path, offset: Number(offset), size: Number(size), flags });
  }
  if (cursor !== bytes.length) throw new Error('UnityFS 块信息段有未被声明表项消耗的尾随字节。');
  const compression = [...codecs].sort();
  return {
    hash,
    blocks: { ...blocks.result(), uncompressedBytes: uncompressedTotal, compressedBytes: compressedTotal, compression },
    nodes: nodes.result(),
    payload: {
      status: 'unobserved', compression,
      reason: compression.some(codec => codec !== 'none') ? '数据区含压缩块，未解压，节点内容未观测。' : '节点内容未解析。',
    },
  };
}

async function inspectUnityfs(handle, fileSize, signal) {
  const prefix = await readAt(handle, 0, Math.min(fileSize, limits.headerBytes), signal);
  const { offset, encrypted, dataBytes, ...header } = parseUnityfsHeader(prefix, fileSize);
  const { blocksInfo } = header;
  if (encrypted || blocksInfo.compressionCode !== 0) {
    const reason = blocksInfo.compressionCode !== 0
      ? `块信息段以 ${blocksInfo.compression} 压缩（${blocksInfo.compressedBytes} → ${blocksInfo.uncompressedBytes} 字节），未解压，块表与节点表未观测。`
      : 'UnityFS 声明加密扩展，块表与节点表未观测。';
    return { ...header, blocksInfo: { ...blocksInfo, status: 'unobserved' }, blocks: null, nodes: null, reason };
  }
  if (blocksInfo.compressedBytes !== blocksInfo.uncompressedBytes) throw new Error('UnityFS 块信息段声明未压缩，但压缩前后长度不一致。');
  if (blocksInfo.compressedBytes > limits.tableBytes) throw new Error(`UnityFS 块信息段超出 ${limits.tableBytes} 字节读取上限。`);
  const table = await readAt(handle, offset, blocksInfo.compressedBytes, signal);
  const { hash, ...result } = parseBlocksInfo(table, dataBytes);
  return { ...header, blocksInfo: { ...blocksInfo, status: 'parsed', hash }, ...result };
}

export async function inspectUnityHeader(path, size, kind, signal) {
  signal?.throwIfAborted();
  const handle = await open(path, 'r');
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || !Number.isSafeInteger(size) || initial.size !== size) throw new Error('Unity 素材文件大小无效或已改变。');
    const facts = kind === 'il2cpp-metadata'
      ? parseIl2cpp(await readAt(handle, 0, Math.min(size, 12), signal), size)
      : await inspectUnityfs(handle, size, signal);
    const final = await handle.stat();
    signal?.throwIfAborted();
    if (initial.size !== final.size || initial.mtimeMs !== final.mtimeMs || initial.ctimeMs !== final.ctimeMs) throw new Error('Unity 素材在读取期间已改变。');
    return facts;
  } finally {
    await handle.close();
  }
}
