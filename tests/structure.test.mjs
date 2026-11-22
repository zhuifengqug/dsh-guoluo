import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectService } from '../lib/projects.mjs';
import { compareStructure, profileHtml } from '../lib/structure.mjs';

const page = `<!doctype html><html><head><link rel="stylesheet" href="app.css"><style>:root{--accent:#112233}</style></head><body><div id="hero" class="wrap"><a href="/docs">docs</a><a href="#top">top</a><img src="hero.png"></div></body></html>`;
const css = ':root{--accent:#112233}\n';

const run = (evidence, candidate) => compareStructure({ evidence: [{ path: 'index.html', text: evidence }], candidate: [{ path: 'index.html', text: candidate }] });

test('结构比对：同一份页面判为对得上，链接里的锚点与空目标不进比较', () => {
  const result = run(page, page);
  assert.equal(result.scope, 'candidate-structure');
  assert.equal(result.comparedPages, 1);
  assert.equal(result.pages.total, 1);
  assert.equal(result.pages.matched, 1);
  assert.equal(result.pages.missing.count, 0);
  assert.deepEqual(result.selectors.missing.items, []);
  assert.equal(result.selectors.total, 2);
  assert.equal(result.selectors.present, 2);
  assert.equal(result.navigation.total, 1);
  assert.equal(result.navigation.present, 1);
  assert.equal(result.navigation.skipped, 1);
  assert.deepEqual(result.hierarchy.tags.items, []);
  assert.deepEqual(result.hierarchy.edges.items, []);
  assert.deepEqual(result.hierarchy.depths.items, []);
  assert.equal(result.unverified.count, 0);
  assert.equal(result.diverged, false);
  assert.equal(result.missingCount, 0);
});

test('结构比对：缺 id/class 选择器逐条点名，判为分叉', () => {
  const built = page.replace(' id="hero"', '').replace(' class="wrap"', ' class="shell"');
  const result = run(page, built);
  assert.equal(result.diverged, true);
  assert.deepEqual(result.selectors.missing.items, [
    { path: 'index.html', selector: '#hero' },
    { path: 'index.html', selector: '.wrap' },
  ]);
  assert.equal(result.selectors.missing.count, 2);
  // 多出来的选择器不算缺口。
  assert.equal(result.selectors.present, 0);
});

test('结构比对：导航目标按 href 原文比较，改了就点名', () => {
  const built = page.replace('href="/docs"', 'href="/guide"');
  const result = run(page, built);
  assert.deepEqual(result.navigation.missing.items, [{ path: 'index.html', target: '/docs' }]);
  assert.equal(result.navigation.present, 0);
  assert.equal(result.diverged, true);
});

test('结构比对：标签层级不同时，多出来的标签、父子边与深度分布逐条列出', () => {
  const evidence = '<html><body><div id="a"><span class="x"></span></div></body></html>';
  const candidate = '<html><body><div id="a"><p class="x"></p></div></body></html>';
  const result = run(evidence, candidate);
  assert.deepEqual(result.hierarchy.tags.items, [{ path: 'index.html', tag: 'span', archive: 1, built: 0 }]);
  assert.deepEqual(result.hierarchy.edges.items, [{ path: 'index.html', edge: 'div>span' }]);
  assert.equal(result.hierarchy.tags.count, 1);
  assert.equal(result.diverged, true);
});

test('结构比对：证据页读不到时记 unverified，不计失败', () => {
  const result = compareStructure({
    evidence: [{ path: 'index.html', reason: '跳过大于 524288 字节的文件或非普通文件。' }],
    candidate: [{ path: 'index.html', text: page }],
  });
  assert.equal(result.diverged, false);
  assert.equal(result.missingCount, 0);
  assert.equal(result.comparedPages, 0);
  assert.equal(result.unverified.count, 1);
  assert.match(result.unverified.items[0].reason, /跳过大于/u);
  assert.equal(result.pages.matched, 0);
});

test('结构比对：节点超过静态解析预算记 truncated 与 unverified，不硬造失败', () => {
  const deep = `<html><body>${'<div>'.repeat(4200)}${'</div>'.repeat(4200)}</body></html>`;
  const profile = profileHtml({ path: 'index.html', text: deep });
  assert.equal(profile.truncated, true);
  const result = run(deep, page);
  assert.equal(result.diverged, false);
  assert.equal(result.unverified.count, 1);
  assert.match(result.unverified.items[0].reason, /节点超过/u);
});

