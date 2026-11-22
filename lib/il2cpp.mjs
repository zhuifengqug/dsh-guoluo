import { open } from 'node:fs/promises';

// Il2CppGlobalMetadataHeader 的区段顺序由 Unity 运行时版本固定；每段是一对 (offset, size)。
// 这里只声明顺序与已用真实样本核对过的版本参数；未核对版本一律只报头，不猜布局。
const sections = [
  'stringLiterals', 'stringLiteralData', 'strings', 'events', 'properties', 'methods',
  'parameterDefaultValues', 'fieldDefaultValues', 'fieldAndParameterDefaultValueData',
  'fieldMarshaledSizes', 'parameters', 'fields', 'genericParameters',
  'genericParameterConstraints', 'genericContainers', 'nestedTypes', 'interfaces',
  'vtableMethods', 'interfaceOffsets', 'typeDefinitions', 'images', 'assemblies',
  'metadataUsageLists', 'metadataUsagePairs', 'fieldRefs', 'referencedAssemblies',
  'attributesInfo', 'attributeTypes', 'unresolvedVirtualCallParameterTypes',
  'unresolvedVirtualCallParameterRanges', 'windowsRuntimeTypeNames', 'exportedTypeDefinitions',
];

const MAGIC = 0xfab11baf;

// 只在真实样本上逐项对上独立实现之后才登记的版本。
// 24.x：typeDefinition 92 字节、field 12 字节、method 32 字节、image 40 字节、stringLiteral 8 字节。
const layouts = new Map([
  [24, { type: 92, field: 12, method: 32, image: 40, literal: 8, typeWidth: 4 }],
]);

const limits = {
  stringsBytes: 16 * 1024 * 1024,
  tableBytes: 32 * 1024 * 1024,
  maxTypes: 40000,
  previewTypes: 24,
  previewFields: 8,
  nameBytes: 512,
};

const decoder = new TextDecoder('utf-8', { fatal: false, ignoreBOM: true });

async function readAt(handle, offset, length, signal) {
  const buffer = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    signal?.throwIfAborted();
    const { bytesRead } = await handle.read(buffer, done, length - done, offset + done);
    if (!bytesRead) throw new Error('IL2CPP 元数据读取不完整。');
    done += bytesRead;
  }
  return buffer;
}

function headerFacts(buffer, fileSize) {
  if (buffer.length < 8) throw new Error('IL2CPP 元数据头不完整。');
  if (buffer.readUInt32LE(0) !== MAGIC) throw new Error('IL2CPP 元数据头标识无效或不完整。');
  const metadataVersion = buffer.readInt32LE(4);
  if (metadataVersion <= 0) throw new Error('IL2CPP 元数据声明的版本无效。');
  const headerBytes = 8 + sections.length * 8;
  if (fileSize < headerBytes) {
    throw new Error(`IL2CPP 元数据文件短于 ${sections.length} 段的头长 ${headerBytes} 字节。`);
  }
  return { metadataVersion, headerBytes };
}

function sectionTable(buffer, fileSize) {
  const table = new Map();
  sections.forEach((name, index) => {
    const at = 8 + index * 8;
    const offset = buffer.readUInt32LE(at);
    const size = buffer.readUInt32LE(at + 4);
    if (offset + size > fileSize) {
      throw new Error(`IL2CPP 区段 ${name} 越界（偏移 ${offset}、长度 ${size}，文件 ${fileSize} 字节）。`);
    }
    table.set(name, { offset, size });
  });
  return table;
}

function makeStrings(bytes) {
  return index => {
    if (!Number.isInteger(index) || index < 0 || index >= bytes.length) return null;
    let end = index;
    while (end < bytes.length && bytes[end] !== 0) end += 1;
    if (end === bytes.length) return null;
    const text = decoder.decode(bytes.subarray(index, end));
    return text.length > limits.nameBytes ? text.slice(0, limits.nameBytes) : text;
  };
}

