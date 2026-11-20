import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const NO_INDEX = 0xffffffff;
const MAX_ELEMENTS = 100000;
const MAX_STRINGS = 200000;
const MAX_DEPTH = 64;

const AX_STRING_POOL = 0x0001;
const AX_XML = 0x0003;
const AX_START = 0x0102;
const AX_END = 0x0103;

async function readAt(fd, position, length, signal) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    signal?.throwIfAborted();
    const { bytesRead } = await fd.read(buffer, done, length - done, position + done);
    if (!bytesRead) throw new Error('ZIP 读取不完整。');
    done += bytesRead;
  }
  return buffer;
}

function findEocd(tail, fileSize) {
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) !== EOCD) continue;
    const commentLength = tail.readUInt16LE(i + 20);
    if (i + 22 + commentLength === tail.length) return i;
  }
  return -1;
}

async function directory(fd, fileSize, signal) {
  const tailLength = Math.min(fileSize, 65557);
  const tailStart = fileSize - tailLength;
  const tail = await readAt(fd, tailStart, tailLength, signal);
  const at = findEocd(tail, fileSize);
  if (at < 0) throw new Error('ZIP 头无效或不是 ZIP 容器。');
  let totalEntries = tail.readUInt16LE(at + 10);
  let cdSize = tail.readUInt32LE(at + 12);
  let cdOffset = tail.readUInt32LE(at + 16);
  if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    if (at < 20 || tail.readUInt32LE(at - 20) !== ZIP64_LOCATOR) throw new Error('ZIP64 容器缺少定位记录，暂不支持。');
    const z64Offset = Number(tail.readBigUInt64LE(at - 20 + 8));
    if (!Number.isSafeInteger(z64Offset) || z64Offset < 0 || z64Offset + 56 > fileSize) throw new Error('ZIP64 定位越界。');
    const rec = await readAt(fd, z64Offset, 56, signal);
    if (rec.readUInt32LE(0) !== ZIP64_EOCD) throw new Error('ZIP64 记录无效。');
    totalEntries = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }
  return { totalEntries, cdSize, cdOffset };
}

export async function readZip(fd, fileSize, { maxEntries = 20000, maxDirectory = 16 * 1024 * 1024, signal } = {}) {
  if (!Number.isSafeInteger(fileSize) || fileSize < 22) throw new Error('ZIP 文件过短。');
  const { totalEntries, cdSize, cdOffset } = await directory(fd, fileSize, signal);
  if (totalEntries < 0 || totalEntries > maxEntries) throw new Error('ZIP 条目数超出上限。');
  if (cdSize < 0 || cdSize > maxDirectory) throw new Error('ZIP 中央目录超出上限。');
  if (cdOffset < 0 || cdOffset + cdSize > fileSize) throw new Error('ZIP 中央目录越界。');
  const buffer = cdSize ? await readAt(fd, cdOffset, cdSize, signal) : Buffer.alloc(0);
  const entries = [];
  let pos = 0;
  while (pos + 46 <= buffer.length && entries.length < totalEntries) {
    signal?.throwIfAborted();
    if (buffer.readUInt32LE(pos) !== CENTRAL) throw new Error('ZIP 中央目录条目无效。');
    const flags = buffer.readUInt16LE(pos + 8);
    const method = buffer.readUInt16LE(pos + 10);
    const compressed = buffer.readUInt32LE(pos + 20);
    const uncompressed = buffer.readUInt32LE(pos + 24);
    const nameLength = buffer.readUInt16LE(pos + 28);
    const extraLength = buffer.readUInt16LE(pos + 30);
    const commentLength = buffer.readUInt16LE(pos + 32);
    const localOffset = buffer.readUInt32LE(pos + 42);
    const nameEnd = pos + 46 + nameLength;
    if (nameEnd > buffer.length) throw new Error('ZIP 条目名越界。');
    const name = buffer.subarray(pos + 46, nameEnd).toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1');
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 条目暂不支持。');
    entries.push({ name, method, compressed, uncompressed, localOffset });
    pos = nameEnd + extraLength + commentLength;
  }
  if (entries.length !== totalEntries) throw new Error('ZIP 中央目录条目数与记录不符。');
  return entries;
}

export async function readEntry(fd, entry, maxBytes, signal) {
  const header = await readAt(fd, entry.localOffset, 30, signal);
  if (header.readUInt32LE(0) !== LOCAL) throw new Error('ZIP 本地头无效。');
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  if (start + entry.compressed > Number.MAX_SAFE_INTEGER) throw new Error('ZIP 条目越界。');
  const raw = entry.compressed ? await readAt(fd, start, entry.compressed, signal) : Buffer.alloc(0);
  if (entry.uncompressed > maxBytes) throw new Error('ZIP 条目解压后超出上限。');
  if (entry.method === 0) {
    if (raw.length > maxBytes) throw new Error('ZIP 条目超出上限。');
    return raw;
  }
  if (entry.method === 8) {
    try { return inflateRawSync(raw, { maxOutputLength: Math.max(maxBytes, 1) }); }
    catch { throw new Error('ZIP 条目解压失败或超出上限。'); }
  }
  throw new Error(`ZIP 压缩方式 ${entry.method} 暂不支持。`);
}

function decodeLength(buffer, at) {
  const first = buffer[at];
  if (first === undefined) throw new Error('AXML 字符串长度越界。');
  if (first & 0x80) return { length: ((first & 0x7f) << 8) | buffer[at + 1], next: at + 2 };
  return { length: first, next: at + 1 };
}

