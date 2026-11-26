import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Config } from '../index.js';
import { inventory } from '../lib/inventory.mjs';
import { projectService } from '../lib/projects.mjs';
import { maxAssetHashFileBytes } from '../lib/paths.mjs';
import { scaffoldHardLimits } from '../lib/scaffold.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-untyped-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [sourceRoot, archiveRoot] = ['source', 'archive'].map(name => join(root, name));
  await Promise.all([mkdir(sourceRoot), mkdir(archiveRoot)]);
  const service = projectService(Config({ sourceRoot, archiveRoot, reaPath: join(root, 'missing.mjs') }));
  return { root, sourceRoot, archiveRoot, service };
}

test('未识别类型的文件标为 other，保留路径、扩展名与指纹', async t => {
  const { root } = await setup(t);
  const folder = join(root, '素材');
  await mkdir(join(folder, 'data'), { recursive: true });
  await writeFile(join(folder, 'index.html'), '<!doctype html><h1>a</h1>');
  await writeFile(join(folder, 'data', 'app.so'), Buffer.from('ELF-не-app'));
  await writeFile(join(folder, 'notes.txt'), Buffer.from('纯文本'));
  const facts = await inventory({ path: folder, stat: await stat(folder), label: '素材' });
  const so = facts.rows.find(row => row.path === 'data/app.so');
  assert.equal(so.kind, 'asset');
  assert.equal(so.type, 'other');
  assert.equal(so.extension, 'so');
  assert.equal(so.bytes, Buffer.byteLength('ELF-не-app'));
  assert.match(so.sha256, /^[0-9a-f]{64}$/u);
  const text = facts.rows.find(row => row.path === 'notes.txt');
  assert.equal(text.type, 'other');
  assert.equal(text.extension, 'txt');
  assert.equal(facts.coverage.untyped, 2);
  assert.equal(facts.rows.find(row => row.path === 'index.html').type, 'page');
  assert.ok(facts.notes.some(note => /个未识别类型的文件已标为 other/u.test(note)));
  assert.equal(facts.coverage.limits.assetHashPerFile, maxAssetHashFileBytes);
  assert.equal(maxAssetHashFileBytes, 32 * 1024 * 1024);
});

test('素材指纹预算不足时逐条计数，不再静默留空', async t => {
  const { root } = await setup(t);
  const folder = join(root, '素材');
  await mkdir(folder);
  await writeFile(join(folder, 'a.webp'), Buffer.alloc(3, 1));
  await writeFile(join(folder, 'b.webp'), Buffer.alloc(5, 2));
  const facts = await inventory({ path: folder, stat: await stat(folder), label: '素材' });
  assert.equal(facts.coverage.skippedAssetHashes, 0);
  assert.equal(facts.coverage.hashedAssets, 2);
  assert.ok(facts.rows.every(row => /^[0-9a-f]{64}$/u.test(row.sha256)));
  assert.equal(facts.notes.filter(note => /未取内容指纹/u.test(note)).length, 0);
});

test('骨架预算可调高：默认挡下的可复制素材，调高后全部搬过来', async t => {
  const { sourceRoot, service } = await setup(t);
  const folder = join(sourceRoot, 'gallery');
  await mkdir(folder);
  await writeFile(join(folder, 'index.html'), '<!doctype html><h1>g</h1>');
  for (const name of ['a.png', 'b.png', 'c.png', 'd.png']) {
    await writeFile(join(folder, name), Buffer.from([1, 2, 3, name.length]));
  }
  const { id } = await service.add({ kind: 'local', location: 'gallery' });
  await service.dissect({ id });
  const capped = await service.scaffold({ id, name: 'capped', files: 2 });
  assert.equal(capped.counts.copied, 2);
  assert.ok(capped.budget.hit);
  assert.equal(capped.budget.blocked, 3);
  assert.equal(capped.budget.files, 2);
  assert.ok(capped.warnings.some(note => /因预算未复制/u.test(note)));
  const raised = await service.scaffold({ id, name: 'raised', files: 8 });
  assert.equal(raised.counts.copied, 5);
  assert.equal(raised.budget.hit, false);
  assert.equal(raised.budget.blocked, 0);
  assert.equal(raised.coverage.verdict, 'complete');
  assert.ok(raised.warningCount === 0);
});

test('骨架预算入参越界时拒绝，不生成半截目录', async t => {
  const { sourceRoot, service, archiveRoot } = await setup(t);
  const folder = join(sourceRoot, 'gallery');
  await mkdir(folder);
  await writeFile(join(folder, 'index.html'), '<!doctype html>');
  const { id } = await service.add({ kind: 'local', location: 'gallery' });
  await service.dissect({ id });
  await assert.rejects(() => service.scaffold({ id, name: 'big', files: scaffoldHardLimits.files + 1 }), /1–4096/u);
  await assert.rejects(() => service.scaffold({ id, name: 'zero', totalBytes: 0 }), /1–268435456/u);
  await assert.rejects(() => service.scaffold({ id, name: 'frac', fileBytes: 1.5 }), /1–33554432/u);
  for (const name of ['big', 'zero', 'frac']) await assert.rejects(() => stat(join(archiveRoot, id, 'scaffold', name)), /ENOENT/u);
});

test('没有 HTML 页面时骨架与候选核对都写明是空集', async t => {
  const { sourceRoot, service } = await setup(t);
  const folder = join(sourceRoot, 'assets-only');
  await mkdir(folder);
  await writeFile(join(folder, 'hero.webp'), Buffer.from([9, 9, 9]));
  await writeFile(join(folder, 'data.so'), Buffer.from('blob'));
  const { id } = await service.add({ kind: 'local', location: 'assets-only' });
  await service.dissect({ id });
  const planned = await service.scaffold({ id, name: 'media' });
  assert.deepEqual(planned.web, { pages: 0, styles: 0, tokens: 0, applicable: false });
  assert.ok(planned.warnings.some(note => /没有 HTML 页面/u.test(note)));
  const checked = await service.check({ id, candidate: { directory: 'assets-only' } });
  assert.equal(checked.candidate.structure.evidencePages, 0);
  assert.equal(checked.candidate.structure.pages.total, 0);
  assert.match(checked.candidate.note, /证据里没有 HTML 页面/u);
  assert.match(checked.candidate.note, /不是核对通过/u);
});

test('有 HTML 页面时不再输出空集说明', async t => {
  const { sourceRoot, service } = await setup(t);
  const folder = join(sourceRoot, 'page');
  await mkdir(folder);
  await writeFile(join(folder, 'index.html'), '<!doctype html><h1 id="top">a</h1>');
  const { id } = await service.add({ kind: 'local', location: 'page' });
  await service.dissect({ id });
  const checked = await service.check({ id, candidate: { directory: 'page' } });
  assert.equal(checked.candidate.structure.evidencePages, 1);
  assert.doesNotMatch(checked.candidate.note, /证据里没有 HTML 页面/u);
});