// typeDefinition 布局（v24）：名字、命名空间、byval/byref/declaring/parent/element/genericContainer
// 八个 int32，然后 flags、fieldStart、methodStart、eventStart、propertyStart、nestedTypesStart、
// interfacesStart、vtableStart、interfaceOffsetsStart，再八个 u16 计数，最后 bitfield 与 token。
function decodeTypes(bytes, layout, nameOf, max) {
  const count = Math.floor(bytes.length / layout.type);
  const total = bytes.length % layout.type === 0 ? count : null;
  const take = Math.min(count, max);
  const rows = [];
  for (let index = 0; index < take; index += 1) {
    const at = index * layout.type;
    rows.push({
      index,
      name: nameOf ? nameOf(bytes.readInt32LE(at)) : null,
      namespace: nameOf ? nameOf(bytes.readInt32LE(at + 4)) : null,
      declaringType: bytes.readInt32LE(at + 16),
      fieldStart: bytes.readInt32LE(at + 36),
      methodStart: bytes.readInt32LE(at + 40),
      methodCount: bytes.readUInt16LE(at + 68),
      propertyCount: bytes.readUInt16LE(at + 70),
      fieldCount: bytes.readUInt16LE(at + 72),
      eventCount: bytes.readUInt16LE(at + 74),
      nestedTypeCount: bytes.readUInt16LE(at + 76),
    });
  }
  return { rows, total, truncated: count > take };
}

function decodeFields(bytes, layout, nameOf, max) {
  const count = Math.floor(bytes.length / layout.field);
  const total = bytes.length % layout.field === 0 ? count : null;
  const take = Math.min(count, max);
  const rows = [];
  for (let index = 0; index < take; index += 1) {
    const at = index * layout.field;
    rows.push({
      index,
      name: nameOf ? nameOf(bytes.readInt32LE(at)) : null,
      typeIndex: bytes.readInt32LE(at + 4),
      token: bytes.readUInt32LE(at + 8),
    });
  }
  return { rows, total, truncated: count > take };
}

// 字段在本文件中按声明类型连续存放：用 type.fieldStart 直接切片，避免 O(类型数 × 字段数) 扫描。
function fieldsOf(types, fields) {
  const byType = new Map();
  for (const type of types.rows) {
    if (type.fieldCount <= 0) continue;
    const start = type.fieldStart;
    if (!Number.isInteger(start) || start < 0 || start >= fields.rows.length) continue;
    const names = [];
    for (let index = start; index < start + type.fieldCount && index < fields.rows.length; index += 1) {
      const name = fields.rows[index].name;
      if (name !== null && names.length < limits.previewFields) names.push(name);
    }
    byType.set(type.index, names);
  }
  return byType;
}

// 反向：给定字段下标，找把它算作成员的声明类型。
function declaringTypeOf(types) {
  const ranges = [];
  for (const type of types.rows) {
    if (type.fieldCount > 0 && Number.isInteger(type.fieldStart) && type.fieldStart >= 0) {
      ranges.push({ start: type.fieldStart, end: type.fieldStart + type.fieldCount, index: type.index });
    }
  }
  ranges.sort((left, right) => left.start - right.start);
  return fieldIndex => {
    let low = 0;
    let high = ranges.length - 1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const range = ranges[mid];
      if (fieldIndex < range.start) high = mid - 1;
      else if (fieldIndex >= range.end) low = mid + 1;
      else return range.index;
    }
    return null;
  };
}

async function load(handle, size, signal) {
  const head = await readAt(handle, 0, Math.min(size, 8 + sections.length * 8), signal);
  const facts = headerFacts(head, size);
  const layout = layouts.get(facts.metadataVersion);
  return { head, ...facts, layout, table: layout ? sectionTable(head, size) : null };
}

async function sectionBytes(handle, table, name, signal) {
  const section = table.get(name);
  if (!section) return null;
  if (section.size > limits.tableBytes) return null;
  if (!section.size) return Buffer.alloc(0);
  return readAt(handle, section.offset, section.size, signal);
}

async function names(handle, table, signal) {
  const section = table.get('strings');
  if (!section || !section.size || section.size > limits.stringsBytes) return null;
  return makeStrings(await readAt(handle, section.offset, section.size, signal));
}

