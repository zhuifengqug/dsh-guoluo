import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Config } from '../index.js';
import { projectService } from '../lib/projects.mjs';

function utf16Pool(strings) {
  const parts = [];
  const offsets = [];
  let cursor = 0;
  for (const value of strings) {
    offsets.push(cursor);
    const chars = Buffer.from(value, 'utf16le');
    const units = chars.length / 2;
    const length = units < 0x80 ? Buffer.from([units]) : Buffer.from([0x80 | (units >> 8), units & 0xff]);
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

function buildAxml(plan = PLAN) {
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
        : { name: intern(name), type: kind === 'boolean' ? 0x12 : 0x10, data: value }));
      chunks.push(startElement(intern(step[1]), attributes));
    } else {
      chunks.push(endElement(intern(step[1])));
    }
  }
  const pool = utf16Pool(strings);
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
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, data);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x800, 8);
    record.writeUInt32LE(0, 16);
    record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += 30 + name.length + data.length;
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
  assert.ok(json.unknowns.some(line => line.includes('APK 只做静态清单解析')));
  const markdown = await readFile(spec.files.markdown, 'utf8');
  assert.match(markdown, /APK 包名 \| com\.example\.demo/u);
});

test('损坏的 ZIP 被拒绝且不留下批次', async t => {
  const { sourceRoot, service } = await setup(t);
  await writeFile(join(sourceRoot, 'broken.apk'), Buffer.from('not a zip at all, definitely not'));
  const target = await service.add({ kind: 'local', location: 'broken.apk' });
  await assert.rejects(service.dissect({ id: target.id }), /ZIP/u);
  assert.equal((await service.status({ id: target.id })).runCount, 0);
});
