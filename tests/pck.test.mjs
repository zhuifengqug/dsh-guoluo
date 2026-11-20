import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Config } from '../index.js';
import { readPck } from '../lib/pck.mjs';
import { projectService } from '../lib/projects.mjs';

const MAGIC = 0x43504447;

function buildPck({ formatVersion = 2, major = 4, minor = 2, patch = 1, packFlags = 0, skipData = false, entries = [
  { path: 'icon.png', size: 4 },
  { path: 'scenes/main.tscn', size: 8 },
  { path: 'audio/theme.ogg', size: 2 },
] } = {}) {
  const modern = formatVersion >= 2;
  const tailDirectory = formatVersion >= 3;
  const head = Buffer.alloc(tailDirectory ? 104 : modern ? 96 : 84);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(formatVersion, 4);
  head.writeUInt32LE(major, 8);
  head.writeUInt32LE(minor, 12);
  head.writeUInt32LE(patch, 16);
  const blocks = entries.map(({ path }) => {
    const name = Buffer.from(path);
    const fieldLength = modern ? Math.ceil(name.length / 4) * 4 : name.length;
    const block = Buffer.alloc(4 + fieldLength + (modern ? 36 : 32));
    block.writeUInt32LE(fieldLength);
    name.copy(block, 4);
    return block;
  });
  const count = Buffer.alloc(4);
  count.writeUInt32LE(entries.length);
  const dataSize = entries.reduce((sum, entry) => sum + entry.size, 0);
  const dataStart = tailDirectory ? head.length : head.length + 4 + blocks.reduce((sum, block) => sum + block.length, 0);
  const fileBase = modern ? dataStart : 0;
  if (modern) {
    head.writeUInt32LE(packFlags, 20);
    head.writeBigUInt64LE(BigInt(fileBase), 24);
  }
  if (tailDirectory) head.writeBigUInt64LE(BigInt(dataStart + dataSize), 32);
  let position = dataStart;
  for (const [i, block] of blocks.entries()) {
    const offset = 4 + block.readUInt32LE();
    block.writeBigUInt64LE(BigInt(position - fileBase), offset);
    block.writeBigUInt64LE(BigInt(entries[i].size), offset + 8);
    if (modern) block.writeUInt32LE(entries[i].flags ?? 0, offset + 32);
    position += entries[i].size;
  }
  const data = Buffer.alloc(skipData ? 0 : dataSize);
  return Buffer.concat(tailDirectory ? [head, data, count, ...blocks] : [head, count, ...blocks, data]);
}

async function temp(t, bytes, name = 'game.pck') {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-pck-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, name);
  await writeFile(file, bytes);
  return { root, file };
}

test('PCK 包格式 2 读出引擎、条目与计数', async t => {
  const bytes = buildPck();
  const { file } = await temp(t, bytes);
  const facts = await readPck(file, bytes.length, {});
  assert.equal(facts.packFormat, 2);
  assert.equal(facts.engine, 'Godot 4.2.1');
  assert.equal(facts.counts.entries, 3);
  assert.equal(facts.counts.scenes, 1);
  assert.equal(facts.counts.resources, 2);
  assert.equal(facts.declaredBytes, '14');
  assert.deepEqual(facts.files.map(entry => entry.path), ['icon.png', 'scenes/main.tscn', 'audio/theme.ogg']);
});

test('PCK 包格式 1 与相对文件基址', async t => {
  const v1 = buildPck({ formatVersion: 1, major: 3, minor: 5, patch: 2 });
  const one = await temp(t, v1, 'old.pck');
  const facts = await readPck(one.file, v1.length, {});
  assert.equal(facts.packFormat, 1);
  assert.equal(facts.engine, 'Godot 3.5.2');
  assert.equal(facts.files[0].path, 'icon.png');
  const v2 = buildPck({ packFlags: 0 });
  const two = await temp(t, v2, 'relative.pck');
  const relativeFacts = await readPck(two.file, v2.length, {});
  assert.equal(relativeFacts.files[0].offset, v2.length - 14);
  assert.equal(relativeFacts.fileBase, String(v2.length - 14));
  assert.equal(relativeFacts.files[1].offset, v2.length - 10);
});

