import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';
import { lzmaBlockDecompress } from './lzma.mjs';
import { inspectIl2cpp } from './il2cpp.mjs';

const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const compressionNames = ['none', 'lzma', 'lz4', 'lz4hc', 'lzham'];
const limits = { headerBytes: 512, tableBytes: 4 * 1024 * 1024, blocks: 4096, nodes: 512, pathBytes: 4096, detailBytes: 96 * 1024, payloadBytes: 64 * 1024 * 1024, payloadDecodedBytes: 256 * 1024 * 1024, payloadNodes: 32, previewBytes: 24 };
const compressionName = code => compressionNames[code] ?? `unknown(${code})`;
const align16 = offset => Math.ceil(offset / 16) * 16;

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

function parseUnityfsHeader(buffer, fileSize) {
  const magic = Buffer.from('UnityFS\0');
  if (buffer.length < 12 || !buffer.subarray(0, 8).equals(magic)) throw new Error('未识别到 UnityFS 头。');
  const formatVersion = buffer.readUInt32BE(8);
  if (formatVersion < 6) throw new Error('暂不支持此 UnityFS 格式版本。');
  const tableLayout = formatVersion > 9 ? 'unverified' : 'verified';
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
    format: 'unityfs', formatVersion, tableLayout, unityVersion, unityRevision, declaredSize: declaredSize.toString(), flags,
    blocksInfo: { compressedBytes, uncompressedBytes, compressionCode, compression: compressionName(compressionCode), atEnd },
    offset, encrypted, dataBytes: dataEnd - dataStart, dataStart,
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

function parseBlocksInfo(bytes, dataBytes, formatVersion) {
  if (bytes.length < 20) throw new Error('UnityFS 块信息段不完整（缺少内容哈希或块数）。');
  const hash = bytes.subarray(0, 16).toString('hex');
  const blockCount = bytes.readInt32BE(16);
  let cursor = 20;
  if (blockCount < 0 || blockCount > limits.blocks) throw new Error(`UnityFS 块数 ${blockCount} 超出 0–${limits.blocks} 上限。`);
  // v9 adds a big-endian u64 storage offset relative to the data section.
  const hasOffsets = formatVersion === 9;
  const entryBytes = hasOffsets ? 18 : 10;
  if (cursor + blockCount * entryBytes + 4 > bytes.length) throw new Error('UnityFS 块表不完整（块数与声明不一致）。');
  const blocks = tableDetails(blockCount);
  const blockList = [];
  const codecs = new Set();
  let uncompressedTotal = 0;
  let compressedTotal = 0;
  let previousEnd = 0;
  for (let index = 0; index < blockCount; index++) {
    const uncompressedSize = bytes.readUInt32BE(cursor);
    const compressedSize = bytes.readUInt32BE(cursor + 4);
    const flags = bytes.readUInt16BE(cursor + 8);
    cursor += 10;
    const compression = compressionName(flags & 0x3f);
    if (compression === 'none' && uncompressedSize !== compressedSize) throw new Error(`UnityFS 第 ${index} 块声明未压缩，但存储长度与逻辑长度不一致。`);
    let offset = previousEnd;
    if (hasOffsets) {
      const stored = bytes.readBigUInt64BE(cursor);
      cursor += 8;
      if (stored > BigInt(dataBytes)) throw new Error(`UnityFS 第 ${index} 块的存储偏移 ${stored} 超出数据区 ${dataBytes} 字节。`);
      offset = Number(stored);
      if (offset < previousEnd) throw new Error(`UnityFS 第 ${index} 块的存储偏移 ${offset} 与前一块结束位置 ${previousEnd} 重叠。`);
      if (compressedSize > dataBytes - offset) throw new Error(`UnityFS 第 ${index} 块的存储范围 ${offset}+${compressedSize} 超出数据区 ${dataBytes} 字节。`);
    }
    previousEnd = offset + compressedSize;
    const item = { index, uncompressedSize, compressedSize, flags, compression };
    blockList.push({ ...item, offset });
    blocks.add(hasOffsets ? blockList[index] : item);
    codecs.add(compression);
    uncompressedTotal += uncompressedSize;
    compressedTotal += compressedSize;
  }
  if (!hasOffsets && compressedTotal > dataBytes) throw new Error(`UnityFS 块存储长度之和 ${compressedTotal} 超出数据区 ${dataBytes} 字节。`);
  const nodeCount = bytes.readInt32BE(cursor);
  cursor += 4;
  if (nodeCount < 0 || nodeCount > limits.nodes) throw new Error(`UnityFS 节点数 ${nodeCount} 超出 0–${limits.nodes} 上限。`);
  const nodes = tableDetails(nodeCount);
  const nodeList = [];
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
    const item = { index, path, offset: Number(offset), size: Number(size), flags };
    nodeList.push(item);
    nodes.add(item);
  }
  if (cursor !== bytes.length) throw new Error('UnityFS 块信息段有未被声明表项消耗的尾随字节。');
  const compression = [...codecs].sort();
  return {
    hash,
    blocks: { ...blocks.result(), uncompressedBytes: uncompressedTotal, compressedBytes: compressedTotal, compression },
    nodes: nodes.result(),
    blockList,
    nodeList,
    logicalBytes: uncompressedTotal,
    payload: {
      status: 'skipped', compression,
      reason: compression.some(codec => codec !== 'none') ? '数据区含压缩块，未解压，节点内容未观测。' : '节点内容未解析。',
    },
  };
}

