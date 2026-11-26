import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Config } from '../index.js';
import { projectService } from '../lib/projects.mjs';
import { applyAnswer, buildQuestions, inferStack } from '../lib/questions.mjs';

const totalsOf = (asset, extra = {}) => ({ asset, byType: { image: 0, other: 0, ...extra } });

function specOf({ label = 'demo', counts = {}, totals = totalsOf(4), coverage = { total: 4, missing: 0 }, conflicts = [] } = {}) {
  return { label, counts: { asset: 4, 'style-token': 0, structure: 0, route: 0, reference: 0, ...counts }, evidence: { totals, coverage }, conflicts, unknowns: [] };
}

const rows = list => ({ rows: list, totals: totalsOf(list.length), coverage: { total: list.length, missing: 0 } });

test('技术栈判断只到「有没有页面/样式/打包产物」这一层', () => {
  assert.equal(inferStack({}, {}, rows([])).kind, 'unknown');
  assert.equal(inferStack({ asset: 2 }, totalsOf(2), rows([
    { kind: 'asset', type: 'page', path: 'a.html' },
    { kind: 'asset', type: 'style', path: 'a.css' },
  ])).kind, 'html');
  assert.equal(inferStack({ asset: 2, 'style-token': 3 }, totalsOf(2), rows([
    { kind: 'asset', type: 'page', path: 'a.html' },
  ])).kind, 'web');
  assert.equal(inferStack({ asset: 2 }, totalsOf(2, { library: 1 }), rows([
    { kind: 'asset', type: 'library', path: 'a.dll' },
  ])).kind, 'bundle');
  assert.equal(inferStack({}, {}, { rows: [], unity: { blocks: 1 } }).kind, 'unity');
  assert.equal(inferStack({}, {}, { rows: [], pck: { entries: 1 } }).kind, 'godot');
  assert.equal(inferStack({}, {}, { rows: [], apk: { manifest: {} } }).kind, 'apk');
  assert.equal(inferStack({}, {}, { rows: [], pe: { imports: [] } }).kind, 'pe');
});

test('问题清单只问必须由人拍板的事，key 稳定', () => {
  const state = buildQuestions({
    id: 'a'.repeat(8) + '-' + 'b'.repeat(4) + '-' + 'c'.repeat(4) + '-' + 'd'.repeat(4) + '-' + 'e'.repeat(12),
    runId: 'run-1',
    spec: specOf({ counts: { 'style-token': 2 } }),
    run: rows([{ kind: 'asset', type: 'page', path: 'index.html' }, { kind: 'asset', type: 'style', path: 'app.css' }]),
    generatedAt: '2026-11-27T00:00:00.000Z',
  });
  assert.deepEqual(state.questions.map(entry => entry.key), ['stack', 'name']);
  assert.equal(state.stack.kind, 'web');
  assert.deepEqual(state.open, ['stack', 'name']);
  assert.equal(state.questions[0].suggested, '静态 HTML + CSS，一页一页重建');
  assert.equal(state.questions[1].suggested, 'demo');
  for (const entry of state.questions) {
    assert.ok(entry.why.length > 0, `${entry.key} 要写依据`);
    assert.ok(Array.isArray(entry.options));
  }

  const bare = buildQuestions({ id: 'x', runId: 'run-1', spec: specOf({ counts: { 'style-token': 0 } }), run: rows([]), generatedAt: 'now' });
  assert.deepEqual(bare.questions.map(entry => entry.key), ['stack', 'tokens-source', 'name']);
});

test('缺口文件、令牌冲突、素材规模与原生文件各出一问', () => {
  const state = buildQuestions({
    id: 'x',
    runId: 'run-2',
    spec: specOf({
      counts: { 'style-token': 4 },
      totals: totalsOf(210, { image: 200, library: 2, executable: 1 }),
      coverage: { total: 210, missing: 3 },
      conflicts: [{ name: '--accent', values: ['#08e', '#112233'] }],
    }),
    run: rows([
      { kind: 'asset', type: 'image', path: 'a.png' },
      { kind: 'asset', type: 'other', path: 'b.bin', missing: true },
    ]),
    generatedAt: 'now',
  });
  assert.deepEqual(state.questions.map(entry => entry.key), ['stack', 'missing', 'tokens-conflict', 'assets', 'native', 'name']);
  const missing = state.questions.find(entry => entry.key === 'missing');
  assert.equal(missing.question, '有 3 个文件属于静态解析够不到的类型，怎么处理？');
  assert.deepEqual(missing.evidence, ['b.bin']);
  assert.match(state.questions.find(entry => entry.key === 'tokens-conflict').why, /同名令牌/u);
  assert.match(state.questions.find(entry => entry.key === 'native').why, /没有函数级证据/u);
});

test('答案按 key 落回问题，未答的留在 open', () => {
  const state = buildQuestions({
    id: 'x', runId: 'run-3', spec: specOf(), run: rows([]), generatedAt: 't0',
    answers: { stack: { answer: 'React + Vite', at: 't1' } },
  });
  assert.deepEqual(state.open, ['tokens-source', 'name']);
  const stack = state.questions.find(entry => entry.key === 'stack');
  assert.equal(stack.answer, 'React + Vite');
  assert.equal(stack.answeredAt, 't1');

  const next = applyAnswer(state, { key: 'name', answer: '  琥珀工坊  ', at: 't2' });
  assert.deepEqual(next.open, ['tokens-source']);
  assert.equal(next.answers.name.answer, '琥珀工坊');
  assert.equal(next.questions.find(entry => entry.key === 'name').answeredAt, 't2');
  assert.equal(next.generatedAt, 't0', '回答只改答案，不改生成时间');
});

