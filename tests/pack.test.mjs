import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Config } from '../index.js';
import { projectService } from '../lib/projects.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-pack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [sourceRoot, archiveRoot] = ['source', 'archive'].map(name => join(root, name));
  await Promise.all([mkdir(sourceRoot), mkdir(archiveRoot)]);
  const service = projectService(Config({ sourceRoot, archiveRoot, reaPath: join(root, 'missing.mjs') }));
  return { root, sourceRoot, archiveRoot, service };
}

async function site(t) {
  const context = await setup(t);
  const folder = join(context.sourceRoot, 'site');
  await mkdir(folder);
  await writeFile(join(folder, 'index.html'), '<!doctype html>\n<link rel="stylesheet" href="theme.css">\n<a href="/pricing">价格</a>\n<h1 id="hero" class="title">蜾蠃</h1>\n<img src="hero.png">');
  await writeFile(join(folder, 'theme.css'), ':root {\n  --accent: #08e;\n}');
  await writeFile(join(folder, 'hero.png'), Buffer.from([4, 5, 6, 7]));
  const target = await context.service.add({ kind: 'local', location: 'site' });
  const run = await context.service.dissect({ id: target.id });
  return { ...context, folder, id: target.id, run };
}

const exists = async path => {
  try { await access(path); return true; } catch { return false; }
};

const readPack = async (archiveRoot, result, name = 'INDEX.md') => readFile(join(archiveRoot, result.directory, name), 'utf8');