const payloadCodecs = new Set(['none', 'lz4', 'lz4hc', 'lzma']);

function payloadMagic(body) {
  if (body.length >= 8 && body.subarray(0, 8).equals(Buffer.from('UnityFS\0'))) return 'unityfs';
  if (body.length >= 4 && body[0] === 0x50 && body[1] === 0x4b && body[2] === 0x03 && body[3] === 0x04) return 'zip';
  if (body.length > 0 && body.every(byte => byte === 0)) return 'zero-filled';
  return 'binary';
}

// 逐块解压数据区再按节点切片：只算哈希、前 24 字节与类型魔数，不落任何节点内容。
// 磁盘上的数据区大小和解压后的字节数各有一道上限，任何一块声明超出都直接跳过而不是先分配。
async function extractPayload(handle, dataStart, dataBytes, blockList, nodeList, logicalBytes, signal) {
  signal?.throwIfAborted();
  if (dataBytes > limits.payloadBytes) {
    return { status: 'skipped', reason: `数据区 ${dataBytes} 字节超出 ${limits.payloadBytes} 字节读取上限，节点内容未观测。` };
  }
  const unsupported = [...new Set(blockList.map(block => block.compression).filter(codec => !payloadCodecs.has(codec)))];
  if (unsupported.length) {
    return { status: 'skipped', reason: `数据区含 ${unsupported.join('、')} 压缩块，该编码暂未支持，节点内容未观测。` };
  }
  if (logicalBytes > limits.payloadDecodedBytes) {
    return { status: 'skipped', reason: `数据区解压后声明 ${logicalBytes} 字节，超出 ${limits.payloadDecodedBytes} 字节解压上限，节点内容未观测。` };
  }
  const oversized = blockList.find(block => block.uncompressedSize > limits.payloadDecodedBytes);
  if (oversized) {
    return { status: 'skipped', reason: `第 ${oversized.index} 块声明解压后 ${oversized.uncompressedSize} 字节，超出 ${limits.payloadDecodedBytes} 字节解压上限，节点内容未观测。` };
  }
  const packed = await readAt(handle, dataStart, dataBytes, signal);
  const chunks = [];
  let total = 0;
  for (const block of blockList) {
    signal?.throwIfAborted();
    const slice = packed.subarray(block.offset, block.offset + block.compressedSize);
    if (slice.length !== block.compressedSize) throw new Error(`UnityFS 数据区不足以容纳第 ${block.index} 块声明长度。`);
    const body = block.compression === 'none' ? slice
      : block.compression === 'lzma' ? lzmaBlockDecompress(slice, block.uncompressedSize, { maxOutput: limits.payloadDecodedBytes, signal })
        : lz4BlockDecompress(slice, block.uncompressedSize, { signal });
    if (body.length !== block.uncompressedSize) throw new Error(`UnityFS 第 ${block.index} 块解压后 ${body.length} 字节，声明 ${block.uncompressedSize} 字节。`);
    chunks.push(body);
    total += body.length;
  }
  if (total !== logicalBytes) throw new Error(`UnityFS 数据区解压后 ${total} 字节，块表声明 ${logicalBytes} 字节。`);
  const logical = Buffer.concat(chunks, total);
  const nodes = nodeList.slice(0, limits.payloadNodes).map(node => {
    const body = logical.subarray(node.offset, node.offset + node.size);
    return {
      index: node.index, path: node.path, size: node.size,
      sha256: createHash('sha256').update(body).digest('hex'),
      magic: payloadMagic(body),
      preview: body.subarray(0, limits.previewBytes).toString('hex'),
    };
  });
  return { status: 'parsed', bytes: total, nodes, truncated: nodeList.length > nodes.length, nodeLimit: limits.payloadNodes };
}

