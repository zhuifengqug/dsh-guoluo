import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Config } from '../index.js';
import { projectService } from '../lib/projects.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [sourceRoot, archiveRoot] = ['source', 'archive'].map(name => join(root, name));
  await Promise.all([mkdir(sourceRoot), mkdir(archiveRoot)]);
  const service = projectService(Config({ sourceRoot, archiveRoot, reaPath: join(root, 'missing.mjs') }));
  return { root, sourceRoot, archiveRoot, service };
}

const pageHtml = `<!doctype html>
<html lang="zh-CN">
  <head><title>示例站</title><script src="app.js"></script></head>
  <body class="page">
    <h1 id="hero" class="title">欢迎</h1>
    <a href="/pricing" class="cta">价格</a>
    <img src="hero.png" alt="主图">
  </body>
</html>`;

async function site(t) {
  const context = await setup(t);
  const folder = join(context.sourceRoot, 'site');
  await mkdir(folder);
  await writeFile(join(folder, 'index.html'), pageHtml);
  await writeFile(join(folder, 'theme.css'), ':root {\n  --accent: #08e;\n}');
  await writeFile(join(folder, 'hero.png'), Buffer.from([4, 5, 6, 7]));
  const target = await context.service.add({ kind: 'local', location: 'site' });
  const run = await context.service.dissect({ id: target.id });
  return { ...context, folder, id: target.id, run };
}

test('生成工程：结构重排、素材原样落位、令牌单独成表、脚本不搬', async t => {
  const { id, run, service, archiveRoot, folder } = await site(t);
  const result = await service.build({ id });
  assert.equal(result.runId, run.runId);
  assert.equal(result.adapter, 'static-html');
  assert.match(result.directory, new RegExp(`^${id}/build/\\d{13}-[0-9a-f-]{36}$`, 'u'));
  assert.equal(result.counts.pages, 1);
  // 素材只数非页面文件：页面进 pages，样式与图片进 assets。
  assert.equal(result.counts.assets, 2);
  assert.equal(result.counts.scriptsRemoved, 1);
  assert.equal(result.structure.diverged, false);
  assert.equal(result.selfCheck, 'self');

  const directory = join(archiveRoot, id, 'build', result.directory.split('/').at(-1));
  const built = await readFile(join(directory, 'index.html'), 'utf8');
  assert.match(built, /<h1 id="hero" class="title">/u);
  assert.match(built, /<a href="\/pricing" class="cta"/u);
  assert.match(built, /<link rel="stylesheet" href="\.\/styles\/project\.css">/u);
  assert.ok(!built.includes('app.js'), '脚本内容不搬');
  assert.match(built, /<script><\/script>/u);

  // 素材逐字节同一份：这是「素材照抄」，不是重画
  assert.deepEqual(await readFile(join(directory, 'hero.png')), await readFile(join(folder, 'hero.png')));
  assert.deepEqual(await readFile(join(directory, 'theme.css')), await readFile(join(folder, 'theme.css')));
  assert.match(await readFile(join(directory, 'styles/project.css'), 'utf8'), /--accent:\s*#08e/u);

  const manifest = JSON.parse(await readFile(join(directory, 'project.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.kind, 'guoluo-build');
  assert.equal(manifest.adapter, 'static-html');
  assert.equal(manifest.runId, run.runId);
  assert.equal(manifest.entry, 'index.html');
  assert.equal(manifest.selfCheck.diverged, false);
  assert.equal(manifest.selfCheck.comparedPages, 1);
  assert.equal(manifest.tokens, 1);

  const readme = await readFile(join(directory, 'README.md'), 'utf8');
  assert.match(readme, /## 自证/u);
  assert.match(readme, /guoluo_check/u);
  assert.match(readme, /脚本 1 个/u);
});

test('重跑出新批次，旧工程不动', async t => {
  const { id, service, archiveRoot } = await site(t);
  const first = await service.build({ id });
  const second = await service.build({ id, name: '我的站' });
  assert.notEqual(first.directory, second.directory);
  assert.equal(second.name, '我的站');
  const directory = join(archiveRoot, id, 'build');
  const entries = (await readdir(directory)).filter(name => !name.startsWith('.'));
  assert.equal(entries.length, 2);
  const manifest = JSON.parse(await readFile(join(archiveRoot, second.directory, 'project.json'), 'utf8'));
  assert.equal(manifest.name, '我的站');
});

test('没有页面的证据不出工程，并说清为什么', async t => {
  const { service, sourceRoot } = await setup(t);
  const folder = join(sourceRoot, 'media');
  await mkdir(folder);
  await writeFile(join(folder, 'a.png'), Buffer.from([1, 2, 3]));
  const target = await service.add({ kind: 'local', location: 'media' });
  await service.dissect({ id: target.id });
  await assert.rejects(service.build({ id: target.id }), error => {
    assert.equal(error.kind, 'invalid-input');
    assert.match(error.message, /没有 HTML\/CSS 页面/u);
    return true;
  });
});

test('访谈答案参与生成：同批次的答案进 project.json 的缺口说明', async t => {
  const { id, service, archiveRoot } = await site(t);
  const asked = await service.questions({ id });
  assert.ok(asked.total >= 2);
  await service.answer({ id, questionId: 'name', answer: '我的站' });
  const result = await service.build({ id });
  const manifest = JSON.parse(await readFile(join(archiveRoot, result.directory, 'project.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.gaps));
  assert.equal(manifest.name, '我的站');
});