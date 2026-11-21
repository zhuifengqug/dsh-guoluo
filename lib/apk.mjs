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
const MAX_ATTRIBUTES = 200000;
const MANIFEST_PAGE = 64;
const MANIFEST_PAGE_MAX = 500;

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
    const rawName = buffer.subarray(pos + 46, nameEnd);
    const name = rawName.toString((flags & 0x800) !== 0 ? 'utf8' : 'latin1');
    if (compressed === 0xffffffff || uncompressed === 0xffffffff || localOffset === 0xffffffff) throw new Error('ZIP64 条目暂不支持。');
    entries.push({ name, rawName, flags, method, compressed, uncompressed, localOffset });
    pos = nameEnd + extraLength + commentLength;
  }
  if (entries.length !== totalEntries) throw new Error('ZIP 中央目录条目数与记录不符。');
  return entries;
}

export async function readEntry(fd, entry, maxBytes, signal, fileSize) {
  if (!Number.isSafeInteger(fileSize) || fileSize < 30) throw new Error('ZIP 文件过短。');
  if (!Number.isSafeInteger(entry.localOffset) || entry.localOffset < 0 || entry.localOffset + 30 > fileSize) throw new Error('ZIP 本地头越界。');
  const header = await readAt(fd, entry.localOffset, 30, signal);
  if (header.readUInt32LE(0) !== LOCAL) throw new Error('ZIP 本地头无效。');
  const flags = header.readUInt16LE(6);
  const method = header.readUInt16LE(8);
  const compressed = header.readUInt32LE(18);
  const nameLength = header.readUInt16LE(26);
  const extraLength = header.readUInt16LE(28);
  const nameStart = entry.localOffset + 30;
  const start = nameStart + nameLength + extraLength;
  // 本地头与中央目录必须自洽：名字、压缩方式、压缩后大小三项任一不符都拒绝读取。
  const centralName = entry.rawName ?? Buffer.from(entry.name ?? '', (entry.flags ?? flags) & 0x800 ? 'utf8' : 'latin1');
  if (start > fileSize) throw new Error('ZIP 本地头越界。');
  const rawName = nameLength ? await readAt(fd, nameStart, nameLength, signal) : Buffer.alloc(0);
  if (rawName.length !== centralName.length || !rawName.equals(centralName)) throw new Error('ZIP 本地头文件名与中央目录不符。');
  if (method !== entry.method) throw new Error('ZIP 本地头压缩方式与中央目录不符。');
  const descriptor = (flags & 0x08) !== 0;
  if (compressed !== entry.compressed && !(descriptor && compressed === 0)) throw new Error('ZIP 本地头压缩后大小与中央目录不符。');
  if ((flags & 0x01) !== 0 || ((entry.flags ?? 0) & 0x01) !== 0) throw new Error('ZIP 加密条目暂不支持。');
  if (start > fileSize || start + entry.compressed > fileSize) throw new Error('ZIP 条目数据越界。');
  if (entry.uncompressed > maxBytes || entry.compressed > maxBytes) throw new Error('ZIP 条目超出上限。');
  // 存储方式下压缩后大小与解压后大小必须相等，否则中央目录自相矛盾。
  if (entry.method === 0 && entry.compressed !== entry.uncompressed) throw new Error('ZIP 存储条目压缩后大小与解压后大小不符。');
  const raw = entry.compressed ? await readAt(fd, start, entry.compressed, signal) : Buffer.alloc(0);
  if (descriptor) await checkDescriptor(fd, start + entry.compressed, entry, signal, fileSize);
  if (entry.method === 0) {
    if (raw.length > maxBytes) throw new Error('ZIP 条目超出上限。');
    if (raw.length !== entry.uncompressed) throw new Error('ZIP 条目解压后长度与中央目录不符。');
    return raw;
  }
  if (entry.method === 8) {
    let data;
    try { data = inflateRawSync(raw, { maxOutputLength: Math.max(maxBytes, 1) }); }
    catch { throw new Error('ZIP 条目解压失败或超出上限。'); }
    // 解压结果长度必须等于中央目录记录的解压后大小，多一字节或少一字节都算证据不可信。
    if (data.length !== entry.uncompressed) throw new Error('ZIP 条目解压后长度与中央目录不符。');
    return data;
  }
  throw new Error(`ZIP 压缩方式 ${entry.method} 暂不支持。`);
}