// LZ4 块格式（Unity 的 LZ4 与 LZ4HC 共用同一块编码）：token 高 4 位字面量长度、低 4 位匹配长度减 4，
// 15 表示后续以 255 为步长累加。匹配可自重叠，必须逐字节回填。
function lz4BlockDecompress(src, expectedSize, { maxOutput = limits.payloadDecodedBytes, signal } = {}) {
  if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) throw new Error('LZ4 声明的解压长度无效。');
  if (expectedSize > maxOutput) throw new Error(`LZ4 声明的解压长度 ${expectedSize} 字节超出 ${maxOutput} 字节上限。`);
  const out = Buffer.alloc(expectedSize);
  let ip = 0;
  let op = 0;
  while (ip < src.length) {
    const token = src[ip];
    ip += 1;
    let literalLength = token >> 4;
    if (literalLength === 15) {
      let step;
      do {
        if (ip >= src.length) throw new Error('LZ4 字面量长度扩展缺少字节。');
        step = src[ip]; ip += 1; literalLength += step;
      } while (step === 255);
    }
    if (ip + literalLength > src.length) throw new Error('LZ4 字面量长度超出输入。');
    if (op + literalLength > expectedSize) throw new Error('LZ4 字面量长度超出声明大小。');
    src.copy(out, op, ip, ip + literalLength);
    ip += literalLength;
    op += literalLength;
    if (op >= expectedSize) break;
    if (ip + 2 > src.length) throw new Error('LZ4 匹配偏移缺字节。');
    const offset = src[ip] | (src[ip + 1] << 8);
    ip += 2;
    if (offset === 0 || offset > op) throw new Error('LZ4 匹配偏移无效。');
    let matchLength = (token & 0x0f) + 4;
    if ((token & 0x0f) === 15) {
      let step;
      do {
        if (ip >= src.length) throw new Error('LZ4 匹配长度扩展缺少字节。');
        step = src[ip]; ip += 1; matchLength += step;
      } while (step === 255);
    }
    if (op + matchLength > expectedSize) throw new Error('LZ4 匹配长度超出声明大小。');
    for (let at = 0; at < matchLength; at += 1) {
      out[op] = out[op - offset];
      op += 1;
      if ((op & 0x3fff) === 0) signal?.throwIfAborted();
    }
  }
  if (ip !== src.length) throw new Error(`LZ4 数据在结束标记后仍有 ${src.length - ip} 字节未消费。`);
  if (op !== expectedSize) throw new Error(`LZ4 解压得到 ${op} 字节，声明为 ${expectedSize} 字节。`);
  return out;
}

