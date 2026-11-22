import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectService } from '../lib/projects.mjs';
import { analyzeStructure, renderStructureReport, reportLimits } from '../lib/structure.mjs';

const page = `<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><div id="hero" class="wrap"><a href="/docs">docs</a><a href="#top">top</a><img src="hero.png"></div></body></html>`;
const css = ':root{--accent:#112233}\n';

const render = (detail, extra = {}) => renderStructureReport({
  id: '00000000-0000-4000-8000-000000000000',
  label: '演示站点',
  runId: '1700000000000-00000000-0000-4000-8000-000000000000',
  directory: 'candidate',
  detail,
  createdAt: '2026-11-22T00:00:00.000Z',
  ...extra,
});

test('结构报告：按页面分组，缺的选择器、链接、标签与深度逐条列在页标题下', () => {
  const built = page
    .replace(' id="hero"', ' id="banner"')
    .replace(' class="wrap"', '')
    .replace('href="/docs"', 'href="/guide"')
    .replace('<img src="hero.png">', '');
  const detail = analyzeStructure({ evidence: [{ path: 'index.html', text: page }], candidate: [{ path: 'index.html', text: built }] });
  const markdown = render(detail);
  assert.match(markdown, /^# 结构核对报告/mu);
  assert.match(markdown, /\| 结构结论 \| 有 \d+ 项对不上 \|/u);
  assert.match(markdown, /## 对不上的页面（1）/u);
  assert.match(markdown, /### 1\. `index\.html` → `index\.html`/u);
  assert.match(markdown, /- 缺失选择器（2）：`#hero`、`\.wrap`/u);
  assert.match(markdown, /- 缺失链接目标（1）：`\/docs`/u);
  assert.match(markdown, /- 标签数量不足（1）：`img` 证据 1 \/ 候选 0/u);
  // 总览表把四维的数字摊开。
  assert.match(markdown, /\| 页面 \| 1 \| 1 \| 0 \|/u);
  assert.match(markdown, /\| 选择器 \| 2 \| 0 \| 2 \|/u);
  assert.match(markdown, /\| 链接目标 \| 1 \| 0 \| 1 \|/u);
  // 报告只复述静态事实，不承诺样式与行为等价。
  assert.match(markdown, /不执行脚本、不建布局、不匹配 CSS 选择器/u);
  assert.match(markdown, /未核页面不计失败，也不代表一致/u);
});

test('结构报告：四项都对得上时明说一致，并把对得上的页面列出来', () => {
  const detail = analyzeStructure({ evidence: [{ path: 'index.html', text: page }], candidate: [{ path: 'index.html', text: page }] });
  const markdown = render(detail);
  assert.match(markdown, /\| 结构结论 \| 四项均对得上 \|/u);
  assert.match(markdown, /没有对不上的页面/u);
  assert.match(markdown, /## 对得上的页面（1）/u);
  assert.match(markdown, /- `index\.html` → `index\.html`/u);
});

test('结构报告：未核页面、缺失证据页与候选多出的生成页各成一段', () => {
  const detail = analyzeStructure({
    evidence: [
      { path: 'index.html', text: page },
      { path: 'gone.html', text: page },
      { path: 'broken.html', reason: '跳过大于 524288 字节的文件或非普通文件。' },
    ],
    candidate: [
      { path: 'index.html', text: page },
      { path: 'broken.html', text: page },
      { path: '_scaffold/index.html', text: '<html><body><a href="index.html">i</a></body></html>' },
    ],
  });
  const markdown = render(detail);
  assert.match(markdown, /## 未核页面（1）/u);
  assert.match(markdown, /- `broken\.html` — 证据页：跳过大于/u);
  assert.match(markdown, /## 候选里找不到的证据页（1）/u);
  assert.match(markdown, /## 候选多出的页面（1）/u);
  assert.match(markdown, /- `_scaffold\/index\.html`（生成物）/u);
});

test('结构报告：单节条目超过上限时列出前若干条并注明余量', () => {
  const many = Array.from({ length: reportLimits.perSection + 7 }, (_, index) => `<div class="c${index}"></div>`).join('');
  const detail = analyzeStructure({
    evidence: [{ path: 'index.html', text: `<html><body>${many}</body></html>` }],
    candidate: [{ path: 'index.html', text: '<html><body></body></html>' }],
  });
  const markdown = render(detail);
  assert.match(markdown, new RegExp(`缺失选择器（${reportLimits.perSection + 7}）`, 'u'));
  assert.match(markdown, /…另有 7 项未列出/u);
});

test('结构报告：check 与 JSON 回执同目录落一份 md，回执里有路径且 JSON 不带完整清单', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-report-'));
  const source = join(dir, 'source');
  const archive = join(dir, 'archive');
  for (const path of [join(source, 'site'), join(source, 'exact'), archive]) await mkdir(path, { recursive: true });
  await writeFile(join(source, 'site', 'index.html'), page);
  await writeFile(join(source, 'site', 'app.css'), css);
  await writeFile(join(source, 'exact', 'index.html'), page.replace(' id="hero"', ' id="banner"'));
  await writeFile(join(source, 'exact', 'app.css'), css);
  const service = projectService({ sourceRoot: source, archiveRoot: archive });
  try {
    const { id } = await service.add({ kind: 'local', location: 'site' });
    const { runId } = await service.dissect({ id, rea: false });
    const result = await service.check({ id, runId, candidate: { directory: 'exact' } });
    assert.equal(result.candidate.verdict, 'partial');
    assert.match(result.candidate.report, /\.md$/u);
    assert.equal(result.candidate.report, result.file.replace(/\.json$/u, '.md'));
    const markdown = await readFile(result.candidate.report, 'utf8');
    assert.match(markdown, /^# 结构核对报告/mu);
    assert.match(markdown, /- 缺失选择器（1）：`#hero`/u);
    // 完整清单只喂给报告，不落进 JSON 回执。
    const stored = JSON.parse(await readFile(result.file, 'utf8'));
    assert.equal(stored.candidate.report.endsWith('.md'), true);
    assert.equal('structureDetail' in stored.candidate, false);
    assert.equal(stored.candidate.structure.selectors.missing.count, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
