import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Config } from '../index.js';
import { projectService } from '../lib/projects.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-verdict-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [sourceRoot, archiveRoot] = ['source', 'archive'].map(name => join(root, name));
  await Promise.all([mkdir(sourceRoot), mkdir(archiveRoot)]);
  const service = projectService(Config({ sourceRoot, archiveRoot, reaPath: join(root, 'missing.mjs') }));
  return { root, sourceRoot, archiveRoot, service };
}

const pageHtml = `<!doctype html>
<html lang="zh-CN">
  <head><title>示例站</title></head>
  <body><h1 id="hero">欢迎</h1><a href="/pricing">价格</a></body>
</html>`;

async function site(t) {
  const context = await setup(t);
  const folder = join(context.sourceRoot, 'site');
  await mkdir(folder);
  await writeFile(join(folder, 'index.html'), pageHtml);
  const target = await context.service.add({ kind: 'local', location: 'site' });
  const run = await context.service.dissect({ id: target.id });
  return { ...context, folder, id: target.id, run };
}

// 候选工程放在素材根内：这里直接复制一份原页面，结构必然对得上。
async function candidate(context, name = '复刻') {
  const folder = join(context.sourceRoot, name);
  await mkdir(folder);
  await writeFile(join(folder, 'index.html'), pageHtml);
  await context.service.check({ id: context.id, runId: context.run.runId, candidate: { directory: name } });
  return name;
}

test('拍板：接受一份对得上的候选，落 verdict.json 并把未对上项留空', async t => {
  const context = await site(t);
  await candidate(context);
  const result = await context.service.verdict({ id: context.id, decision: 'accepted', note: '' });
  assert.equal(result.decision, 'accepted');
  assert.equal(result.runId, context.run.runId);
  assert.equal(result.check.verdict, 'complete');
  assert.deepEqual(result.check.unmet, []);
  assert.equal(result.history, 1);
  assert.match(result.file, /verdict\.json$/u);
  const stored = JSON.parse(await readFile(result.file, 'utf8'));
  assert.equal(stored.schemaVersion, 1);
  assert.equal(stored.decision, 'accepted');
  assert.equal(stored.checkId, result.check.checkId);
  assert.match(result.line, /^已接受（/u);
});

test('拍板：候选核对后又有无候选核对，仍取当前批次的候选依据', async t => {
  const context = await site(t);
  await candidate(context);
  await context.service.check({ id: context.id, runId: context.run.runId });
  const result = await context.service.verdict({ id: context.id, decision: 'accepted' });
  assert.equal(result.decision, 'accepted');
  assert.equal(result.check.runId, context.run.runId);
  assert.equal(result.check.verdict, 'complete');
});

test('拍板：没有候选核对时拒绝，并说明要先跑哪一步', async t => {
  const context = await site(t);
  await assert.rejects(
    context.service.verdict({ id: context.id, decision: 'accepted' }),
    error => error.kind === 'invalid-input' && /guoluo_check/u.test(error.message),
  );
  // 只跑了一次不带候选的核对：同样不算验收依据。
  await context.service.check({ id: context.id, runId: context.run.runId });
  await assert.rejects(
    context.service.verdict({ id: context.id, decision: 'accepted' }),
    error => error.kind === 'invalid-input' && /candidate\.directory/u.test(error.message),
  );
});

test('拍板：退回要写原因，写了就记进历史；再接受保留两条历史', async t => {
  const context = await site(t);
  await candidate(context);
  await assert.rejects(
    context.service.verdict({ id: context.id, decision: 'rejected', note: '   ' }),
    error => error.kind === 'invalid-input' && /原因/u.test(error.message),
  );
  const rejected = await context.service.verdict({ id: context.id, decision: 'rejected', note: '样式还没接上' });
  assert.equal(rejected.decision, 'rejected');
  assert.equal(rejected.note, '样式还没接上');
  assert.match(rejected.line, /^已退回（/u);
  const accepted = await context.service.verdict({ id: context.id, decision: 'accepted' });
  assert.equal(accepted.history, 2);
  const stored = JSON.parse(await readFile(accepted.file, 'utf8'));
  assert.deepEqual(stored.history.map(entry => entry.decision), ['accepted', 'rejected']);
  assert.equal(stored.history[1].note, '样式还没接上');
});

test('拍板：接受没全对上的候选可以，但缺口逐条进 unmet，不算通过', async t => {
  const context = await site(t);
  const folder = join(context.sourceRoot, '漏了一半');
  await mkdir(folder);
  // 路径对得上（index.html 还在），但页面里少了 id 与链接：结构层缺项。
  await writeFile(join(folder, 'index.html'), '<!doctype html><html><body><h1>欢迎</h1></body></html>');
  await context.service.check({ id: context.id, runId: context.run.runId, candidate: { directory: '漏了一半' } });
  const result = await context.service.verdict({ id: context.id, decision: 'accepted' });
  assert.equal(result.decision, 'accepted');
  assert.notEqual(result.check.verdict, 'complete');
  assert.ok(result.check.unmet.length > 0, '没对上的项必须逐条记录');
  assert.ok(result.check.unmet.some(line => /结构层缺|候选结论是/u.test(line)));
});

test('拍板：最近一次核对属于别的批次时拒绝，不跨批次套用结论', async t => {
  const context = await site(t);
  await candidate(context);
  await writeFile(join(context.folder, 'index.html'), pageHtml.replace('欢迎', '欢迎回来'));
  await context.service.dissect({ id: context.id });
  // 拒的是「拿旧批次的核对给新批次拍板」，所以报的是核对那一批的批次号。
  await assert.rejects(
    context.service.verdict({ id: context.id, decision: 'accepted' }),
    error => error.kind === 'invalid-input' && new RegExp(context.run.runId, 'u').test(error.message),
  );
});

test('拍板：非法结论按输入错拒绝', async t => {
  const context = await site(t);
  await candidate(context);
  await assert.rejects(
    context.service.verdict({ id: context.id, decision: 'maybe' }),
    error => error.kind === 'invalid-input' && /accepted/u.test(error.message),
  );
});