async function inspectUnityfs(handle, fileSize, signal) {
  const prefix = await readAt(handle, 0, Math.min(fileSize, limits.headerBytes), signal);
  const { offset, encrypted, dataBytes, dataStart, ...header } = parseUnityfsHeader(prefix, fileSize);
  const { blocksInfo } = header;
  if (header.tableLayout === 'unverified') {
    const reason = `UnityFS 格式版本 ${header.formatVersion} 的块表布局未独立核对：只保留头部事实，块表、节点表与数据区未解析。`;
    return { ...header, dataBytes, blocksInfo: { ...blocksInfo, status: 'unsupported' }, blocks: null, nodes: null,
      payload: { status: 'skipped', reason }, reason };
  }
  if (encrypted) {
    return { ...header, blocksInfo: { ...blocksInfo, status: 'unobserved' }, blocks: null, nodes: null,
      payload: { status: 'skipped', reason: 'UnityFS 声明加密扩展，节点内容未解密、未观测。' },
      reason: 'UnityFS 声明加密扩展，块表与节点表未观测。' };
  }
  let table;
  if (blocksInfo.compressionCode === 0) {
    if (blocksInfo.compressedBytes !== blocksInfo.uncompressedBytes) throw new Error('UnityFS 块信息段声明未压缩，但压缩前后长度不一致。');
    if (blocksInfo.compressedBytes > limits.tableBytes) throw new Error(`UnityFS 块信息段超出 ${limits.tableBytes} 字节读取上限。`);
    table = await readAt(handle, offset, blocksInfo.compressedBytes, signal);
  } else if (blocksInfo.compressionCode === 1) {
    if (blocksInfo.compressedBytes > limits.tableBytes || blocksInfo.uncompressedBytes > limits.tableBytes) {
      throw new Error(`UnityFS 块信息段超出 ${limits.tableBytes} 字节读取上限。`);
    }
    const packed = await readAt(handle, offset, blocksInfo.compressedBytes, signal);
    table = lzmaBlockDecompress(packed, blocksInfo.uncompressedBytes, { maxOutput: limits.tableBytes, signal });
  } else if (blocksInfo.compressionCode === 2 || blocksInfo.compressionCode === 3) {
    if (blocksInfo.compressedBytes > limits.tableBytes || blocksInfo.uncompressedBytes > limits.tableBytes) {
      throw new Error(`UnityFS 块信息段超出 ${limits.tableBytes} 字节读取上限。`);
    }
    const packed = await readAt(handle, offset, blocksInfo.compressedBytes, signal);
    table = lz4BlockDecompress(packed, blocksInfo.uncompressedBytes, { maxOutput: limits.tableBytes, signal });
  } else {
    return { ...header, blocksInfo: { ...blocksInfo, status: 'unobserved' }, blocks: null, nodes: null,
      payload: { status: 'skipped', reason: `块信息段以 ${blocksInfo.compression} 压缩，该编码暂未支持，节点内容未观测。` },
      reason: `块信息段以 ${blocksInfo.compression} 压缩（${blocksInfo.compressedBytes} → ${blocksInfo.uncompressedBytes} 字节），该编码暂未支持，块表与节点表未观测。` };
  }
  const { hash, blockList, nodeList, logicalBytes, ...result } = parseBlocksInfo(table, dataBytes, header.formatVersion);
  let payload = result.payload;
  try {
    payload = await extractPayload(handle, dataStart, dataBytes, blockList, nodeList, logicalBytes, signal);
  } catch (error) {
    signal?.throwIfAborted();
    payload = { status: 'failed', reason: `数据区解压失败：${String(error?.message ?? error).slice(0, 200)}` };
  }
  const storage = header.formatVersion === 9 ? { dataStart, dataBytes } : {};
  return { ...header, ...storage, blocksInfo: { ...blocksInfo, status: 'parsed', hash }, ...result, payload };
}

export async function inspectUnityHeader(path, size, kind, signal) {
  signal?.throwIfAborted();
  const handle = await open(path, 'r');
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || !Number.isSafeInteger(size) || initial.size !== size) throw new Error('Unity 素材文件大小无效或已改变。');
    const facts = kind === 'il2cpp-metadata'
      ? await inspectIl2cpp(path, size, signal)
      : await inspectUnityfs(handle, size, signal);
    const final = await handle.stat();
    signal?.throwIfAborted();
    if (initial.size !== final.size || initial.mtimeMs !== final.mtimeMs || initial.ctimeMs !== final.ctimeMs) throw new Error('Unity 素材在读取期间已改变。');
    return facts;
  } finally {
    await handle.close();
  }
}
