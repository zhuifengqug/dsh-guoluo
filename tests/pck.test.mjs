import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Config } from '../index.js';
import { readPck } from '../lib/pck.mjs';
import { projectService } from '../lib/projects.mjs';

const MAGIC = 0x43504447;

function buildPck({ formatVersion = 2, major = 4, minor = 2, patch = 1, packFlags = 0, fileBase = 0n, relative = false, skipData = false, entries = [
  { path: 'icon.png', size: 4 },
  { path: 'scenes/main.tscn', size: 8 },
  { path: 'audio/theme.ogg', size: 2 },
] } = {}) {
  const entryLength = entries.reduce((sum, entry) => sum + 4 + Buffer.byteLength(entry.path) + ((4 - (Buffer.byteLength(entry.path) % 4)) % 4) + 8 + 8 + 16 + (formatVersion === 2 ? 4 : 0), 0);
  const headerLength = formatVersion === 2 ? 8 + 12 + 64 + 4 + 8 + 4 : 8 + 12 + 64 + 4;
  const dataStart = headerLength + entryLength;
  const parts = [];
  const head = Buffer.alloc(headerLength);
  head.writeUInt32LE(MAGIC, 0);
  head.writeUInt32LE(formatVersion, 4);
  head.writeUInt32LE(major, 8);
  head.writeUInt32LE(minor, 12);
  head.writeUInt32LE(patch, 16);
  let at = 20 + 64;
  if (formatVersion === 2) {
    head.writeUInt32LE(packFlags, at);
    head.writeBigUInt64LE(fileBase, at + 4);
    at += 12;
  }
  head.writeUInt32LE(entries.length, at);
  parts.push(head);
  let cursor = dataStart;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, 'utf8');
    const pad = (4 - (name.length % 4)) % 4;
    const block = Buffer.alloc(4 + name.length + pad + 8 + 8 + 16 + (formatVersion === 2 ? 4 : 0));
    block.writeUInt32LE(name.length, 0);
    name.copy(block, 4);
    block.writeBigUInt64LE(relative ? 0n : BigInt(cursor), 4 + name.length + pad);
    block.writeBigUInt64LE(BigInt(entry.size), 4 + name.length + pad + 8);
    if (formatVersion === 2) block.writeUInt32LE(entry.flags ?? 0, block.length - 4);
    parts.push(block);
    cursor += entry.size;
  }
  if (!skipData) parts.push(Buffer.alloc(cursor - dataStart));
  return Buffer.concat(parts);
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
  const relativized = buildPck({ packFlags: 2, fileBase: 260n, relative: true });
  const two = await temp(t, relativized, 'rel.pck');
  const relativeFacts = await readPck(two.file, relativized.length, {});
  assert.equal(relativeFacts.files[0].offset, 260);
  assert.equal(relativeFacts.fileBase, '260');
});

test('PCK 拒绝坏标识、未知格式、越界条目与非法路径', async t => {
  const badMagic = Buffer.alloc(32);
  const magicFile = await temp(t, badMagic, 'bad.pck');
  await assert.rejects(readPck(magicFile.file, 32, {}), /PCK 头标识无效/u);
  const unknown = buildPck({ formatVersion: 2 });
  unknown.writeUInt32LE(3, 4);
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