// 数据描述符按规范可带签名也可不带（PKWARE APPNOTE 4.3.9.3）：带签名时校验其记录的大小，
// 不带签名时不猜布局——那属于合法写法，不是损坏。
async function checkDescriptor(fd, at, entry, signal, fileSize) {
  if (at + 4 > fileSize) return;
  const head = await readAt(fd, at, 4, signal);
  if (head.readUInt32LE(0) !== 0x08074b50) return;
  if (at + 16 > fileSize) throw new Error('ZIP 数据描述符不完整。');
  const tail = await readAt(fd, at + 4, 12, signal);
  if (tail.readUInt32LE(4) !== entry.compressed || tail.readUInt32LE(8) !== entry.uncompressed) throw new Error('ZIP 数据描述符与中央目录不符。');
}

function decodeLength(buffer, at) {
  const first = buffer[at];
  if (first === undefined) throw new Error('AXML 字符串长度越界。');
  if (first & 0x80) {
    const second = buffer[at + 1];
    if (second === undefined) throw new Error('AXML 字符串长度越界。');
    return { length: ((first & 0x7f) << 8) | second, next: at + 2 };
  }
  return { length: first, next: at + 1 };
}

// UTF-16 字符串池的长度前缀是一个或两个 16 位字：最高位置 1 时低位是长度的高字。
function decodeUtf16Length(buffer, at) {
  if (at + 2 > buffer.length) throw new Error('AXML 字符串长度越界。');
  const first = buffer.readUInt16LE(at);
  if (first & 0x8000) {
    if (at + 4 > buffer.length) throw new Error('AXML 字符串长度越界。');
    return { length: ((first & 0x7fff) << 16) | buffer.readUInt16LE(at + 2), next: at + 4 };
  }
  return { length: first, next: at + 2 };
}

function stringPool(buffer, pos, headerSize, size, strings, budget) {
  // 头部长度与块长度都要先过一遍：否则下面的固定字段读会跨到下一块去取垃圾。
  if (headerSize < 28 || size < 28) throw new Error('AXML 字符串池头部无效。');
  const count = buffer.readUInt32LE(pos + 8);
  const flags = buffer.readUInt32LE(pos + 16);
  const stringsStart = buffer.readUInt32LE(pos + 20);
  if (count > MAX_STRINGS) throw new Error('AXML 字符串数量超出上限。');
  if (stringsStart < headerSize || stringsStart > size) throw new Error('AXML 字符串池头部无效。');
  if (pos + headerSize + count * 4 > pos + size) throw new Error('AXML 字符串偏移表越界。');
  const utf8 = (flags & 0x100) !== 0;
  const base = pos + stringsStart;
  const limit = pos + size;
  for (let i = 0; i < count; i++) {
    const offset = buffer.readUInt32LE(pos + headerSize + i * 4);
    let at = base + offset;
    if (at < base || at >= limit) throw new Error('AXML 字符串偏移越界。');
    if (utf8) {
      const chars = decodeLength(buffer, at);
      at = chars.next;
      const bytes = decodeLength(buffer, at);
      at = bytes.next;
      if (at + bytes.length > limit) throw new Error('AXML 字符串越界。');
      budget.used += bytes.length;
      if (budget.used > budget.limit) throw new Error('AXML 字符串解码超出预算。');
      strings.push(buffer.subarray(at, at + bytes.length).toString('utf8'));
    } else {
      const chars = decodeUtf16Length(buffer, at);
      at = chars.next;
      const byteLength = chars.length * 2;
      if (at + byteLength > limit) throw new Error('AXML 字符串越界。');
      budget.used += byteLength;
      if (budget.used > budget.limit) throw new Error('AXML 字符串解码超出预算。');
      strings.push(buffer.subarray(at, at + byteLength).toString('utf16le'));
    }
  }
}

const text = (strings, index) => (index === NO_INDEX || index < 0 || index >= strings.length ? null : strings[index]);

function typedValue(strings, dataType, data) {
  if (dataType === 0x03) return text(strings, data);
  if (dataType === 0x10) return data | 0;
  if (dataType === 0x11) return data >>> 0;
  if (dataType === 0x12) return data !== 0;
  if (dataType === 0x01) return `@0x${(data >>> 0).toString(16)}`;
  return null;
}

