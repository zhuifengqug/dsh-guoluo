import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { Config } from '../index.js';
import { projectService } from '../lib/projects.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-mock-'));
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
  await writeFile(join(site, 'index.html'), '<!doctype html>\n<a href="/docs">Docs</a>\n<img src="hero.png">\n<img src="https://cdn.test/x.png">\n');
  await writeFile(join(site, 'theme.css'), ':root {\n  --accent: #09f;\n}');
  await writeFile(join(site, 'hero.png'), Buffer.from([7, 7, 7, 7]));
  const target = await context.service.add({ kind: 'local', location: 'site' });
  const run = await context.service.dissect({ id: target.id });
  return { ...context, id: target.id, run };
}

test('mock 只回放已观测的路由与素材', async t => {
  const { id, run, service, archiveRoot } = await fixture(t);
  const result = await service.mock({ id, port: 8123 });
  assert.equal(result.runId, run.runId);
  assert.equal(result.port, 8123);
  assert.equal(result.routes, 1);
  assert.equal(result.assets, 1);
  assert.equal(result.unreplayed, 1);
  assert.match(result.start, /^node ".+server\.mjs"$/u);
  const config = JSON.parse(await readFile(join(archiveRoot, id, 'mock/mock.json'), 'utf8'));
  assert.deepEqual(config.routes.map(route => route.path), ['/docs']);
  assert.match(config.routes[0].html, /没有观测到页面内容/u);
  assert.deepEqual(config.assets.map(asset => asset.path), ['/hero.png']);
  assert.equal(config.assets[0].relative, 'hero.png');
  assert.equal(config.unreplayed[0].reason, '外部来源，不代发请求');
  await assert.rejects(service.mock({ id, port: 80 }), /1024–65535/u);
});

test('生成的 mock 服务能应答路由、素材与未知路径', async t => {
  const { id, service, archiveRoot } = await fixture(t);
  await service.mock({ id, port: 8124 });
  process.env.GUOLUO_MOCK_LISTEN = '0';
  const { server } = await import(pathToFileURL(join(archiveRoot, id, 'mock/server.mjs')).href);
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const route = await fetch(`${base}/docs?x=1`);
  assert.equal(route.status, 200);
  assert.match(await route.text(), /\/docs/u);
  const asset = await fetch(`${base}/hero.png`);
  assert.equal(asset.status, 200);
  assert.deepEqual([...Buffer.from(await asset.arrayBuffer())], [7, 7, 7, 7]);
  const missing = await fetch(`${base}/never-observed`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error, 'not-observed');
});

test('覆盖度核对通过自洽证据，冲突单独列为待决', async t => {
  const { id, service } = await fixture(t);
  const clean = await service.check({ id });
  assert.equal(clean.verdict, 'complete');
  assert.equal(clean.orphans, 0);
  assert.equal(clean.dangling, 0);
  assert.equal(clean.stale, false);
});

test('同名令牌多值让核对停在待决', async t => {
  const context = await setup(t);
  const site = join(context.sourceRoot, 'site');
  await mkdir(site);
  await writeFile(join(site, 'theme.css'), ':root {\n  --accent: #09f;\n  --accent: #08e;\n}');
  const target = await context.service.add({ kind: 'local', location: 'site' });
  await context.service.dissect({ id: target.id });
  const result = await context.service.check({ id: target.id });
  assert.equal(result.verdict, 'needs-decision');
  assert.equal(result.conflicts, 1);
});

test('规格与最新批次不一致时 fail-closed', async t => {
  const { id, service, sourceRoot } = await fixture(t);
  await service.spec({ id });
  await writeFile(join(sourceRoot, 'site/extra.css'), ':root { --extra: 2px; }');
  await service.dissect({ id });
  const result = await service.check({ id });
  assert.equal(result.stale, true);
  assert.equal(result.verdict, 'blocked');
});