test('PCK 拒绝坏标识、未知格式、越界条目与非法路径', async t => {
  const badMagic = Buffer.alloc(32);
  const magicFile = await temp(t, badMagic, 'bad.pck');
  await assert.rejects(readPck(magicFile.file, 32, {}), /PCK 头标识无效/u);
  const unknown = buildPck({ formatVersion: 2 });
  unknown.writeUInt32LE(5, 4);
  const unknownFile = await temp(t, unknown, 'v3.pck');
  await assert.rejects(readPck(unknownFile.file, unknown.length, {}), /暂不支持/u);
  const overflow = buildPck({ skipData: true, entries: [{ path: 'big.png', size: 4096 }] });
  const overflowFile = await temp(t, overflow, 'big.pck');
  await assert.rejects(readPck(overflowFile.file, overflow.length, {}), /范围越界/u);
  const traversal = buildPck({ entries: [{ path: '../evil.png', size: 2 }] });
  const traversalFile = await temp(t, traversal, 'evil.pck');
  await assert.rejects(readPck(traversalFile.file, traversal.length, {}), /无效字符/u);
});

test('PCK 盘点把条目登记为归档素材并写入规格与 mock 说明', async t => {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-pck-dir-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [sourceRoot, archiveRoot] = ['source', 'archive'].map(name => join(root, name));
  await Promise.all([mkdir(sourceRoot), mkdir(archiveRoot)]);
  await writeFile(join(sourceRoot, 'game.pck'), buildPck());
  const service = projectService(Config({ sourceRoot, archiveRoot, reaPath: join(root, 'missing.mjs') }));
  const target = await service.add({ kind: 'local', location: 'game.pck' });
  const run = await service.dissect({ id: target.id });
  assert.equal(run.rea.status, 'skipped');
  const assets = await service.dossier({ id: target.id, kind: 'asset' });
  assert.deepEqual(assets.rows.find(row => row.path === 'icon.png'), { kind: 'asset', path: 'icon.png', type: 'image', bytes: 4, archive: 'pck' });
  const spec = await service.spec({ id: target.id, runId: run.runId });
  const specJson = JSON.parse(await readFile(spec.files.json, 'utf8'));
  assert.equal(specJson.evidence.pck.engine, 'Godot 4.2.1');
  assert.equal(specJson.evidence.pck.counts.scenes, 1);
  assert.ok(specJson.unknowns.some(line => /PCK 只读包头/u.test(line)));
  const mock = await service.mock({ id: target.id, runId: run.runId });
  const mockConfig = JSON.parse(await readFile(mock.files.config, 'utf8'));
  assert.ok(mockConfig.unreplayed.some(item => item.value === 'icon.png' && /PCK 归档成员/u.test(item.reason)));
});

test('原生 Godot 4.7.2 导出的包格式 4 被如实读出', async () => {
  const path = fileURLToPath(new URL('./fixtures/godot-4.7.2.pck', import.meta.url));
  const { size } = await stat(path);
  const pck = await readPck(path, size);
  // 这份包由引擎自带 PCKPacker 生成，不经本仓库夹具；数值与引擎写出的头部直接对应。
  assert.equal(pck.packFormat, 4);
  assert.equal(pck.engine, 'Godot 4.7.2');
  assert.equal(pck.packFlags, 2);
  assert.equal(pck.fileBase, '128');
  assert.equal(pck.directoryStatus, 'parsed');
  assert.deepEqual(pck.counts, { entries: 1, encrypted: 0, directories: 0, scenes: 0, scripts: 0, resources: 0, removed: 0, delta: 0 });
  assert.equal(pck.declaredBytes, '5');
  assert.deepEqual(pck.files, [{ path: 'ok.txt', bytes: 5, offset: 128, encrypted: false, ext: 'txt' }]);
});