test('结构比对：候选多出的页面只进 extra，生成的 _scaffold 页不判失败', () => {
  const result = compareStructure({
    evidence: [{ path: 'index.html', text: page }],
    candidate: [{ path: 'index.html', text: page }, { path: '_scaffold/index.html', text: '<html><body><a href="index.html">i</a></body></html>' }],
  });
  assert.equal(result.diverged, false);
  assert.equal(result.pages.extra.count, 1);
  assert.deepEqual(result.pages.extra.items, [{ path: '_scaffold/index.html', generated: true }]);
});

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-structure-'));
  const source = join(dir, 'source');
  const archive = join(dir, 'archive');
  for (const path of [join(source, 'site'), join(source, 'exact'), archive]) await mkdir(path, { recursive: true });
  await writeFile(join(source, 'site', 'index.html'), page);
  await writeFile(join(source, 'site', 'app.css'), css);
  const service = projectService({ sourceRoot: source, archiveRoot: archive });
  const { id } = await service.add({ kind: 'local', location: 'site' });
  const { runId } = await service.dissect({ id, rea: false });
  return { dir, id, runId, service, source };
}

test('候选核对：结构一致时 complete，且令牌层结果照旧保留', async () => {
  const { dir, id, runId, service, source } = await scratch();
  try {
    // 候选照 scaffold 的产物形状落盘：复制页 + 生成的 _scaffold/index.html 与 tokens.css。
    await writeFile(join(source, 'exact', 'index.html'), page);
    await writeFile(join(source, 'exact', 'app.css'), css);
    await mkdir(join(source, 'exact', '_scaffold'), { recursive: true });
    await writeFile(join(source, 'exact', '_scaffold', 'index.html'), '<html><body><a href="index.html">i</a></body></html>');
    await writeFile(join(source, 'exact', '_scaffold', 'tokens.css'), css);
    const result = await service.check({ id, runId, candidate: { directory: 'exact' } });
    const coverage = result.candidate;
    assert.equal(coverage.verdict, 'complete');
    assert.equal(coverage.structure.scope, 'candidate-structure');
    assert.equal(coverage.structure.comparedPages, 1);
    assert.equal(coverage.structure.diverged, false);
    assert.equal(coverage.structure.pages.extra.count, 1);
    assert.deepEqual(coverage.tokens.declared.map(item => item.target), ['--accent']);
    assert.equal(coverage.values.checked, 1);
    assert.equal(coverage.values.same, 1);
    assert.match(coverage.note, /结构上也与证据页对得上/u);
    assert.match(coverage.note, /更不说明目标已被复刻/u);
    assert.ok(coverage.unchecked.some(item => /结构维度只比页面清单/u.test(item)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('候选核对：选择器缺失把 verdict 拉到 partial，文件层结论不变', async () => {
  const { dir, id, runId, service, source } = await scratch();
  try {
    await writeFile(join(source, 'exact', 'index.html'), page.replace(' id="hero"', ' id="banner"'));
    await writeFile(join(source, 'exact', 'app.css'), css);
    const result = await service.check({ id, runId, candidate: { directory: 'exact' } });
    const coverage = result.candidate;
    assert.equal(coverage.verdict, 'partial');
    // 文件层：样式指纹一致，页面因为改了 id 落在 changed；结构层单独点名选择器。
    assert.deepEqual(coverage.assets.present.map(item => item.target), ['app.css']);
    assert.deepEqual(coverage.assets.changed.map(item => item.target), ['index.html']);
    assert.deepEqual(coverage.assets.missing, []);
    assert.equal(coverage.structure.selectors.missing.count, 1);
    assert.match(coverage.note, /结构维度另有 1 项对不上/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('工程骨架：生成时就用同一套结构维度回核，闭环不留空话', async () => {
  const { dir, id, runId, service } = await scratch();
  try {
    const result = await service.scaffold({ id, runId, name: 'closed-loop' });
    assert.equal(result.coverage.verdict, 'complete');
    assert.equal(result.coverage.structure.comparedPages, 1);
    assert.equal(result.coverage.structure.diverged, false);
    assert.equal(result.coverage.structure.selectors.present, 2);
    assert.equal(result.coverage.structure.navigation.present, 1);
    assert.equal(result.coverage.structure.unverified, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