export async function inspectIl2cpp(path, size, signal, options = {}) {
  const handle = await open(path, 'r');
  try {
    const initial = await handle.stat();
    if (!initial.isFile() || initial.size !== size) throw new Error('IL2CPP 元数据文件大小无效或已改变。');
    const loaded = await load(handle, size, signal);
    const { metadataVersion, headerBytes, layout, table } = loaded;
    if (!layout) {
      // 未核对版本只回报声明值：不按已知布局去切区段表，避免把错位的字节当成字段名。
      return {
        format: 'il2cpp-metadata', metadataVersion, headerBytes, layout: 'unverified', status: 'unverified',
        declaredHeaderBytes: loaded.head.length >= 12 ? loaded.head.readUInt32LE(8) : null,
        reason: `IL2CPP 元数据版本 ${metadataVersion} 的类型与字段表布局尚未核对，只读取了头部。`,
      };
    }
    const nameOf = await names(handle, table, signal);
    const typeBytes = await sectionBytes(handle, table, 'typeDefinitions', signal);
    const fieldBytes = await sectionBytes(handle, table, 'fields', signal);
    if (!typeBytes || !fieldBytes) throw new Error('IL2CPP 类型或字段区段超出读取预算。');
    const types = decodeTypes(typeBytes, layout, nameOf, options.maxTypes ?? limits.maxTypes);
    const fields = decodeFields(fieldBytes, layout, nameOf, Number.MAX_SAFE_INTEGER);
    const byType = fieldsOf(types, fields);
    const final = await handle.stat();
    signal?.throwIfAborted();
    if (final.size !== size || final.mtimeMs !== initial.mtimeMs || final.ctimeMs !== initial.ctimeMs) {
      throw new Error('IL2CPP 元数据在读取期间已改变。');
    }
    return {
      format: 'il2cpp-metadata',
      metadataVersion,
      headerBytes,
      layout: 'verified',
      status: 'parsed',
      indexWidth: layout.typeWidth,
      counts: {
        types: types.total,
        fields: fields.total,
        methods: Math.floor(table.get('methods').size / layout.method),
        images: Math.floor(table.get('images').size / layout.image),
        stringLiterals: Math.floor(table.get('stringLiterals').size / layout.literal),
      },
      truncated: { types: types.truncated, fields: fields.truncated },
      namesUnavailable: nameOf === null,
      types: types.rows.filter(type => type.name !== null).slice(0, options.previewTypes ?? limits.previewTypes).map(type => ({
        index: type.index, name: type.name, namespace: type.namespace,
        declaringType: type.declaringType, fieldCount: type.fieldCount, methodCount: type.methodCount,
        fields: byType.get(type.index) ?? [],
      })),
      detail: '类型与字段名来自未加密的元数据表；方法体、字段类型与运行时行为未观测。用 guoluo_dossier kind=il2cpp-types / kind=il2cpp-fields 分页读全量。',
    };
  } finally {
    await handle.close();
  }
}

export async function readIl2cppPage(path, size, { kind, offset, limit, signal }) {
  const handle = await open(path, 'r');
  try {
    const loaded = await load(handle, size, signal);
    const { metadataVersion, layout, table } = loaded;
    if (!layout) throw new Error(`IL2CPP 元数据版本 ${metadataVersion} 的字段表布局未核对。`);
    const nameOf = await names(handle, table, signal);
    if (kind === 'il2cpp-types') {
      const bytes = await sectionBytes(handle, table, 'typeDefinitions', signal);
      if (!bytes) throw new Error('IL2CPP 类型区段超出读取预算。');
      const types = decodeTypes(bytes, layout, nameOf, limits.maxTypes);
      const total = types.total ?? types.rows.length;
      const rows = types.rows.slice(offset, offset + limit).map(type => ({
        kind, index: type.index, name: type.name, namespace: type.namespace,
        declaringType: type.declaringType, fieldCount: type.fieldCount, methodCount: type.methodCount,
      }));
      const consumed = offset + rows.length;
      return {
        kind, offset, limit, metadataVersion, total, returned: rows.length,
        nextOffset: rows.length && consumed < total ? consumed : null, rows,
        incomplete: types.truncated,
        note: types.truncated ? '类型表超过单次读取预算；翻页结束不代表读完整张表。' : null,
      };
    }
    if (kind === 'il2cpp-fields') {
      const bytes = await sectionBytes(handle, table, 'fields', signal);
      if (!bytes) throw new Error('IL2CPP 字段区段超出读取预算。');
      const typeBytes = await sectionBytes(handle, table, 'typeDefinitions', signal);
      if (!typeBytes) throw new Error('IL2CPP 类型区段超出读取预算。');
      const typeRows = decodeTypes(typeBytes, layout, null, limits.maxTypes);
      const declaring = declaringTypeOf(typeRows);
      const fields = decodeFields(bytes, layout, nameOf, Number.MAX_SAFE_INTEGER);
      const total = fields.total ?? fields.rows.length;
      const rows = fields.rows.slice(offset, offset + limit).map(field => ({
        kind, index: field.index, name: field.name, typeIndex: field.typeIndex,
        declaringType: declaring(field.index), token: field.token,
      }));
      const consumed = offset + rows.length;
      return {
        kind, offset, limit, metadataVersion, total, returned: rows.length,
        nextOffset: rows.length && consumed < total ? consumed : null, rows,
      };
    }
    throw new Error(`未知的 IL2CPP 分页类别：${kind}。`);
  } finally {
    await handle.close();
  }
}

export const il2cppSections = sections;
export const il2cppLayouts = [...layouts.keys()];
