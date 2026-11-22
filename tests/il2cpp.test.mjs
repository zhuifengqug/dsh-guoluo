import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { inspectIl2cpp, readIl2cppPage } from '../lib/il2cpp.mjs';
import { projectService } from '../lib/projects.mjs';

const SECTIONS = [
  'stringLiterals', 'stringLiteralData', 'strings', 'events', 'properties', 'methods',
  'parameterDefaultValues', 'fieldDefaultValues', 'fieldAndParameterDefaultValueData',
  'fieldMarshaledSizes', 'parameters', 'fields', 'genericParameters',
  'genericParameterConstraints', 'genericContainers', 'nestedTypes', 'interfaces',
  'vtableMethods', 'interfaceOffsets', 'typeDefinitions', 'images', 'assemblies',
  'metadataUsageLists', 'metadataUsagePairs', 'fieldRefs', 'referencedAssemblies',
  'attributesInfo', 'attributeTypes', 'unresolvedVirtualCallParameterTypes',
  'unresolvedVirtualCallParameterRanges', 'windowsRuntimeTypeNames', 'exportedTypeDefinitions',
];

// 合成一份 v24 元数据：两段名字池、一个类型表、一个字段表，以及一张空的方法表。
function buildMetadata({ version = 24 } = {}) {
  const names = ['', 'Demo.Type', 'Demo', 'value', 'Other.Type', 'count'];
  const strings = Buffer.concat(names.map(name => Buffer.concat([Buffer.from(name, 'utf8'), Buffer.from([0])])));
  const indexOf = name => {
    let at = 0;
    for (const item of names) {
      if (item === name) return at;
      at += Buffer.byteLength(item, 'utf8') + 1;
    }
    throw new Error(`missing ${name}`);
  };

  const types = Buffer.alloc(92 * 2);
  types.writeInt32LE(indexOf('Demo.Type'), 0);
  types.writeInt32LE(indexOf('Demo'), 4);
  types.writeInt32LE(-1, 16);
  types.writeInt32LE(0, 36);
  types.writeInt32LE(0, 40);
  types.writeUInt16LE(3, 68);
  types.writeUInt16LE(1, 72);
  types.writeInt32LE(indexOf('Other.Type'), 92);
  types.writeInt32LE(-1, 92 + 16);
  types.writeInt32LE(1, 92 + 36);
  types.writeInt32LE(3, 92 + 40);
  types.writeUInt16LE(1, 92 + 68);
  types.writeUInt16LE(1, 92 + 72);

  const fields = Buffer.alloc(12 * 2);
  fields.writeInt32LE(indexOf('value'), 0);
  fields.writeInt32LE(5, 4);
  fields.writeUInt32LE(0x04000001, 8);
  fields.writeInt32LE(indexOf('count'), 12);
  fields.writeInt32LE(6, 16);
  fields.writeUInt32LE(0x04000002, 20);

  const methods = Buffer.alloc(32 * 4);
  const images = Buffer.alloc(40);
  images.writeInt32LE(indexOf('Demo'), 0);

  const payloads = new Map([
    ['strings', strings],
    ['methods', methods],
    ['fields', fields],
    ['typeDefinitions', types],
    ['images', images],
  ]);

  let offset = 8 + SECTIONS.length * 8;
  const plan = SECTIONS.map(name => {
    const bytes = payloads.get(name) ?? Buffer.alloc(0);
    const at = offset;
    offset += bytes.length;
    return { name, at, bytes };
  });

  const header = Buffer.alloc(8 + SECTIONS.length * 8);
  header.writeUInt32LE(0xfab11baf, 0);
  header.writeInt32LE(version, 4);
  for (const [index, item] of plan.entries()) {
    header.writeUInt32LE(item.at, 8 + index * 8);
    header.writeUInt32LE(item.bytes.length, 8 + index * 8 + 4);
  }
  return Buffer.concat([header, ...plan.map(item => item.bytes)]);
}

const readText = path => readFile(path, 'utf8');