test('回答拒绝未知 key、空答案与超长答案', () => {
  const state = buildQuestions({ id: 'x', runId: 'r', spec: specOf(), run: rows([]), generatedAt: 't0' });
  assert.throws(() => applyAnswer(state, { key: 'nope', answer: 'x', at: 't1' }), error => {
    assert.equal(error.kind, 'invalid-input');
    assert.match(error.message, /没有这个问题：nope/u);
    assert.match(error.message, /stack、tokens-source、name/u);
    return true;
  });
  assert.throws(() => applyAnswer(state, { key: 'name', answer: '   ', at: 't1' }), /答案不能是空的/u);
  assert.throws(() => applyAnswer(state, { key: 'name', answer: 'x'.repeat(2001), at: 't1' }), /答案超过 2000 字/u);
});

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-questions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [sourceRoot, archiveRoot] = ['source', 'archive'].map(name => join(root, name));
  await Promise.all([mkdir(sourceRoot), mkdir(archiveRoot)]);
  return { sourceRoot, archiveRoot, service: projectService(Config({ sourceRoot, archiveRoot, reaPath: join(root, 'missing.mjs') })) };
}

async function site(sourceRoot) {
  await mkdir(join(sourceRoot, 'site'));
  await writeFile(join(sourceRoot, 'site/index.html'), '<!doctype html>\n<a href="/docs">Docs</a>\n<img src="hero.png">');
  await writeFile(join(sourceRoot, 'site/app.css'), ':root { --accent: #112233; }');
  await writeFile(join(sourceRoot, 'site/hero.png'), Buffer.from([1, 2]));
}

test('问题清单与报告落在档案根，重跑沿用同批次答案', async t => {
  const { sourceRoot, archiveRoot, service } = await setup(t);
  await site(sourceRoot);
  const target = await service.add({ kind: 'local', location: 'site' });
  const run = await service.dissect({ id: target.id });

  const first = await service.questions({ id: target.id, runId: run.runId });
  assert.equal(first.file, join(archiveRoot, target.id, 'questions.json'));
  assert.equal(first.runId, run.runId);
  assert.deepEqual(first.questions.map(entry => entry.key), ['stack', 'name']);
  assert.equal(first.answered, 0);
  assert.equal(first.open, 2);
  assert.equal(first.note, undefined);
  const onDisk = JSON.parse(await readFile(first.file, 'utf8'));
  assert.equal(onDisk.schemaVersion, 1);

  const answered = await service.answer({ id: target.id, questionId: 'stack', answer: '静态 HTML + CSS' });
  assert.equal(answered.total, 2);
  assert.equal(answered.answered, 1);
  assert.deepEqual(answered.open, ['name']);

  const again = await service.questions({ id: target.id, runId: run.runId });
  assert.equal(again.answered, 1, '同批次重新生成要沿用答案');
  assert.equal(again.questions.find(entry => entry.key === 'stack').answer, '静态 HTML + CSS');

  const report = await service.report({ id: target.id, runId: run.runId });
  assert.equal(report.file, join(archiveRoot, target.id, 'report.md'));
  assert.equal(report.runId, run.runId);
  assert.equal(report.open, 1);
  const text = await readFile(report.file, 'utf8');
  assert.match(text, /^# 逆向报告 · site/u);
  for (const heading of ['## 1 结论', '## 2 目标与素材', '## 3 技术栈判断', '## 4 证据规模', '## 5 结构与页面', '## 6 边界与缺口', '## 7 访谈（已答 1 \/ 共 2）', '## 8 复刻路线与当前状态', '## 口径']) {
    assert.ok(text.includes(heading), `报告缺少 ${heading}`);
  }
  assert.match(text, /目标程序没有运行/u);
  assert.match(text, /这是推断，不是观测/u);
  assert.match(text, /`scaffold` 只把证据素材/u);
  assert.doesNotMatch(text, /[A-Za-z]:\\/u);
});

test('换批次不沿用上一批答案，缺清单时回答与报告都拒绝', async t => {
  const { sourceRoot, service } = await setup(t);
  await site(sourceRoot);
  const target = await service.add({ kind: 'local', location: 'site' });
  const run = await service.dissect({ id: target.id });
  await service.questions({ id: target.id, runId: run.runId });
  await service.answer({ id: target.id, questionId: 'stack', answer: '静态 HTML + CSS' });

  await writeFile(join(sourceRoot, 'site/index.html'), '<!doctype html>\n<p>v2</p>');
  const next = await service.dissect({ id: target.id });
  const swapped = await service.questions({ id: target.id, runId: next.runId });
  assert.equal(swapped.answered, 0);
  assert.match(swapped.note, /换了批次/u);

  const other = await service.add({ kind: 'local', location: 'site' });
  await assert.rejects(() => service.answer({ id: other.id, questionId: 'stack', answer: 'x' }), /还没有问题清单/u);
  const otherRun = await service.dissect({ id: other.id });
  const fallback = await service.report({ id: other.id, runId: otherRun.runId });
  assert.equal(fallback.open > 0, true, '没有清单时报告现算一份，问题仍记为未答');
});