function stringPool(buffer, pos, headerSize, size, strings) {
  const count = buffer.readUInt32LE(pos + 8);
  const flags = buffer.readUInt32LE(pos + 16);
  const stringsStart = buffer.readUInt32LE(pos + 20);
  if (count > MAX_STRINGS) throw new Error('AXML 字符串数量超出上限。');
  const utf8 = (flags & 0x100) !== 0;
  const base = pos + stringsStart;
  const limit = pos + size;
  for (let i = 0; i < count; i++) {
    const offset = buffer.readUInt32LE(pos + headerSize + i * 4);
    let at = base + offset;
    const unit = decodeLength(buffer, at);
    at = unit.next;
    if (utf8) {
      const bytes = decodeLength(buffer, at);
      at = bytes.next;
      if (at + bytes.length > limit) throw new Error('AXML 字符串越界。');
      strings.push(buffer.subarray(at, at + bytes.length).toString('utf8'));
    } else {
      if (at + unit.length * 2 > limit) throw new Error('AXML 字符串越界。');
      strings.push(buffer.subarray(at, at + unit.length * 2).toString('utf16le'));
    }
  }
}

const text = (strings, index) => (index === NO_INDEX || index < 0 || index >= strings.length ? null : strings[index]);

function typedValue(strings, dataType, data) {
  if (dataType === 0x03) return text(strings, data);
  if (dataType === 0x10) return data | 0;
  if (dataType === 0x11) return `0x${(data >>> 0).toString(16)}`;
  if (dataType === 0x12) return data !== 0;
  if (dataType === 0x01) return `@0x${(data >>> 0).toString(16)}`;
  return null;
}

function attributesOf(buffer, pos, headerSize, strings) {
  const attributeStart = buffer.readUInt16LE(pos + 24);
  const attributeSize = buffer.readUInt16LE(pos + 26);
  const attributeCount = buffer.readUInt16LE(pos + 28);
  const base = pos + headerSize + attributeStart;
  const out = [];
  for (let i = 0; i < attributeCount; i++) {
    const at = base + i * attributeSize;
    if (at + 20 > buffer.length) throw new Error('AXML 属性越界。');
    const name = text(strings, buffer.readUInt32LE(at + 4));
    const rawIndex = buffer.readUInt32LE(at + 8);
    const dataType = buffer[at + 15];
    const data = buffer.readUInt32LE(at + 16);
    const value = rawIndex !== NO_INDEX ? text(strings, rawIndex) : typedValue(strings, dataType, data);
    if (name) out.push({ name, value });
  }
  return out;
}

export function parseManifest(buffer, signal) {
  const strings = [];
  const roots = [];
  const stack = [];
  let pos = 0;
  let elements = 0;
  while (pos + 8 <= buffer.length) {
    signal?.throwIfAborted();
    const type = buffer.readUInt16LE(pos);
    const headerSize = buffer.readUInt16LE(pos + 2);
    const size = buffer.readUInt32LE(pos + 4);
    if (size < 8 || pos + size > buffer.length || headerSize < 8) throw new Error('AXML 区块无效。');
    if (type === AX_XML) {
      if (headerSize < 8) throw new Error('AXML 头部无效。');
    } else if (type === AX_STRING_POOL) {
      stringPool(buffer, pos, headerSize, size, strings);
    } else if (type === AX_START) {
      elements += 1;
      if (elements > MAX_ELEMENTS || stack.length >= MAX_DEPTH) throw new Error('AXML 元素数量或深度超出上限。');
      const node = { name: text(strings, buffer.readUInt32LE(pos + 20)), attributes: attributesOf(buffer, pos, headerSize, strings), children: [] };
      stack.push(node);
    } else if (type === AX_END) {
      const node = stack.pop();
      if (node) (stack.length ? stack.at(-1).children : roots).push(node);
    }
    pos += type === AX_XML ? headerSize : size;
  }
  return roots;
}

const attr = (node, name) => node.attributes.find(item => item.name === name)?.value ?? null;
const asInt = value => (typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : null);

function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

export function manifestFacts(buffer, signal) {
  const roots = parseManifest(buffer, signal);
  const manifest = roots.find(node => node.name === 'manifest');
  if (!manifest) return null;
  const facts = { package: attr(manifest, 'package'), versionCode: asInt(attr(manifest, 'versionCode')), versionName: attr(manifest, 'versionName'), minSdk: null, targetSdk: null, label: null, permissions: [], activities: [], launcherActivity: null, activityAliases: 0 };
  const filters = [];
  walk(manifest, node => {
    if (node.name === 'uses-sdk') {
      facts.minSdk = asInt(attr(node, 'minSdkVersion')) ?? attr(node, 'minSdkVersion');
      facts.targetSdk = asInt(attr(node, 'targetSdkVersion')) ?? attr(node, 'targetSdkVersion');
    } else if (node.name === 'uses-permission') {
      const name = attr(node, 'name');
      if (typeof name === 'string' && facts.permissions.length < 500) facts.permissions.push(name);
    } else if (node.name === 'application') {
      const label = attr(node, 'label');
      if (label !== null) facts.label = label;
    } else if (node.name === 'activity' || node.name === 'activity-alias') {
      const name = attr(node, 'name');
      if (typeof name === 'string') {
        facts.activities.push(name);
        const main = node.children.some(child => child.name === 'intent-filter' && child.children.some(grand => grand.name === 'action' && attr(grand, 'name') === 'android.intent.action.MAIN') && child.children.some(grand => grand.name === 'category' && attr(grand, 'name') === 'android.intent.category.LAUNCHER'));
        if (main) filters.push(name);
        if (node.name === 'activity-alias') facts.activityAliases += 1;
      }
    }
  });
  facts.launcherActivity = filters[0] ?? null;
  facts.permissions = [...new Set(facts.permissions)].sort();
  facts.activities = [...new Set(facts.activities)].sort();
  return facts;
}