function attributesOf(buffer, pos, headerSize, size, strings) {
  // 元素头 8 字节 + ResXMLTree_attrExt 20 字节，读任何字段前先确认块里真有这么多字节。
  if (headerSize < 16 || size < 36) throw new Error('AXML 元素结构不完整。');
  const attributeStart = buffer.readUInt16LE(pos + 24);
  const attributeSize = buffer.readUInt16LE(pos + 26);
  const attributeCount = buffer.readUInt16LE(pos + 28);
  if (attributeSize < 20) throw new Error('AXML 属性步长无效。');
  const base = pos + headerSize + attributeStart;
  if (base + attributeCount * attributeSize > pos + size) throw new Error('AXML 属性表越界。');
  // 元素声明长度必须恰好覆盖头部、属性起点与声明的属性条数，多一字节或少一字节都视为声明与实际不符。
  const declaredSize = headerSize + attributeStart + attributeCount * attributeSize;
  if (size !== declaredSize) throw new Error('AXML 元素声明长度与属性数量不符。');
  const out = [];
  for (let i = 0; i < attributeCount; i++) {
    const at = base + i * attributeSize;
    if (at + 20 > pos + size) throw new Error('AXML 属性越界。');
    const name = text(strings, buffer.readUInt32LE(at + 4));
    const rawIndex = buffer.readUInt32LE(at + 8);
    const dataType = buffer[at + 15];
    const data = buffer.readUInt32LE(at + 16);
    const value = rawIndex !== NO_INDEX ? text(strings, rawIndex) : typedValue(strings, dataType, data);
    if (name === null) throw new Error('AXML 属性名无法解析。');
    out.push({ name, value });
  }
  return out;
}

export function parseManifest(buffer, signal, options = {}) {
  const attributeBudget = options.maxAttributes ?? MAX_ATTRIBUTES;
  const strings = [];
  const roots = [];
  const stack = [];
  const budget = { used: 0, limit: 8 * 1024 * 1024 };
  let pos = 0;
  let documentEnd = null;
  let elements = 0;
  let attributes = 0;
  let declaredAttributes = 0;
  while (pos + 8 <= (documentEnd ?? buffer.length)) {
    signal?.throwIfAborted();
    const type = buffer.readUInt16LE(pos);
    const headerSize = buffer.readUInt16LE(pos + 2);
    const size = buffer.readUInt32LE(pos + 4);
    if (size < 8 || headerSize < 8 || pos + size > buffer.length) throw new Error('AXML 区块无效。');
    // headerSize 大于本块长度意味着后面每个固定字段读都会落到下一块里，先拒绝。
    if (headerSize > size) throw new Error('AXML 区块头长度超过区块长度。');
    if (documentEnd !== null && pos + size > documentEnd) throw new Error('AXML 区块越过文档声明的总长度。');
    if (type === AX_XML) {
      if (documentEnd !== null) throw new Error('AXML 文档头重复。');
      if (pos !== 0) throw new Error('AXML 文档头不在文件起点。');
      documentEnd = size;
    } else if (type === AX_STRING_POOL) {
      stringPool(buffer, pos, headerSize, size, strings, budget);
    } else if (type === AX_START) {
      if (headerSize < 16 || size < 36) throw new Error('AXML 起始标签结构不完整。');
      elements += 1;
      if (elements > MAX_ELEMENTS || stack.length >= MAX_DEPTH) throw new Error('AXML 元素数量或深度超出上限。');
      // 预算按本块“声明”的属性数扣减：不建一个属性对象就已经能判定超限。
      const declared = buffer.readUInt16LE(pos + 28);
      declaredAttributes += declared;
      if (declaredAttributes > attributeBudget) throw new Error('AXML 属性预算超限。');
      const attributes_ = attributesOf(buffer, pos, headerSize, size, strings);
      if (attributes_.length !== declared) throw new Error('AXML 元素属性数与声明不符。');
      attributes += attributes_.length;
      if (attributes > attributeBudget) throw new Error('AXML 属性数量超出上限。');
      const node = { name: text(strings, buffer.readUInt32LE(pos + 20)), attributes: attributes_, children: [] };
      stack.push(node);
    } else if (type === AX_END) {
      if (headerSize < 16 || size < 24) throw new Error('AXML 结束标签结构不完整。');
      const name = text(strings, buffer.readUInt32LE(pos + 20));
      const node = stack.pop();
      if (!node) throw new Error('AXML 结束标签没有对应的开始标签。');
      if (name && node.name && name !== node.name) throw new Error('AXML 结束标签与开始标签不匹配。');
      (stack.length ? stack.at(-1).children : roots).push(node);
    }
    pos += type === AX_XML ? headerSize : size;
  }
  if (stack.length) throw new Error('AXML 文档未正确闭合。');
  if (documentEnd === null) throw new Error('AXML 缺少文档头。');
  if (attributes !== declaredAttributes) throw new Error('AXML 实际属性数与声明不符。');
  // 声明的总长度必须与实际区块对齐，允许文档尾最多 3 字节零填充。
  const slack = documentEnd - pos;
  if (slack < 0 || slack > 3) throw new Error('AXML 声明总长度与实际区块不符。');
  if (buffer.subarray(pos, documentEnd).some(byte => byte !== 0)) throw new Error('AXML 声明总长度内仍有未解析字节。');
  if (buffer.length > documentEnd && buffer.subarray(documentEnd).some(byte => byte !== 0)) throw new Error('AXML 声明范围之外仍有数据。');
  return roots;
}