test('一条命令跑完整链，并在 pack/<批次>/ 落人读索引与机器读汇总', async t => {
  const { id, service, archiveRoot } = await site(t);
  const result = await service.run({ id });
  // 没给 runId 就自己盘点：这一趟追加了一批证据，索引指向的必须是这一批。
  const status = await service.status({ id });
  assert.equal(status.runCount, 2);
  assert.equal(result.runId, status.latest);
  assert.match(result.directory, /^[0-9a-f-]{36}\/pack\/\d{13}-[0-9a-f-]{36}$/u);
  assert.equal(result.files.index, `${result.directory}/INDEX.md`);
  assert.deepEqual(result.steps.map(step => step.name), ['dissect', 'spec', 'brief', 'tokens', 'export', 'scaffold', 'check', 'pack']);
  assert.ok(result.steps.every(step => step.status === 'ok'));
  assert.ok(result.steps.every(step => Number.isSafeInteger(step.durationMs)));
  assert.equal(result.scaffold.counts.copied, 3);
  assert.equal(result.check.verdict, 'complete');

  const index = await readPack(archiveRoot, result);
  assert.match(index, /^# 复刻包：/u);
  for (const section of ['## 步骤', '## 先看什么（按这个顺序）', '## 证据事实', '## 缺口与待确认', '## 怎么复刻', '## 产物清单', '## 口径']) assert.ok(index.includes(section), section);
  assert.match(index, /\.\.\/\.\.\/spec\/spec\.md/u);
  assert.match(index, /\.\.\/\.\.\/scaffold\/[^/]+\/README\.md/u);
  assert.match(index, /不表示样式、布局、脚本行为或业务逻辑等价/u);

  const summary = JSON.parse(await readPack(archiveRoot, result, 'pack.json'));
  assert.equal(summary.schemaVersion, 1);
  assert.equal(summary.runId, result.runId);
  assert.equal(summary.steps.length, 8);
  assert.equal(summary.check.verdict, 'complete');
  assert.equal(summary.scaffold.coverageVerdict, 'complete');
  assert.equal(summary.files.index, 'INDEX.md');
  assert.ok(await exists(join(archiveRoot, result.directory, 'pack.json')));
});

test('重跑落到独立批次目录，旧包原样保留', async t => {
  const { id, run, service, archiveRoot } = await site(t);
  const first = await service.run({ id, runId: run.runId, name: 'one' });
  const second = await service.run({ id, runId: run.runId, name: 'two' });
  assert.notEqual(first.directory, second.directory);
  assert.ok(first.directory.startsWith(`${id}/pack/`));
  assert.equal((await service.status({ id })).runCount, 1);

  const firstIndex = await readPack(archiveRoot, first);
  const secondIndex = await readPack(archiveRoot, second);
  assert.match(firstIndex, /scaffold\/one\//u);
  assert.match(secondIndex, /scaffold\/two\//u);
  assert.equal(JSON.parse(await readPack(archiveRoot, first, 'pack.json')).scaffold.directory, `${id}/scaffold/one`);
  assert.equal(JSON.parse(await readPack(archiveRoot, second, 'pack.json')).scaffold.directory, `${id}/scaffold/two`);
  // 只有 pack/<批次>/ 子目录，没有把索引直接摊在 pack/ 下。
  assert.equal(await exists(join(archiveRoot, id, 'pack', 'INDEX.md')), false);
});

test('给出 runId 时沿用既有批次，不重新盘点', async t => {
  const { id, run, service } = await site(t);
  const result = await service.run({ id, runId: run.runId });
  assert.equal(result.runId, run.runId);
  assert.equal(result.steps[0].name, 'dissect');
  assert.equal(result.steps[0].status, 'reused');
  assert.match(result.steps[0].note, /沿用批次/u);
  assert.equal(result.steps.length, 8);
});

test('单文件素材不生成骨架，但仍出索引并写明原因', async t => {
  const context = await setup(t);
  await writeFile(join(context.sourceRoot, 'single.html'), '<!doctype html><h1 id="hero">单页</h1>');
  const target = await context.service.add({ kind: 'local', location: 'single.html' });
  const result = await context.service.run({ id: target.id });
  assert.equal(result.scaffold, null);
  const scaffoldStep = result.steps.find(step => step.name === 'scaffold');
  assert.equal(scaffoldStep.status, 'skipped');
  assert.match(scaffoldStep.note, /单个文件/u);
  const index = await readPack(context.archiveRoot, result);
  assert.match(index, /这一步没有生成骨架/u);
});

test('失败停在第几步并说明原因，不写半截索引', async t => {
  const context = await setup(t);
  const target = await context.service.add({ kind: 'url', location: 'https://example.com' });
  await assert.rejects(() => context.service.run({ id: target.id }), error => {
    assert.equal(error.kind, 'invalid-input');
    assert.equal(error.stage, 'dissect');
    assert.match(error.message, /第 1 步「dissect」停下/u);
    assert.match(error.message, /URL 只作登记/u);
    return true;
  });
  assert.equal(await exists(join(context.archiveRoot, target.id, 'pack')), false);
});

test('后一趟失败不会动到已经写好的旧包', async t => {
  const { id, run, service, archiveRoot } = await site(t);
  const good = await service.run({ id, runId: run.runId, name: 'keep' });
  const before = await readPack(archiveRoot, good);
  await assert.rejects(() => service.run({ id, runId: run.runId, name: 'no good', candidate: { directory: 'site' } }), error => {
    assert.equal(error.stage, 'scaffold');
    assert.match(error.message, /第 6 步「scaffold」停下/u);
    return true;
  });
  assert.equal(await readPack(archiveRoot, good), before);
  const packs = await readdir(join(archiveRoot, id, 'pack'));
  assert.deepEqual(packs.filter(name => name.startsWith('.new-')), []);
  assert.equal(packs.length, 1);
});

test('同一档案并发盘点被锁挡住，不会写出两个包', async t => {
  const { id, service, archiveRoot } = await site(t);
  const [left, right] = await Promise.allSettled([service.run({ id, name: 'left' }), service.run({ id, name: 'right' })]);
  const passed = [left, right].filter(item => item.status === 'fulfilled');
  const failed = [left, right].filter(item => item.status === 'rejected');
  assert.equal(passed.length, 1);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].reason.stage, 'dissect');
  assert.match(failed[0].reason.message, /已有盘点在运行/u);
  const result = passed[0].value;
  const summary = JSON.parse(await readPack(archiveRoot, result, 'pack.json'));
  assert.equal(summary.runId, result.runId);
  assert.equal((await service.status({ id })).latest, result.runId);
  assert.equal((await readdir(join(archiveRoot, id, 'pack'))).length, 1);
});

test('同一趟把候选工程也核进去，报告写进索引', async t => {
  const { id, run, service, archiveRoot } = await site(t);
  const result = await service.run({ id, runId: run.runId, name: 'packed', candidate: { directory: 'site' } });
  assert.equal(result.scaffold.directory, `${id}/scaffold/packed`);
  assert.equal(result.check.candidate.verdict, 'complete');
  assert.ok(result.check.candidate.report);
  const index = await readPack(archiveRoot, result);
  assert.match(index, /结构缺口报告/u);
  assert.match(index, /候选核对/u);
  const summary = JSON.parse(await readPack(archiveRoot, result, 'pack.json'));
  assert.equal(summary.check.candidate.verdict, 'complete');
  assert.ok(await exists(join(archiveRoot, result.directory, 'pack.json')));
});
