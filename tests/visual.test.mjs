import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectService } from '../lib/projects.mjs';
import { comparePages, height, serveStaticPage, visualMetrics, visualPage, widths } from '../lib/visual.mjs';

const fakeRea = join(import.meta.dirname, 'fixtures', 'fake-rea-browser.mjs');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-visual-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const source = join(dir, 'source');
  const archive = join(dir, 'archive');
  for (const path of [join(source, 'original'), join(source, 'candidate'), archive]) await mkdir(path, { recursive: true });
  const original = '<!doctype html><meta charset=utf-8><style>body{margin:0;background:#fff}</style><script>document.body.style.background="black"</script>';
  const candidate = `${original}<style>@media(max-width:600px){body{background:#000}}</style>`;
  await writeFile(join(source, 'original', 'index.html'), original);
  await writeFile(join(source, 'candidate', 'index.html'), candidate);
  const service = projectService({ sourceRoot: source, archiveRoot: archive, chromiumPath: process.env.GUOLUO_TEST_CHROMIUM, reaPath: process.env.GUOLUO_TEST_REA });
  const { id } = await service.add({ kind: 'local', location: 'original' });
  const { runId } = await service.dissect({ id, rea: false });
  return { id, runId, service, source };
}

// A fake browser that answers /__state so the fake REA can bind to the served viewport.
async function fakeLaunch(profileDir) {
  const { createServer } = await import('node:http');
  const state = { url: '', origin: '', width: 0, height: 0, targetId: 'A'.repeat(32) };
  let closed = false;
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(state)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(join(profileDir, 'DevToolsActivePort'), `${server.address().port}\n`);
  const page = {
    setViewportSize: async ({ width, height: tall }) => { state.width = width; state.height = tall; },
    goto: async url => { const response = await fetch(url); state.url = url; state.origin = new URL(url).origin; return { status: () => response.status }; },
    url: () => state.url,
  };
  return {
    pages: () => [page],
    newPage: async () => page,
    route: async () => {},
    close: async () => { closed = true; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
    get closed() { return closed; },
  };
}

test('视觉请求不可越过素材根，缺失或未盘点的入口不产生分数', async t => {
  const { id, runId, service } = await fixture(t);
  const plain = await service.check({ id, runId });
  assert.equal(plain.verdict, 'complete');
  assert.equal(plain.visual, undefined);
  for (const visual of [{ candidateDirectory: '../candidate' }, { candidateDirectory: 'candidate', baselineEntry: 'ghost.html' }, { candidateDirectory: 'original' }]) {
    const report = await service.check({ id, runId, visual });
    assert.equal(report.verdict, 'complete');
    assert.equal(report.visual.status, 'blocked');
    assert.equal(report.visual.kind, 'invalid-input', JSON.stringify(report.visual));
    assert.equal(report.visual.rounds, undefined);
    assert.equal(JSON.parse(await readFile(report.file, 'utf8')).visual.status, 'blocked');
  }
});

test('像素投影拒绝虚假的比率、哈希、视口与统计关系', () => {
  const width = 390;
  const size = { width, height };
  const options = { width, channelThreshold: 3, beforeSha256: 'a'.repeat(64), afterSha256: 'b'.repeat(64) };
  const evidence = { evidence_id: 'ev_1', parameters: { before_artifact_sha256: options.beforeSha256, after_artifact_sha256: options.afterSha256 },
    normalized_result: { status: 'identical', before: size, after: size, channel_threshold: 3, compared_pixels: width * height,
      changed_pixels: 0, changed_ratio: 0, maximum_channel_delta: 2, mean_absolute_channel_delta: 1 } };
  assert.equal(visualMetrics(evidence, options).changedRatio, 0);
  assert.throws(() => visualMetrics(evidence, { ...options, beforeSha256: 'c'.repeat(64) }));
  assert.throws(() => visualMetrics(evidence, { ...options, width: 768 }));
  assert.throws(() => visualMetrics({ ...evidence, normalized_result: { ...evidence.normalized_result, changed_ratio: 0.2 } }, options));
  assert.throws(() => visualMetrics({ ...evidence, normalized_result: { ...evidence.normalized_result, before: { width: 768, height } } }, options));
  assert.throws(() => visualMetrics({ ...evidence, normalized_result: { ...evidence.normalized_result, mean_absolute_channel_delta: 9 } }, options));
  assert.throws(() => visualMetrics({ ...evidence, normalized_result: { ...evidence.normalized_result, changed_pixels: 5, changed_ratio: 5 / (width * height), maximum_channel_delta: 1 } }, options));
  const partial = { ...evidence, normalized_result: { ...evidence.normalized_result, status: 'different', changed_pixels: 39, changed_ratio: 39 / (width * height), maximum_channel_delta: 9, mean_absolute_channel_delta: 4 } };
  assert.equal(visualMetrics(partial, options).changedRatio, 39 / (width * height));
});

test('视觉路由拒绝相对 Chromium 路径与越界阈值', async () => {
  const baseline = { root: 'a', entry: '/index.html', sha256: 'a'.repeat(64) };
  const candidate = { root: 'b', entry: '/index.html', sha256: 'b'.repeat(64) };
  await assert.rejects(comparePages({ baseline, candidate, dir: '/tmp/none', reaPath: 'x', channelThreshold: 0, chromiumPath: 'rel/chrome' }), /绝对路径/u);
  await assert.rejects(comparePages({ baseline, candidate, dir: '/tmp/none', reaPath: 'x', channelThreshold: 256 }), /0–255/u);
});

test('本地静态服务拒绝穿越与伪造 Host，并带安全响应头', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-serve-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const root = join(dir, 'root');
  await mkdir(root);
  await writeFile(join(root, 'index.html'), '<h1 id=ok>ok</h1>');
  await writeFile(join(dir, 'secret.txt'), 'secret');
  const page = await visualPage(root, 'index.html');
  const server = await serveStaticPage(page);
  t.after(() => server.close());
  const hit = (path, headers = {}) => new Promise((resolve, reject) => {
    const req = request(`${server.origin}${path}`, { headers }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })); });
    req.on('error', reject); req.end();
  });
  const ok = await hit('/index.html');
  assert.equal(ok.status, 200);
  assert.equal(ok.body, '<h1 id=ok>ok</h1>');
  assert.match(ok.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(ok.headers['x-content-type-options'], 'nosniff');
  assert.equal((await hit('/%2e%2e/secret.txt')).status, 404);
  assert.equal((await hit('/index.html', { host: 'evil.example' })).status, 404);
  assert.equal((await hit('/missing.css')).status, 404);
  await writeFile(join(root, 'index.html'), '<h1>changed</h1>');
  assert.equal((await hit('/index.html')).status, 404);
  assert.equal(server.resources.changed, true);
  assert.equal(server.resources.skipped >= 1, true);
});

