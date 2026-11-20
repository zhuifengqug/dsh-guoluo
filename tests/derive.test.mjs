import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Config } from '../index.js';
import { projectService } from '../lib/projects.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-derive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [sourceRoot, archiveRoot] = ['source', 'archive'].map(name => join(root, name));
  await Promise.all([mkdir(sourceRoot), mkdir(archiveRoot)]);
  const config = { sourceRoot, archiveRoot, reaPath: join(root, 'missing.mjs') };
  return { root, sourceRoot, archiveRoot, config, service: projectService(Config(config)) };
}

async function fixture(t) {
  const context = await setup(t);
  const site = join(context.sourceRoot, 'site');
  await mkdir(site);
  await writeFile(join(site, 'index.html'), '<!doctype html>\n<a href="/docs">Docs</a>\n<a href="/a|b">Pipe</a>\n<img src="hero.png">\n<style>:root{--inline:1px}</style>');
  await writeFile(join(site, 'theme.css'), ':root {\n  --accent: #09f;\n  --accent: #08e;\n  --data: "a,b";\n  background: url(badge.png);\n}');
  await writeFile(join(site, 'badge.png'), Buffer.from([1, 2]));
  await writeFile(join(site, 'hero.png'), Buffer.from([3, 4]));
  const target = await context.service.add({ kind: 'local', location: 'site' });
  const run = await context.service.dissect({ id: target.id });
  return { ...context, id: target.id, run };
}

test('盘点记录耗时与产出量', async t => {
  const { run } = await fixture(t);
  assert.equal(typeof run.meter.durationMs, 'number');
  assert.ok(run.meter.durationMs >= 0);
  assert.equal(run.meter.rows, run.totals.asset + run.totals.token + run.totals.navigation + run.totals.reference);
  assert.equal(typeof run.meter.textBytes, 'number');
});

test('规格带证据绑定、缺口和可读文档', async t => {
  const { id, run, service, archiveRoot } = await fixture(t);
  const result = await service.spec({ id });
  assert.equal(result.runId, run.runId);
  assert.ok(result.obligations > 0);
  const spec = JSON.parse(await readFile(join(archiveRoot, id, 'spec/spec.json'), 'utf8'));
  assert.equal(spec.schemaVersion, 1);
  assert.equal(spec.runId, run.runId);
  for (const entry of spec.obligations) {
    assert.match(entry.id, /^[A-Z]+-/u);
    assert.equal(entry.status, 'declared');
    assert.ok(entry.evidence.length > 0);
    assert.ok(entry.evidence.every(item => typeof item.path === 'string'));
  }
  const route = spec.obligations.find(entry => entry.kind === 'route' && entry.target === '/docs');
  assert.deepEqual(route.evidence, [{ path: 'index.html', line: 2 }]);
  assert.equal(spec.obligations.filter(entry => entry.kind === 'style-token').length, 3);
  assert.equal(spec.conflicts.length, 1);
  assert.equal(spec.conflicts[0].name, '--accent');
  assert.ok(spec.unknowns.some(text => text.includes('选择器作用域')));
  assert.ok(spec.unknowns.some(text => text.includes('未运行目标应用')));
  const markdown = await readFile(join(archiveRoot, id, 'spec/spec.md'), 'utf8');
  assert.match(markdown, /^# 复刻规格/u);
  assert.match(markdown, /## 1 证据范围/u);
  assert.match(markdown, /令牌冲突/u);
  assert.match(markdown, /\/a\\\|b/u);
});

test('令牌导出含原样 CSS、Tailwind 片段与冲突清单', async t => {
  const { id, service, archiveRoot } = await fixture(t);
  const result = await service.tokens({ id });
  assert.equal(result.total, 3);
  assert.equal(result.occurrences, 4);
  assert.equal(result.conflicts, 1);
  const css = await readFile(join(archiveRoot, id, 'tokens/tokens.css'), 'utf8');
  assert.match(css, /^\/\* 蜾蠃/u);
  assert.match(css, /--accent: #08e;/u);
  assert.match(css, /--data: "a,b";/u);
  assert.doesNotMatch(css, /url\(/u);
  const tailwind = await readFile(join(archiveRoot, id, 'tokens/tokens.tailwind.css'), 'utf8');
  assert.match(tailwind, /@theme inline \{/u);
  const json = JSON.parse(await readFile(join(archiveRoot, id, 'tokens/tokens.json'), 'utf8'));
  assert.equal(json.total, 3);
  assert.deepEqual(json.conflicts[0].values, ['#09f', '#08e']);
  assert.ok(json.tokens.every(token => token.sources.every(item => typeof item.line === 'number')));
});

test('清单导出三种格式并正确转义', async t => {
  const { id, service, archiveRoot } = await fixture(t);
  const csv = await service.export({ id, format: 'csv' });
  assert.equal(csv.count > 0, true);
  const text = await readFile(csv.file, 'utf8');
  assert.match(text, /^kind,path,line,name,value\r\n/u);
  assert.match(text, /"""a,b"""/u);
  const scoped = await service.export({ id, format: 'csv', kind: 'navigation' });
  assert.equal(scoped.count, 2);
  assert.match(await readFile(scoped.file, 'utf8'), /\/a\|b/u);
  const markdown = await service.export({ id, format: 'markdown' });
  const md = await readFile(markdown.file, 'utf8');
  assert.match(md, /^# 资产清单/u);
  assert.match(md, /## token（/u);
  const json = await service.export({ id });
  const data = JSON.parse(await readFile(json.file, 'utf8'));
  assert.equal(data.rows.length, csv.count);
  assert.equal(data.runId, json.runId);
  assert.ok(data.coverage && data.totals);
});

test('派生可重复生成且不新增批次，未知批次被拒', async t => {
  const { id, service, archiveRoot } = await fixture(t);
  await service.spec({ id });
  await service.spec({ id });
  const files = await readdir(join(archiveRoot, id, 'spec'));
  assert.deepEqual(files.sort(), ['spec.json', 'spec.md']);
  assert.equal((await service.status({ id })).runCount, 1);
  await assert.rejects(service.spec({ id, runId: '0'.repeat(13) }), /这批证据不存在/u);
  await assert.rejects(service.export({ id, format: 'xml' }), /导出格式/u);
  await assert.rejects(service.tokens({ id, runId: '../../x' }), /这批证据不存在/u);
});
