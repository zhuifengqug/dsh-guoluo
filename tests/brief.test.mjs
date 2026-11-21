import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Config } from '../index.js';
import { projectService } from '../lib/projects.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-brief-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [sourceRoot, archiveRoot] = ['source', 'archive'].map(name => join(root, name));
  await Promise.all([mkdir(sourceRoot), mkdir(archiveRoot)]);
  return { root, sourceRoot, archiveRoot, service: projectService(Config({ sourceRoot, archiveRoot, reaPath: join(root, 'missing.mjs') })) };
}

async function site(sourceRoot) {
  await mkdir(join(sourceRoot, 'site'));
  await writeFile(join(sourceRoot, 'site/index.html'), '<!doctype html>\n<a href="/docs">Docs</a>\n<img src="hero.png">');
  await writeFile(join(sourceRoot, 'site/docs.html'), '<!doctype html>\n<p>docs</p>');
  await writeFile(join(sourceRoot, 'site/app.css'), ':root { --accent: #112233; }');
  await writeFile(join(sourceRoot, 'site/hero.png'), Buffer.from([1, 2]));
}

test('交接单绑定指定批次，优先列出入门页面并只写档案', async t => {
  const { sourceRoot, service } = await setup(t);
  await site(sourceRoot);
  const target = await service.add({ kind: 'local', location: 'site' });
  const run = await service.dissect({ id: target.id });
  const brief = await service.brief({ id: target.id, runId: run.runId });
  assert.equal(brief.runId, run.runId);
  assert.match(brief.file, /brief[\\/][^\\/]+\.md$/u);
  const text = await readFile(brief.file, 'utf8');
  assert.match(text, /^# 蜾蠃复刻交接单/u);
  assert.match(text, new RegExp(`盘点批次：${run.runId}`, 'u'));
  const entries = text.split('## 优先核对的 HTML 入口候选')[1].split('\n## ')[0];
  assert.ok(entries.includes('index.html'));
  if (entries.includes('docs.html')) assert.ok(entries.indexOf('index.html') < entries.indexOf('docs.html'));
  assert.match(text, /--accent/u);
  assert.match(text, /## 证据缺口与待确认/u);
  assert.match(text, /## 验收顺序/u);
  assert.match(text, /guoluo_check/u);
  assert.doesNotMatch(text, /[A-Za-z]:\\/u);
  const again = await service.brief({ id: target.id, runId: run.runId });
  assert.equal(again.bytes, brief.bytes);
});

test('交接单把多值令牌标为待确认', async t => {
  const { sourceRoot, service } = await setup(t);
  await site(sourceRoot);
  await writeFile(join(sourceRoot, 'site/alt.css'), ':root { --accent: #445566; }');
  const target = await service.add({ kind: 'local', location: 'site' });
  const run = await service.dissect({ id: target.id });
  const brief = await service.brief({ id: target.id, runId: run.runId });
  assert.match(await readFile(brief.file, 'utf8'), /存在多个声明值，待确认/u);
});

test('交接单拒绝缺失、格式错误或对不上的批次', async t => {
  const { sourceRoot, service } = await setup(t);
  await site(sourceRoot);
  const target = await service.add({ kind: 'local', location: 'site' });
  await assert.rejects(service.brief({ id: target.id }), error => error.kind === 'invalid-input');
  await assert.rejects(service.brief({ id: target.id, runId: 'latest' }), /runId/u);
  await assert.rejects(service.brief({ id: target.id, runId: '2024010100000-00000000-0000-4000-8000-000000000000' }), /这批证据不存在/u);
});
