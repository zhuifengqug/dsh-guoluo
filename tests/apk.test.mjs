import assert from 'node:assert/strict';
import { mkdtemp, mkdir, open, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import { Config } from '../index.js';
import { manifestFacts, parseManifest, readEntry, readZip } from '../lib/apk.mjs';
import { projectService } from '../lib/projects.mjs';

function utf16Pool(strings) {
  const parts = [];
  const offsets = [];
  let cursor = 0;
  for (const value of strings) {
    offsets.push(cursor);
    const chars = Buffer.from(value, 'utf16le');
    const units = chars.length / 2;
    const length = Buffer.alloc(2);
    if (units < 0x8000) length.writeUInt16LE(units, 0);
    else { length.writeUInt16LE(0x8000 | (units >>> 16), 0); /* 双字形式在本测试中用不到 */ }
    parts.push(length, chars, Buffer.from([0, 0]));
    cursor += length.length + chars.length + 2;
  }
  const data = Buffer.concat(parts);
  const headerSize = 28;
  const stringsStart = headerSize + offsets.length * 4;
  const padded = (stringsStart + data.length + 3) & ~3;
  const buffer = Buffer.alloc(padded);
  buffer.writeUInt16LE(0x0001, 0);
  buffer.writeUInt16LE(28, 2);
  buffer.writeUInt32LE(padded, 4);
  buffer.writeUInt32LE(strings.length, 8);
  buffer.writeUInt32LE(0, 12);
  buffer.writeUInt32LE(0, 16);
  buffer.writeUInt32LE(stringsStart, 20);
  buffer.writeUInt32LE(0, 24);
  offsets.forEach((offset, index) => buffer.writeUInt32LE(offset, 28 + index * 4));
  data.copy(buffer, stringsStart);
  return buffer;
}

// UTF-8 池：每条字符串是「字符数（变长）、字节数（变长）、UTF-8 字节、0」。两段长度都走 1/2 字节前缀。
function utf8Pool(strings) {
  const parts = [];
  const offsets = [];
  let cursor = 0;
  for (const value of strings) {
    offsets.push(cursor);
    const bytes = Buffer.from(value, 'utf8');
    const units = Buffer.from(value, 'utf16le').length / 2;
    const encode = size => (size < 0x80 ? Buffer.from([size]) : Buffer.from([0x80 | (size >>> 8), size & 0xff]));
    const lengths = Buffer.concat([encode(units), encode(bytes.length)]);
    parts.push(lengths, bytes, Buffer.from([0]));
    cursor += lengths.length + bytes.length + 1;
  }
  const data = Buffer.concat(parts);
  const headerSize = 28;
  const stringsStart = headerSize + offsets.length * 4;
  const padded = (stringsStart + data.length + 3) & ~3;
  const buffer = Buffer.alloc(padded);
  buffer.writeUInt16LE(0x0001, 0);
  buffer.writeUInt16LE(28, 2);
  buffer.writeUInt32LE(padded, 4);
  buffer.writeUInt32LE(strings.length, 8);
  buffer.writeUInt32LE(0, 12);
  buffer.writeUInt32LE(0x100, 16);
  buffer.writeUInt32LE(stringsStart, 20);
  buffer.writeUInt32LE(0, 24);
  offsets.forEach((offset, index) => buffer.writeUInt32LE(offset, 28 + index * 4));
  data.copy(buffer, stringsStart);
  return buffer;
}

function startElement(nameIndex, attributes) {
  const size = 36 + attributes.length * 20;
  const buffer = Buffer.alloc(size);
  buffer.writeUInt16LE(0x0102, 0);
  buffer.writeUInt16LE(16, 2);
  buffer.writeUInt32LE(size, 4);
  buffer.writeInt32LE(-1, 12);
  buffer.writeInt32LE(-1, 16);
  buffer.writeUInt32LE(nameIndex, 20);
  buffer.writeUInt16LE(20, 24);
  buffer.writeUInt16LE(20, 26);
  buffer.writeUInt16LE(attributes.length, 28);
  attributes.forEach((attribute, index) => {
    const at = 36 + index * 20;
    buffer.writeInt32LE(-1, at);
    buffer.writeUInt32LE(attribute.name, at + 4);
    buffer.writeInt32LE(-1, at + 8);
    buffer.writeUInt16LE(8, at + 12);
    buffer[at + 14] = 0;
    buffer[at + 15] = attribute.type;
    buffer.writeUInt32LE(attribute.data >>> 0, at + 16);
  });
  return buffer;
}

function endElement(nameIndex) {
  const buffer = Buffer.alloc(24);
  buffer.writeUInt16LE(0x0103, 0);
  buffer.writeUInt16LE(16, 2);
  buffer.writeUInt32LE(24, 4);
  buffer.writeInt32LE(-1, 12);
  buffer.writeInt32LE(-1, 16);
  buffer.writeUInt32LE(nameIndex, 20);
  return buffer;
}

const PLAN = [
  ['start', 'manifest', [['package', 'str', 'com.example.demo'], ['versionCode', 'int', 42], ['versionName', 'str', '1.2.3']]],
  ['start', 'uses-sdk', [['minSdkVersion', 'int', 24], ['targetSdkVersion', 'int', 34]]],
  ['end', 'uses-sdk'],
  ['start', 'uses-permission', [['name', 'str', 'android.permission.INTERNET']]],
  ['end', 'uses-permission'],
  ['start', 'application', [['label', 'str', 'Demo App']]],
  ['start', 'activity', [['name', 'str', '.MainActivity'], ['exported', 'boolean', 1]]],
  ['start', 'intent-filter', []],
  ['start', 'action', [['name', 'str', 'android.intent.action.MAIN']]],
  ['end', 'action'],
  ['start', 'category', [['name', 'str', 'android.intent.category.LAUNCHER']]],
  ['end', 'category'],
  ['end', 'intent-filter'],
  ['end', 'activity'],
  ['start', 'activity-alias', [['name', 'str', '.Alias']]],
  ['end', 'activity-alias'],
  ['end', 'application'],
  ['end', 'manifest'],
];

function buildAxml(plan = PLAN, { utf8 = false } = {}) {
  const index = new Map();
  const strings = [];
  const intern = value => {
    if (!index.has(value)) {
      index.set(value, strings.length);
      strings.push(value);
    }
    return index.get(value);
  };
  for (const step of plan) {
    if (step[0] === 'start') {
      intern(step[1]);
      for (const [name, kind, value] of step[2]) {
        intern(name);
        if (kind === 'str') intern(value);
      }
    }
  }
  const chunks = [];
  for (const step of plan) {
    if (step[0] === 'start') {
      const attributes = step[2].map(([name, kind, value]) => (kind === 'str'
        ? { name: intern(name), type: 0x03, data: intern(value) }
        : { name: intern(name), type: kind === 'boolean' ? 0x12 : kind === 'hex' ? 0x11 : 0x10, data: value }));
      chunks.push(startElement(intern(step[1]), attributes));
    } else {
      chunks.push(endElement(intern(step[1])));
    }
  }
  const pool = utf8 ? utf8Pool(strings) : utf16Pool(strings);
  const body = Buffer.concat(chunks);
  const total = (8 + pool.length + body.length + 3) & ~3;
  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(total, 4);
  return Buffer.concat([header, pool, body, Buffer.alloc(total - 8 - pool.length - body.length)]);
}

function buildZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const raw = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    // 中央目录记录的压缩方式决定真实载荷：8 用真实 deflate，其余按存储。
    const centralMethod = entry.method ?? 0;
    const payload = centralMethod === 8 ? deflateRawSync(raw) : raw;
    const centralCompressed = entry.central?.compressed ?? payload.length;
    const centralUncompressed = entry.central?.uncompressed ?? raw.length;
    const centralFlags = entry.central?.flags ?? 0x800;
    // descriptor：本地头的三个大小字段置 0，真实值写在数据之后（可带签名也可不带）。
    const descriptor = entry.descriptor === true;
    const localName = entry.local?.name === undefined ? name : Buffer.from(entry.local.name, 'utf8');
    const localMethod = entry.local?.method ?? centralMethod;
    const localFlags = entry.local?.flags ?? (descriptor ? 0x808 : 0x800);
    const localCompressed = entry.local?.compressed ?? (descriptor ? 0 : payload.length);
    const localUncompressed = entry.local?.uncompressed ?? (descriptor ? 0 : raw.length);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(localFlags, 6);
    local.writeUInt16LE(localMethod, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(localCompressed, 18);
    local.writeUInt32LE(localUncompressed, 22);
    local.writeUInt16LE(localName.length, 26);
    locals.push(local, localName, payload);
    let tailLength = 0;
    if (descriptor) {
      const sizes = entry.descriptorSizes ?? {};
      tailLength = entry.descriptorSignature === false ? 12 : 16;
      const tail = Buffer.alloc(tailLength);
      let at = 0;
      if (tailLength === 16) { tail.writeUInt32LE(0x08074b50, 0); at = 4; }
      tail.writeUInt32LE(0, at);
      tail.writeUInt32LE(sizes.compressed ?? centralCompressed, at + 4);
      tail.writeUInt32LE(sizes.uncompressed ?? centralUncompressed, at + 8);
      locals.push(tail);
    }
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(centralFlags, 8);
    record.writeUInt16LE(centralMethod, 10);
    record.writeUInt32LE(0, 16);
    record.writeUInt32LE(centralCompressed, 20);
    record.writeUInt32LE(centralUncompressed, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += 30 + localName.length + payload.length + tailLength;
  }
  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, eocd]);
}

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-apk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [sourceRoot, archiveRoot] = ['source', 'archive'].map(name => join(root, name));
  await Promise.all([mkdir(sourceRoot), mkdir(archiveRoot)]);
  return { root, sourceRoot, archiveRoot, service: projectService(Config({ sourceRoot, archiveRoot, reaPath: join(root, 'missing.mjs') })) };
}