const attr = (node, name) => node.attributes.find(item => item.name === name)?.value ?? null;
const asInt = value => (typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : null);

function walk(node, visit) {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

// 清单里的权限与活动一次只给一页：默认 64 条，上限 500 条，其余靠 offset 续页。
function pageOf(list, options, label) {
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? MANIFEST_PAGE;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error(`AXML ${label}分页偏移无效。`);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error(`AXML ${label}分页长度无效。`);
  const size = Math.min(limit, MANIFEST_PAGE_MAX);
  const items = list.slice(offset, offset + size);
  const nextOffset = offset + items.length < list.length ? offset + items.length : null;
  return { items, offset, limit: size, total: list.length, returned: items.length, nextOffset, truncated: nextOffset !== null };
}

export function manifestFacts(buffer, signal, pages = {}) {
  const roots = parseManifest(buffer, signal);
  const manifest = roots.find(node => node.name === 'manifest');
  if (!manifest) return null;
  const permissionSet = new Set();
  const activitySet = new Set();
  const facts = { package: attr(manifest, 'package'), versionCode: asInt(attr(manifest, 'versionCode')), versionName: attr(manifest, 'versionName'), minSdk: null, targetSdk: null, label: null, permissions: [], activities: [], launcherActivity: null, activityAliases: 0 };
  const filters = [];
  walk(manifest, node => {
    if (node.name === 'uses-sdk') {
      facts.minSdk = asInt(attr(node, 'minSdkVersion')) ?? attr(node, 'minSdkVersion');
      facts.targetSdk = asInt(attr(node, 'targetSdkVersion')) ?? attr(node, 'targetSdkVersion');
    } else if (node.name === 'uses-permission') {
      const name = attr(node, 'name');
      if (typeof name === 'string') permissionSet.add(name);
    } else if (node.name === 'application') {
      const label = attr(node, 'label');
      if (label !== null) facts.label = label;
    } else if (node.name === 'activity' || node.name === 'activity-alias') {
      const name = attr(node, 'name');
      if (typeof name === 'string') {
        activitySet.add(name);
        const main = node.children.some(child => child.name === 'intent-filter' && child.children.some(grand => grand.name === 'action' && attr(grand, 'name') === 'android.intent.action.MAIN') && child.children.some(grand => grand.name === 'category' && attr(grand, 'name') === 'android.intent.category.LAUNCHER'));
        if (main) filters.push(name);
        if (node.name === 'activity-alias') facts.activityAliases += 1;
      }
    }
  });
  facts.launcherActivity = filters[0] ?? null;
  const permissionPage = pageOf([...permissionSet].sort(), pages?.permissions, '权限');
  const activityPage = pageOf([...activitySet].sort(), pages?.activities, '活动');
  facts.permissions = permissionPage.items;
  facts.permissionsPage = { offset: permissionPage.offset, limit: permissionPage.limit, total: permissionPage.total, returned: permissionPage.returned, nextOffset: permissionPage.nextOffset, truncated: permissionPage.truncated };
  facts.permissionsTotal = permissionPage.total;
  facts.permissionsTruncated = permissionPage.truncated;
  facts.activities = activityPage.items;
  facts.activitiesPage = { offset: activityPage.offset, limit: activityPage.limit, total: activityPage.total, returned: activityPage.returned, nextOffset: activityPage.nextOffset, truncated: activityPage.truncated };
  facts.activitiesTotal = activityPage.total;
  facts.activitiesTruncated = activityPage.truncated;
  return facts;
}