test('注入假浏览器即可在整个管线里核对三档视口并落盘 15 个产物', async t => {
  const { source } = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-visual-fake-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const baseline = await visualPage(join(source, 'original'), 'index.html');
  const candidate = await visualPage(join(source, 'candidate'), 'index.html');
  const measured = await comparePages({ baseline, candidate, dir, reaPath: fakeRea, channelThreshold: 0, launch: fakeLaunch });
  assert.equal(measured.status, 'measured');
  assert.deepEqual(measured.widths, widths);
  assert.equal(measured.rounds.length, 3);
  for (const round of measured.rounds) {
    assert.equal(round.changedRatio, round.changedPixels / (round.width * height));
    const png = await readFile(join(dir, round.candidate.file));
    assert.equal(png.readUInt32BE(16), round.width);
    assert.equal(png.readUInt32BE(20), height);
  }
  const files = await readdir(dir);
  assert.equal(files.length, 15);
  assert(!files.includes('browser'));
});

test('取消时关闭浏览器、删除隔离 profile 与半成品目录', async t => {
  const { source } = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-visual-abort-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const baseline = await visualPage(join(source, 'original'), 'index.html');
  const candidate = await visualPage(join(source, 'candidate'), 'index.html');
  let handle;
  const controller = new AbortController();
  const launch = async profileDir => { handle = await fakeLaunch(profileDir); controller.abort(); return handle; };
  await assert.rejects(comparePages({ baseline, candidate, dir, reaPath: fakeRea, channelThreshold: 0, launch, signal: controller.signal }));
  assert.equal(handle.closed, true);
  const left = await readdir(dir).catch(() => []);
  assert(!left.includes('browser'));
});

test('真实 REA 在三档视口记录差异、哈希和可复查的 PNG', { skip: !process.env.GUOLUO_TEST_REA, timeout: 120000 }, async t => {
  const { id, runId, service } = await fixture(t);
  const result = await service.check({ id, runId, visual: { candidateDirectory: 'candidate' } });
  const visual = result.visual;
  assert.equal(visual.status, 'measured', visual.reason);
  assert.deepEqual(visual.widths, widths);
  assert.deepEqual(visual.rounds.map(round => round.changedRatio), [1, 0, 0]);
  for (const round of visual.rounds) {
    const diff = JSON.parse(await readFile(join(visual.directory, round.diffFile), 'utf8'));
    assert.equal(diff.parameters.after_artifact_sha256, round.candidate.sha256);
    const png = await readFile(join(visual.directory, round.candidate.file));
    assert.equal(png.readUInt32BE(16), round.width);
    assert.equal(png.readUInt32BE(20), height);
  }
  const files = await readdir(visual.directory);
  assert.equal(files.length, 15);
  assert(!files.includes('browser'));
  assert.deepEqual(JSON.parse(await readFile(result.file, 'utf8')).visual, visual);
});

test('真实 REA 给出部分差异时保留非 0/1 的比例', { skip: !process.env.GUOLUO_TEST_REA, timeout: 120000 }, async t => {
  const { id, runId, service, source } = await fixture(t);
  const patch = `${await readFile(join(source, 'original', 'index.html'), 'utf8')}<style>@media(max-width:600px){body::before{content:'';position:fixed;top:0;left:0;width:10px;height:10px;background:#000}}</style>`;
  await writeFile(join(source, 'candidate', 'index.html'), patch);
  const visual = (await service.check({ id, runId, visual: { candidateDirectory: 'candidate' } })).visual;
  assert.equal(visual.status, 'measured', visual.reason);
  const ratio = visual.rounds[0].changedRatio;
  assert(ratio > 0 && ratio < 1, `期望部分差异，实际 ${ratio}`);
  assert.equal(visual.rounds[1].changedRatio, 0);
  assert.equal(visual.rounds[2].changedRatio, 0);
});