const demoApk = () => buildZip([
  { name: 'AndroidManifest.xml', data: buildAxml() },
  { name: 'classes.dex', data: Buffer.from([0x64, 0x65, 0x78]) },
  { name: 'classes2.dex', data: Buffer.from([0x64, 0x65, 0x78]) },
  { name: 'resources.arsc', data: Buffer.from([0x02, 0x00]) },
  { name: 'META-INF/CERT.RSA', data: Buffer.from([0x30, 0x82]) },
  { name: 'lib/arm64-v8a/libdemo.so', data: Buffer.from([0x7f, 0x45]) },
  { name: 'res/', data: '' },
  { name: 'res/mipmap/ic_launcher.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
  { name: 'assets/app.css', data: ':root{--x:1}' },
  { name: 'assets/logo.svg', data: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
]);

test('APK 只按中央目录与二进制清单做静态盘点', async t => {
  const { sourceRoot, service } = await setup(t);
  await writeFile(join(sourceRoot, 'app.apk'), demoApk());
  const target = await service.add({ kind: 'local', location: 'app.apk' });
  const run = await service.dissect({ id: target.id });
  assert.equal(run.rea.status, 'skipped');
  const manifest = run.apk.manifest;
  assert.equal(manifest.package, 'com.example.demo');
  assert.equal(manifest.versionCode, 42);
  assert.equal(manifest.versionName, '1.2.3');
  assert.equal(manifest.minSdk, 24);
  assert.equal(manifest.targetSdk, 34);
  assert.equal(manifest.launcherActivity, '.MainActivity');
  assert.deepEqual(manifest.permissions, ['android.permission.INTERNET']);
  assert.deepEqual(manifest.activities, ['.Alias', '.MainActivity']);
  assert.deepEqual(run.apk.abis, ['arm64-v8a']);
  assert.equal(run.apk.counts.dex, 2);
  assert.equal(run.apk.counts.libs, 1);
  assert.equal(run.apk.counts.signatures, 1);
  assert.equal(run.apk.counts.resources, 1);
  assert.equal(run.apk.counts.manifest, 1);
  assert.equal(run.apk.counts.assets, 3);
  const assets = await service.dossier({ id: target.id, kind: 'asset' });
  const launcher = assets.rows.find(row => row.path === 'res/mipmap/ic_launcher.png');
  assert.deepEqual(launcher, { kind: 'asset', path: 'res/mipmap/ic_launcher.png', type: 'image', bytes: 4, archive: 'apk' });
  assert.ok(assets.rows.every(row => row.archive === 'apk'));
  assert.ok(run.notes.some(note => note.includes('未校验签名')));
});

test('APK 清单事实进入复刻规格与缺口', async t => {
  const { sourceRoot, service } = await setup(t);
  await writeFile(join(sourceRoot, 'app.apk'), demoApk());
  const target = await service.add({ kind: 'local', location: 'app.apk' });
  const run = await service.dissect({ id: target.id });
  const spec = await service.spec({ id: target.id, runId: run.runId });
  assert.equal(spec.obligations, 3);
  const { readFile } = await import('node:fs/promises');
  const json = JSON.parse(await readFile(spec.files.json, 'utf8'));
  assert.equal(json.evidence.apk.package, 'com.example.demo');
  assert.equal(json.evidence.apk.launcherActivity, '.MainActivity');
  assert.equal(json.evidence.apk.manifestStatus, 'parsed');
  assert.equal(json.evidence.apk.scanTruncated, false);
  assert.equal(typeof json.evidence.apk.scanned, 'number');
  assert.ok(json.unknowns.some(line => line.includes('APK 只做静态清单解析')));
  const markdown = await readFile(spec.files.markdown, 'utf8');
  assert.match(markdown, /APK 包名 \| com\.example\.demo/u);
  assert.match(markdown, /APK 清单状态 \| parsed/u);
});

test('损坏的 ZIP 被拒绝且不留下批次', async t => {
  const { sourceRoot, service } = await setup(t);
  await writeFile(join(sourceRoot, 'broken.apk'), Buffer.from('not a zip at all, definitely not'));
  const target = await service.add({ kind: 'local', location: 'broken.apk' });
  await assert.rejects(service.dissect({ id: target.id }), /ZIP/u);
  assert.equal((await service.status({ id: target.id })).runCount, 0);
});

test('长字符串按 UTF-16 长度前缀读取，权限先去重再截断，十六进制整数转数值', async t => {
  const { sourceRoot, service } = await setup(t);
  const longName = `v${'长'.repeat(120)}`;
  const plan = [
    ['start', 'manifest', [['package', 'str', 'com.example.long'], ['versionCode', 'hex', 0x2a], ['versionName', 'str', longName]]],
    ['start', 'uses-permission', [['name', 'str', 'android.permission.CAMERA']]],
    ['end', 'uses-permission'],
    ['start', 'uses-permission', [['name', 'str', 'android.permission.CAMERA']]],
    ['end', 'uses-permission'],
    ['start', 'uses-permission', [['name', 'str', 'android.permission.INTERNET']]],
    ['end', 'uses-permission'],
    ['end', 'manifest'],
  ];
  await writeFile(join(sourceRoot, 'long.apk'), buildZip([{ name: 'AndroidManifest.xml', data: buildAxml(plan) }]));
  const target = await service.add({ kind: 'local', location: 'long.apk' });
  const run = await service.dissect({ id: target.id });
  assert.equal(run.apk.manifestStatus, 'parsed');
  assert.equal(run.apk.manifest.versionName, longName);
  assert.equal(run.apk.manifest.versionCode, 0x2a);
  assert.deepEqual(run.apk.manifest.permissions, ['android.permission.CAMERA', 'android.permission.INTERNET']);
  assert.equal(run.apk.manifest.permissionsTotal, 2);
  assert.equal(run.apk.manifest.permissionsTruncated, false);
});

test('缺少清单时 manifestStatus 标为 absent', async t => {
  const { sourceRoot, service } = await setup(t);
  await writeFile(join(sourceRoot, 'nomanifest.apk'), buildZip([{ name: 'classes.dex', data: Buffer.from([0x64]) }]));
  const target = await service.add({ kind: 'local', location: 'nomanifest.apk' });
  const run = await service.dissect({ id: target.id });
  assert.equal(run.apk.manifestStatus, 'absent');
  assert.equal(run.apk.manifest, null);
});

async function readZipEntry(file, name) {
  const fd = await open(file, 'r');
  try {
    const stat = await fd.stat();
    const entries = await readZip(fd, stat.size, {});
    const entry = entries.find(item => item.name === name);
    if (!entry) throw new Error(`ZIP 缺少条目 ${name}。`);
    return await readEntry(fd, entry, 4 * 1024 * 1024, undefined, stat.size);
  } finally { await fd.close(); }
}

async function readManifestEntry(file) {
  return await readZipEntry(file, 'AndroidManifest.xml');
}

// 只按区块长度顺序走，找到指定类型的第一个区块起点。
function chunkAt(buffer, type) {
  let pos = 0;
  while (pos + 8 <= buffer.length) {
    const size = buffer.readUInt32LE(pos + 4);
    if (buffer.readUInt16LE(pos) === type) return pos;
    pos += buffer.readUInt16LE(pos) === 0x0003 ? buffer.readUInt16LE(pos + 2) : size;
  }
  return -1;
}

test('ZIP 本地头与中央目录不一致时拒绝读取，清单标为 unreadable', async t => {
  const { sourceRoot, service } = await setup(t);
  const cases = [
    { local: { name: 'Other.xml' }, pattern: /本地头文件名与中央目录不符/u },
    { local: { method: 8 }, pattern: /本地头压缩方式与中央目录不符/u },
    { local: { compressed: 3 }, pattern: /本地头压缩后大小与中央目录不符/u },
  ];
  for (const [index, item] of cases.entries()) {
    const name = `mismatch${index}.apk`;
    const file = join(sourceRoot, name);
    await writeFile(file, buildZip([{ name: 'AndroidManifest.xml', data: buildAxml(), local: item.local }]));
    await assert.rejects(readManifestEntry(file), item.pattern);
    const target = await service.add({ kind: 'local', location: name });
    const run = await service.dissect({ id: target.id });
    assert.equal(run.apk.manifestStatus, 'unreadable');
    assert.equal(run.apk.manifest, null);
    assert.equal(run.apk.counts.manifest, 0);
    assert.ok(run.notes.some(note => note.includes('清单事实缺失')));
  }
});

test('AXML 按文档声明的长度与元素声明的属性数校验，越界即报错', async t => {
  const truncated = buildAxml();
  truncated.writeUInt32LE(truncated.length - 4, 4);
  assert.throws(() => parseManifest(truncated, undefined), /AXML 区块越过文档声明的总长度/u);

  const extraAttribute = buildAxml();
  const at = chunkAt(extraAttribute, 0x0102);
  assert.ok(at > 0);
  extraAttribute.writeUInt16LE(extraAttribute.readUInt16LE(at + 28) + 1, at + 28);
  assert.throws(() => parseManifest(extraAttribute, undefined), /AXML 属性表越界/u);

  const wrongSize = buildAxml();
  const sizeAt = chunkAt(wrongSize, 0x0102);
  wrongSize.writeUInt32LE(wrongSize.readUInt32LE(sizeAt + 4) + 4, sizeAt + 4);
  assert.throws(() => parseManifest(wrongSize, undefined), /AXML 元素声明长度与属性数量不符/u);

  const trailing = Buffer.concat([buildAxml(), Buffer.from([0x2a])]);
  assert.throws(() => parseManifest(trailing, undefined), /AXML 声明范围之外仍有数据/u);

  const { sourceRoot, service } = await setup(t);
  await writeFile(join(sourceRoot, 'baddecl.apk'), buildZip([{ name: 'AndroidManifest.xml', data: truncated }]));
  const target = await service.add({ kind: 'local', location: 'baddecl.apk' });
  const run = await service.dissect({ id: target.id });
  assert.equal(run.apk.manifestStatus, 'parse-failed');
  assert.equal(run.apk.manifest, null);
  assert.ok(run.notes.some(note => note.includes('二进制 AndroidManifest.xml 解析失败')));
});

test('UTF-8 字符串池的变长长度前缀支持超过 128 字符的非 ASCII 字符串', async t => {
  const { sourceRoot, service } = await setup(t);
  const longName = `v${'长'.repeat(150)}`;
  const longPermission = `android.permission.${'X'.repeat(140)}`;
  assert.ok(Buffer.byteLength(longName, 'utf8') > 128);
  const plan = [
    ['start', 'manifest', [['package', 'str', 'com.example.utf8'], ['versionName', 'str', longName]]],
    ['start', 'uses-permission', [['name', 'str', longPermission]]],
    ['end', 'uses-permission'],
    ['end', 'manifest'],
  ];
  const data = buildAxml(plan, { utf8: true });
  await writeFile(join(sourceRoot, 'utf8.apk'), buildZip([{ name: 'AndroidManifest.xml', data }]));
  const target = await service.add({ kind: 'local', location: 'utf8.apk' });
  const run = await service.dissect({ id: target.id });
  assert.equal(run.apk.manifestStatus, 'parsed');
  assert.equal(run.apk.manifest.versionName, longName);
  assert.equal(run.apk.manifest.package, 'com.example.utf8');
  assert.deepEqual(run.apk.manifest.permissions, [longPermission]);
});

test('权限与活动按页返回，超出首页标记截断并可续页', async t => {
  const { sourceRoot, service } = await setup(t);
  const permissions = Array.from({ length: 70 }, (_, index) => `android.permission.P${String(index).padStart(2, '0')}`);
  const activities = Array.from({ length: 70 }, (_, index) => `.Act${String(index).padStart(2, '0')}`);
  const plan = [['start', 'manifest', [['package', 'str', 'com.example.page']]]];
  for (const name of permissions) plan.push(['start', 'uses-permission', [['name', 'str', name]]], ['end', 'uses-permission']);
  for (const name of activities) plan.push(['start', 'activity', [['name', 'str', name]]], ['end', 'activity']);
  plan.push(['end', 'manifest']);
  const data = buildAxml(plan);
  await writeFile(join(sourceRoot, 'page.apk'), buildZip([
    { name: 'AndroidManifest.xml', data },
    { name: 'assets/page.css', data: ':root{--p:1}' },
  ]));
  const target = await service.add({ kind: 'local', location: 'page.apk' });
  const run = await service.dissect({ id: target.id });

  assert.equal(run.apk.manifest.permissions.length, 64);
  assert.equal(run.apk.manifest.permissions[0], permissions[0]);
  assert.deepEqual(run.apk.manifest.permissionsPage, { offset: 0, limit: 64, total: 70, returned: 64, nextOffset: 64, truncated: true });
  assert.equal(run.apk.manifest.permissionsTruncated, true);
  assert.equal(run.apk.manifest.activities.length, 64);
  assert.equal(run.apk.manifest.activitiesPage.total, 70);
  assert.equal(run.apk.manifest.activitiesPage.nextOffset, 64);

  const next = manifestFacts(data, undefined, { permissions: { offset: 64 }, activities: { offset: 64 } });
  assert.equal(next.permissions.length, 6);
  assert.equal(next.permissions[0], permissions[64]);
  assert.deepEqual(next.permissionsPage, { offset: 64, limit: 64, total: 70, returned: 6, nextOffset: null, truncated: false });
  assert.equal(next.activities.length, 6);
  assert.equal(next.activitiesPage.truncated, false);
  assert.throws(() => manifestFacts(data, undefined, { permissions: { offset: -1 } }), /分页偏移无效/u);

  const spec = await service.spec({ id: target.id, runId: run.runId });
  const { readFile } = await import('node:fs/promises');
  const json = JSON.parse(await readFile(spec.files.json, 'utf8'));
  assert.equal(json.evidence.apk.manifestStatus, 'parsed');
  assert.equal(json.evidence.apk.permissions.total, 70);
  assert.equal(json.evidence.apk.permissions.returned, 64);
  assert.equal(json.evidence.apk.permissions.truncated, true);
  assert.equal(json.evidence.apk.activities.nextOffset, 64);
  const markdown = await readFile(spec.files.markdown, 'utf8');
  assert.match(markdown, /APK 权限 \| 第 1–64 条 \/ 共 70 条（有后续页，offset 64）/u);
  assert.match(markdown, /APK 清单状态 \| parsed/u);

  // 分页返回只带一页资产，清单状态与分页元数据仍随头部返回。
  const assets = await service.dossier({ id: target.id, kind: 'asset', limit: 1 });
  assert.equal(assets.rows.length, 1);
  assert.equal(assets.apk.manifestStatus, 'parsed');
  assert.equal(assets.apk.manifest.permissionsPage.total, 70);
  assert.equal(assets.apk.manifest.activitiesPage.truncated, true);
});

test('存储与 deflate 条目的实际长度必须与中央目录记录一致', async t => {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-zip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stored = join(root, 'stored.zip');
  await writeFile(stored, buildZip([{ name: 'entry.bin', data: Buffer.alloc(8), central: { uncompressed: 9 } }]));
  await assert.rejects(readZipEntry(stored, 'entry.bin'), /存储条目压缩后大小与解压后大小不符/u);

  const wrongDeflate = join(root, 'deflate-bad.zip');
  await writeFile(wrongDeflate, buildZip([{ name: 'entry.bin', data: 'hello world', method: 8, central: { uncompressed: 99 } }]));
  await assert.rejects(readZipEntry(wrongDeflate, 'entry.bin'), /解压后长度与中央目录不符/u);

  const goodDeflate = join(root, 'deflate-ok.zip');
  await writeFile(goodDeflate, buildZip([{ name: 'entry.bin', data: 'hello world', method: 8 }]));
  assert.equal((await readZipEntry(goodDeflate, 'entry.bin')).toString('utf8'), 'hello world');

  // 普通截断：中央目录写明的长度超过文件实际字节，直接报错而不是给半截数据。
  const truncated = join(root, 'truncated.zip');
  const full = buildZip([{ name: 'entry.bin', data: 'payload' }]);
  await writeFile(truncated, full.subarray(0, full.length - 22));
  await assert.rejects(readZipEntry(truncated, 'entry.bin'), /ZIP/u);
});

test('数据描述符带签名时校验大小，不带签名仍是合法写法', async t => {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-zip-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const signed = join(root, 'signed.zip');
  await writeFile(signed, buildZip([{ name: 'entry.bin', data: 'payload', descriptor: true }]));
  assert.equal((await readZipEntry(signed, 'entry.bin')).toString('utf8'), 'payload');

  const unsigned = join(root, 'unsigned.zip');
  await writeFile(unsigned, buildZip([{ name: 'entry.bin', data: 'payload', descriptor: true, descriptorSignature: false }]));
  assert.equal((await readZipEntry(unsigned, 'entry.bin')).toString('utf8'), 'payload');

  const wrong = join(root, 'wrong.zip');
  await writeFile(wrong, buildZip([{ name: 'entry.bin', data: 'payload', descriptor: true, descriptorSizes: { uncompressed: 3 } }]));
  await assert.rejects(readZipEntry(wrong, 'entry.bin'), /数据描述符与中央目录不符/u);
});

test('AXML 区块头长度与最小结构不完整时报错', () => {
  const oversizedHeader = buildAxml();
  const start = chunkAt(oversizedHeader, 0x0102);
  oversizedHeader.writeUInt16LE(oversizedHeader.readUInt32LE(start + 4) + 2, start + 2);
  assert.throws(() => parseManifest(oversizedHeader, undefined), /AXML 区块头长度超过区块长度/u);

  // headerSize 16 <= size 20：头部合法但装不下 ResXMLTree_attrExt 的 36 字节最小结构。
  const shortElement = buildAxml();
  const element = chunkAt(shortElement, 0x0102);
  shortElement.writeUInt32LE(20, element + 4);
  assert.throws(() => parseManifest(shortElement, undefined), /AXML 起始标签结构不完整/u);

  const shortPool = buildAxml();
  const poolAt = chunkAt(shortPool, 0x0001);
  assert.ok(poolAt > 0);
  shortPool.writeUInt16LE(8, poolAt + 2);
  shortPool.writeUInt32LE(8, poolAt + 4);
  assert.throws(() => parseManifest(shortPool, undefined), /AXML 字符串池头部无效/u);
});

test('AXML 属性预算按每个元素声明的数量预扣，超限在建模前就报错', () => {
  const data = buildAxml();
  assert.ok(parseManifest(data, undefined).length >= 1);
  assert.throws(() => parseManifest(data, undefined, { maxAttributes: 2 }), /AXML 属性预算超限/u);
});