async function withFixture(bytes, run) {
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-il2cpp-'));
  try {
    const path = join(dir, 'global-metadata.dat');
    await writeFile(path, bytes);
    return await run(path, bytes.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('IL2CPP v24 元数据解析出类型、字段名与计数', async () => {
  await withFixture(buildMetadata(), async (path, size) => {
    const facts = await inspectIl2cpp(path, size);
    assert.equal(facts.status, 'parsed');
    assert.equal(facts.layout, 'verified');
    assert.equal(facts.metadataVersion, 24);
    assert.equal(facts.headerBytes, 264);
    assert.deepEqual(facts.counts, { types: 2, fields: 2, methods: 4, images: 1, stringLiterals: 0 });
    assert.deepEqual(facts.truncated, { types: false, fields: false });
    assert.equal(facts.namesUnavailable, false);
    assert.deepEqual(facts.types.map(type => type.name), ['Demo.Type', 'Other.Type']);
    assert.equal(facts.types[0].namespace, 'Demo');
    assert.equal(facts.types[0].declaringType, -1);
    assert.equal(facts.types[0].fieldCount, 1);
    assert.equal(facts.types[0].methodCount, 3);
    assert.deepEqual(facts.types[0].fields, ['value']);
    assert.deepEqual(facts.types[1].fields, ['count']);
  });
});

test('IL2CPP 分页按 offset 与 limit 读类型和字段，并在末页收起游标', async () => {
  await withFixture(buildMetadata(), async (path, size) => {
    const first = await readIl2cppPage(path, size, { kind: 'il2cpp-types', offset: 0, limit: 1 });
    assert.equal(first.total, 2);
    assert.equal(first.returned, 1);
    assert.equal(first.nextOffset, 1);
    assert.deepEqual(first.rows, [{ kind: 'il2cpp-types', index: 0, name: 'Demo.Type', namespace: 'Demo', declaringType: -1, fieldCount: 1, methodCount: 3 }]);

    const last = await readIl2cppPage(path, size, { kind: 'il2cpp-types', offset: 1, limit: 5 });
    assert.equal(last.returned, 1);
    assert.equal(last.nextOffset, null);

    const fields = await readIl2cppPage(path, size, { kind: 'il2cpp-fields', offset: 0, limit: 2 });
    assert.equal(fields.total, 2);
    assert.equal(fields.nextOffset, null);
    assert.deepEqual(fields.rows, [
      { kind: 'il2cpp-fields', index: 0, name: 'value', typeIndex: 5, declaringType: 0, token: 0x04000001 },
      { kind: 'il2cpp-fields', index: 1, name: 'count', typeIndex: 6, declaringType: 1, token: 0x04000002 },
    ]);

    const past = await readIl2cppPage(path, size, { kind: 'il2cpp-fields', offset: 5, limit: 2 });
    assert.equal(past.returned, 0);
    assert.equal(past.nextOffset, null);
  });
});

test('IL2CPP 未核对版本只报头，坏标识与越界区段明确拒绝', async () => {
  await withFixture(buildMetadata({ version: 25 }), async (path, size) => {
    const facts = await inspectIl2cpp(path, size);
    assert.equal(facts.status, 'unverified');
    assert.equal(facts.layout, 'unverified');
    assert.equal(facts.metadataVersion, 25);
    assert.match(facts.reason, /未核对/u);
    await assert.rejects(readIl2cppPage(path, size, { kind: 'il2cpp-types', offset: 0, limit: 1 }), /未核对/u);
  });

  const bad = buildMetadata();
  bad.writeUInt32LE(0x12345678, 0);
  await withFixture(bad, async (path, size) => {
    await assert.rejects(inspectIl2cpp(path, size), /头标识/u);
  });

  const over = buildMetadata();
  over.writeUInt32LE(Math.max(1, over.length), 8 + 8 * SECTIONS.indexOf('typeDefinitions'));
  await withFixture(over, async (path, size) => {
    await assert.rejects(inspectIl2cpp(path, size), /越界|读取不完整/u);
  });
});

test('IL2CPP 类型与字段可经 dossier 分页取回，并进入规格证据', async () => {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-il2cpp-run-'));
  try {
    const sourceRoot = join(root, 'source');
    const archiveRoot = join(root, 'archive');
    await mkdir(join(sourceRoot, 'build'), { recursive: true });
    await mkdir(archiveRoot);
    await writeFile(join(sourceRoot, 'build', 'global-metadata.dat'), buildMetadata());

    const service = projectService({ sourceRoot, archiveRoot });
    const { id } = await service.add({ kind: 'local', location: 'build' });
    const run = await service.dissect({ id, rea: false });

    assert.equal(run.rea.status, 'off');
    const binary = await service.dossier({ id, runId: run.runId, kind: 'binary' });
    const entry = binary.rows.find(row => row.path === 'global-metadata.dat');
    assert.equal(entry.status, 'parsed');
    assert.equal(entry.layout, 'verified');
    assert.equal(entry.counts.types, 2);

    const types = await service.dossier({ id, runId: run.runId, kind: 'il2cpp-types', limit: 1 });
    assert.equal(types.total, 2);
    assert.equal(types.nextOffset, 1);
    assert.equal(types.rows[0].name, 'Demo.Type');
    assert.equal(types.rows[0].namespace, 'Demo');
    assert.equal(types.source, 'current-file');

    const fields = await service.dossier({ id, runId: run.runId, kind: 'il2cpp-fields', path: 'global-metadata.dat' });
    assert.deepEqual(fields.rows.map(row => [row.name, row.declaringType]), [['value', 0], ['count', 1]]);
    assert.equal(fields.nextOffset, null);

    const spec = await service.spec({ id, runId: run.runId });
    const markdown = await readText(spec.files.markdown);
    assert.match(markdown, /IL2CPP 24 \/ 类型 2 \/ 字段 2 \/ 方法 4 \/ 程序集 1/u);
    const json = JSON.parse(await readText(spec.files.json));
    const unity = json.evidence.unity.find(file => file.path === 'global-metadata.dat');
    assert.equal(unity.layout, 'verified');
    assert.equal(unity.counts.types, 2);
    assert.ok(json.unknowns.some(text => text.includes('LZHAM 压缩与 UnityFS 格式版本 9')));

    await assert.rejects(service.dossier({ id, runId: run.runId, kind: 'il2cpp-types', path: 'other.dat' }), /没有登记该 IL2CPP/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// 真实样本只在显式给出路径时跑：它不是本仓库的夹具，不能进默认回归。
const sample = process.env.GUOLUO_TEST_IL2CPP;

test('真实 IL2CPP 元数据样本与 REA 的计数一致', { skip: !sample && 'GUOLUO_TEST_IL2CPP 未设置' }, async () => {
  const size = (await stat(sample)).size;
  const facts = await inspectIl2cpp(sample, size);
  assert.equal(facts.status, 'parsed');
  assert.equal(facts.metadataVersion, 24);
  assert.deepEqual(facts.counts, { types: 2664, fields: 10817, methods: 16567, images: 24, stringLiterals: 4065 });
  assert.deepEqual(facts.types.slice(0, 3).map(type => type.name), ['<Module>', '<>f__AnonymousType0`1', 'Locale']);
  assert.equal(facts.types[1].methodCount, 4);

  const fields = await readIl2cppPage(sample, size, { kind: 'il2cpp-fields', offset: 0, limit: 3 });
  assert.deepEqual(fields.rows.map(row => [row.name, row.declaringType]), [['<message>i__Field', 1], ['value', 5], ['value', 6]]);
});