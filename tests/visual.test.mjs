import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { request } from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { deflateSync } from 'node:zlib';
import { projectService } from '../lib/projects.mjs';
import { comparePng, decodePng } from '../lib/png.mjs';
import { checkTimeoutMs, maxRoutes, thresholdNote } from '../lib/visual.mjs';
import { apply } from '../index.js';
import { comparePages, height, serveStaticPage, visualMetrics, visualPage, widths } from '../lib/visual.mjs';

const execFileAsync = promisify(execFile);
const fakeRea = join(import.meta.dirname, 'fixtures', 'fake-rea-browser.mjs');

// Local PNG encoder for the decoder tests: real IDAT so lib/png.mjs must inflate and
// unfilter exactly like it does for REA captures.
const pngSignature = Buffer.from('89504e470d0a1a0a', 'hex');
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let value = n;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 0);
  return Buffer.concat([head, data, tail]);
}
function encodePng({ width, height: tall, colorType = 6, bitDepth = 8, interlace = 0, color = [0, 0, 0, 255], rowColors, transparentKey }) {
  const channels = colorType === 6 ? 4 : 3;
  const sample = bitDepth === 16 ? 2 : 1;
  const row = 1 + width * channels * sample;
  const raw = Buffer.alloc(row * tall);
  for (let y = 0; y < tall; y += 1) {
    for (let x = 0; x < width; x += 1) {
      for (let c = 0; c < channels; c += 1) {
        const at = y * row + 1 + (x * channels + c) * sample;
        const value = (rowColors?.[x] ?? color)[c];
        raw[at] = value;
        if (sample === 2) raw[at + 1] = value;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(tall, 4);
  ihdr[8] = bitDepth; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = interlace;
  const chunks = [pngSignature, pngChunk('IHDR', ihdr)];
  if (transparentKey) {
    const data = Buffer.alloc(6);
    transparentKey.forEach((value, index) => data.writeUInt16BE(value, index * 2));
    chunks.push(pngChunk('tRNS', data));
  }
  return Buffer.concat([...chunks, pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

async function fixture(t, { launch, rea, createBudgetSignal } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-visual-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const source = join(dir, 'source');
  const archive = join(dir, 'archive');
  for (const path of [join(source, 'original'), join(source, 'candidate'), join(source, 'candidate2'), archive]) await mkdir(path, { recursive: true });
  const original = '<!doctype html><meta charset=utf-8><style>body{margin:0;background:#fff}</style><script>document.body.style.background="black"</script>';
  const candidate = `${original}<style>@media(max-width:600px){body{background:#000}}</style>`;
  await writeFile(join(source, 'original', 'index.html'), original);
  await writeFile(join(source, 'original', 'about.html'), `${original}<h1>about</h1>`);
  await writeFile(join(source, 'candidate', 'index.html'), candidate);
  await writeFile(join(source, 'candidate', 'about.html'), `${candidate}<h1>about</h1>`);
  await writeFile(join(source, 'candidate2', 'index.html'), `${original}<h1>other</h1>`);
  await writeFile(join(source, 'candidate2', 'about.html'), `${original}<h1>other about</h1>`);
  const service = projectService({ sourceRoot: source, archiveRoot: archive, chromiumPath: process.env.GUOLUO_TEST_CHROMIUM, reaPath: rea ?? process.env.GUOLUO_TEST_REA, launch, createBudgetSignal });
  const { id } = await service.add({ kind: 'local', location: 'original' });
  const { runId } = await service.dissect({ id, rea: false });
  return { id, runId, service, source, archive };
}

// A fake browser that answers /__state so the fake REA can bind to the served viewport.
async function fakeLaunch(profileDir, { afterGoto } = {}) {
  const { createServer } = await import('node:http');
  const state = { url: '', origin: '', width: 0, height: 0, targetId: 'A'.repeat(32) };
  let closed = false;
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(state)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(join(profileDir, 'DevToolsActivePort'), `${server.address().port}\n`);
  const page = {
    setViewportSize: async ({ width, height: tall }) => { state.width = width; state.height = tall; },
    goto: async url => {
      const response = await fetch(url);
      await response.arrayBuffer();
      state.url = url;
      state.origin = new URL(url).origin;
      await afterGoto?.(state);
      return { status: () => response.status };
    },
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

test('外部取消会清理项目检查目录内已写入的半成品', async t => {
  const controller = new AbortController();
  const reason = new Error('取消视觉核对');
  let handle;
  let hadArtifacts = false;
  const launch = async profile => {
    handle = await fakeLaunch(profile, { afterGoto: async ({ width }) => {
      if (width === widths[1]) {
        hadArtifacts = (await readdir(join(profile, '..'))).includes('r1-390-diff.json');
        controller.abort(reason);
      }
    } });
    return handle;
  };
  const { id, runId, service, archive } = await fixture(t, { launch, rea: fakeRea });
  await assert.rejects(service.check({ id, runId, visual: { candidateDirectory: 'candidate' } }, controller.signal), error => error === reason);
  assert.equal(hadArtifacts, true);
  assert.equal(handle.closed, true);
  assert.deepEqual(await readdir(join(archive, id, 'checks')), []);
});

test('总预算截断时保留已验证路由，在途与未开始路由标为 budget 并落盘', async t => {
  const budget = new AbortController();
  let limit;
  let handle;
  const launch = async profile => {
    let aboutLoads = 0;
    handle = await fakeLaunch(profile, { afterGoto: ({ url }) => {
      if (new URL(url).pathname === '/about.html' && ++aboutLoads === 2) budget.abort();
    } });
    return handle;
  };
  const { id, runId, service } = await fixture(t, { launch, rea: fakeRea, createBudgetSignal: ms => { limit = ms; return budget.signal; } });
  const { visual } = await service.check({ id, runId, visual: { candidateDirectory: 'candidate', routes: [
    {}, { baselineEntry: 'about.html' }, { baselineEntry: 'index.html', candidateEntry: 'about.html' }, { baselineEntry: 'ghost.html' },
  ] } });
  assert.equal(visual.status, 'blocked');
  assert.equal(visual.kind, 'budget');
  assert.deepEqual(visual.routes.map(route => route.kind ?? route.status), ['verified', 'budget', 'budget', 'invalid-input']);
  assert.deepEqual(visual.routes[0].rounds.map(round => round.status), ['verified', 'verified', 'verified']);
  assert.equal(visual.routes[0].score, 0);
  assert.deepEqual(visual.routes[1].rounds.map(round => round.kind), ['budget']);
  assert.equal(visual.routes[1].score, null);
  assert.deepEqual(visual.routes[2].rounds, []);
  assert.match(visual.routes[2].reason, /未开始测量/u);
  assert.equal(limit, 355_000);
  assert.equal(handle.closed, true);
  assert(!(await readdir(visual.directory)).includes('browser'));
  const saved = JSON.parse(await readFile(join(visual.directory, 'summary.json'), 'utf8'));
  assert.deepEqual(saved.routes.map(route => route.kind ?? route.status), ['verified', 'budget', 'budget', 'invalid-input']);
  assert.equal(saved.routes[0].score, 0);
});

test('check 注册的宿主超时覆盖最大视觉预算并留出清理时间', async t => {
  const registered = new Map();
  const register = tool => registered.set(tool.name, tool);
  apply({ effect: callback => callback(), tools: { register }, skills: { register }, commands: { register } });
  let maxBudget;
  const { source } = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-visual-budget-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const baseline = await visualPage(join(source, 'original'), 'index.html');
  const candidate = await visualPage(join(source, 'candidate'), 'index.html');
  const result = await comparePages({ routes: Array.from({ length: maxRoutes }, () => ({ baseline, candidate })), dir, reaPath: fakeRea,
    createBudgetSignal: ms => { maxBudget = ms; return AbortSignal.abort(); } });
  assert.equal(result.routes.length, maxRoutes);
  assert.ok(result.routes.every(route => route.kind === 'budget' && route.score === null));
  assert.equal(registered.get('guoluo_check').timeoutMs, checkTimeoutMs);
  assert.equal(checkTimeoutMs - maxBudget, 60_000);
  assert.deepEqual(await readdir(dir), []);
});

test('素材变化和静态读取预算耗尽各自封锁路由分数', async t => {
  const { source } = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-visual-resources-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const original = join(source, 'original');
  const candidateRoot = join(source, 'candidate');
  const css = join(original, 'app.css');
  await writeFile(css, 'body { color: black }');
  await writeFile(join(candidateRoot, 'budget.css'), Buffer.alloc(8 * 1024 * 1024 + 1));
  const routes = [
    { baseline: await visualPage(original, 'index.html'), candidate: await visualPage(candidateRoot, 'index.html') },
    { baseline: await visualPage(original, 'about.html'), candidate: await visualPage(candidateRoot, 'about.html') },
  ];
  const responses = [];
  const launch = profile => fakeLaunch(profile, { afterGoto: async ({ url, origin, width }) => {
    if (new URL(url).pathname === '/index.html') {
      const response = await fetch(`${origin}/app.css`);
      await response.arrayBuffer();
      responses.push(response.status);
      if (width === widths[0]) await writeFile(css, 'body { color: red }');
    } else {
      const response = await fetch(`${origin}/budget.css`);
      await response.arrayBuffer();
      responses.push(response.status);
    }
  } });
  const { status, routes: results } = await comparePages({ routes, dir, reaPath: fakeRea, launch });
  assert.equal(status, 'blocked');
  assert.ok(responses.includes(429));
  assert.deepEqual(results.map(route => route.kind), ['changed-asset', 'budget']);
  for (const route of results) {
    assert.equal(route.score, null);
    assert.equal(route.worstWidth, null);
    assert.deepEqual(route.rounds.map(round => round.status), ['verified', 'verified', 'verified']);
  }
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
  assert.equal(files.length, 16);
  assert(!files.includes('browser'));
  assert.deepEqual(JSON.parse(await readFile(result.file, 'utf8')).visual, visual);
});

test('PNG 解码器独立展开 RGB/RGBA，并只统计逐通道差值超阈值的像素', () => {
  const rgba = encodePng({ width: 3, height: 2, color: [10, 20, 30, 255] });
  const decoded = decodePng(rgba);
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 2);
  assert.equal(decoded.channels, 4);
  assert.deepEqual([...decoded.pixels.subarray(0, 4)], [10, 20, 30, 255]);
  const rgb = encodePng({ width: 3, height: 2, colorType: 2, color: [10, 20, 30] });
  assert.equal(decodePng(rgb).channels, 3);
  assert.equal(comparePng(rgba, encodePng({ width: 3, height: 2, color: [10, 20, 30, 255] })).changedPixels, 0);
  assert.equal(comparePng(rgb, rgba).changedPixels, 0, 'RGB 按不透明与 RGBA 对齐');
  const shifted = encodePng({ width: 3, height: 2, color: [12, 20, 30, 255] });
  const diff = comparePng(rgba, shifted);
  assert.equal(diff.changedPixels, 6);
  assert.equal(diff.changedRatio, 1);
  assert.equal(diff.maximumChannelDelta, 2);
  assert.equal(diff.meanAbsoluteChannelDelta, 0.5);
  assert.equal(comparePng(rgba, shifted, { channelThreshold: 2 }).changedPixels, 0);
  assert.equal(comparePng(rgba, shifted, { channelThreshold: 1 }).changedPixels, 6);
  assert.throws(() => comparePng(rgba, encodePng({ width: 4, height: 2, color: [10, 20, 30, 255] })), /尺寸不同/u);
});

test('RGB 的 tRNS 透明键只改变匹配样点的 alpha', () => {
  const rgb = encodePng({ width: 2, height: 1, colorType: 2, rowColors: [[10, 20, 30], [10, 20, 31]], transparentKey: [10, 20, 30] });
  const rgba = encodePng({ width: 2, height: 1, rowColors: [[10, 20, 30, 0], [10, 20, 31, 255]] });
  assert.equal(comparePng(rgb, rgba).changedPixels, 0);
  assert.equal(comparePng(rgba, rgb).maximumChannelDelta, 0);
});

test('PNG 拒绝未知关键块与 IEND 后的数据，允许未知辅助块', () => {
  const png = encodePng({ width: 1, height: 1 });
  const withChunk = name => Buffer.concat([png.subarray(0, 33), pngChunk(name, Buffer.alloc(0)), png.subarray(33)]);
  assert.throws(() => decodePng(withChunk('VgLO')), { code: 'unsupported-png' });
  assert.equal(decodePng(withChunk('vgLO')).width, 1);
  assert.throws(() => decodePng(Buffer.concat([png, Buffer.from([0])])), /IEND.*文件末尾/u);
});

test('PNG 解码器对位深、颜色类型、隔行与损坏块明确报不支持', () => {
  const unsupported = pattern => error => error.code === 'unsupported-png' && pattern.test(error.message);
  assert.throws(() => decodePng(encodePng({ width: 2, height: 2, bitDepth: 16 })), unsupported(/16/u));
  assert.throws(() => decodePng(encodePng({ width: 2, height: 2, colorType: 0 })), unsupported(/颜色类型/u));
  assert.throws(() => decodePng(encodePng({ width: 2, height: 2, interlace: 1 })), unsupported(/隔行/u));
  const corrupt = encodePng({ width: 2, height: 2 });
  corrupt[20] ^= 0xff;
  assert.throws(() => decodePng(corrupt), /CRC/u);
  assert.throws(() => decodePng(corrupt.subarray(0, 20)), /截断|越界|签名/u);
  const noData = Buffer.concat([pngSignature, pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])), pngChunk('IEND', Buffer.alloc(0))]);
  assert.throws(() => decodePng(noData), /IDAT/u);
});

test('多路由各按三档测量、文件名带路由序号互不覆盖，并逐路由给出分数', async t => {
  const { source } = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-visual-routes-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const routes = [
    { baseline: await visualPage(join(source, 'original'), 'index.html'), candidate: await visualPage(join(source, 'candidate'), 'index.html') },
    { baseline: await visualPage(join(source, 'original'), 'about.html'), candidate: await visualPage(join(source, 'candidate'), 'about.html') },
  ];
  const measured = await comparePages({ routes, dir, reaPath: fakeRea, channelThreshold: 0, launch: fakeLaunch });
  assert.equal(measured.status, 'measured', measured.reason);
  assert.deepEqual(measured.routes.map(route => route.index), [1, 2]);
  assert.equal(measured.rounds.length, 6);
  for (const route of measured.routes) {
    assert.equal(route.rounds.length, 3);
    assert.equal(route.status, 'verified');
    assert.deepEqual(route.rounds.map(round => round.width), widths);
    assert.equal(route.score, Number((1 - Math.max(...route.rounds.map(round => round.computed.changedRatio))).toFixed(6)));
    assert.ok(widths.includes(route.worstWidth));
    for (const round of route.rounds) {
      assert.equal(round.status, 'verified');
      assert.equal(round.route, route.index);
      assert.equal(round.computed.changedPixels, round.rea.changedPixels);
      assert.equal(round.computed.changedRatio, round.changedPixels / (round.width * height));
      assert.notEqual(round.status, 'conflict', JSON.stringify(round.conflict));
    }
  }
  const files = await readdir(dir);
  assert.equal(files.length, 30);
  for (const prefix of ['r1', 'r2']) {
    const owned = files.filter(file => file.startsWith(`${prefix}-`));
    assert.equal(owned.length, 15, `${prefix} 的落盘文件数`);
    assert.equal(new Set(owned).size, 15);
    assert(owned.some(file => file === `${prefix}-390-before.png`));
    assert(owned.some(file => file === `${prefix}-1440-diff.json`));
  }
  assert(!files.includes('browser'));
});

test('篡改 REA 差异数字时该档记 conflict 并并列两边数值，其它路由结果保留', async t => {
  const { source } = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-visual-conflict-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const routes = [
    { baseline: await visualPage(join(source, 'original'), 'index.html'), candidate: await visualPage(join(source, 'candidate'), 'index.html') },
    { baseline: await visualPage(join(source, 'original'), 'about.html'), candidate: await visualPage(join(source, 'candidate2'), 'about.html') },
  ];
  const previous = process.env.GUOLUO_FAKE_FORCE_CHANGED;
  process.env.GUOLUO_FAKE_FORCE_CHANGED = '1';
  let measured;
  try {
    measured = await comparePages({ routes, dir, reaPath: fakeRea, channelThreshold: 0, launch: fakeLaunch });
  } finally {
    if (previous === undefined) delete process.env.GUOLUO_FAKE_FORCE_CHANGED;
    else process.env.GUOLUO_FAKE_FORCE_CHANGED = previous;
  }
  assert.equal(measured.status, 'blocked');
  assert.equal(measured.kind, 'conflict');
  assert.equal(measured.routes.length, 2, '冲突不丢其它路由');
  for (const round of measured.rounds) {
    assert.equal(round.status, 'conflict');
    assert.equal(round.conflict.field, 'changedPixels');
    assert.equal(round.conflict.rea, 1);
    assert.equal(round.conflict.computed, round.width * height);
    assert.match(round.conflict.note, /不以 REA 数字为结论/u);
    assert.equal(round.changedPixels, 1, '结论字段保留 REA 数字但不改自算值');
    assert.equal(round.computed.changedPixels, round.width * height);
  }
  assert.equal(measured.routes[0].status, 'conflict');
  assert.equal(measured.routes[1].status, 'conflict');
  assert.ok(measured.routes.every(route => route.score === null && route.worstWidth === null));
  assert.match(measured.reason, /不一致/u);
});

test('REA 的平均或峰值通道差值与自算不符时同样记 conflict', async t => {
  const { source } = await fixture(t);
  for (const [env, field] of [['GUOLUO_FAKE_FORCE_MEAN', 'meanAbsoluteChannelDelta'], ['GUOLUO_FAKE_FORCE_PEAK', 'maximumChannelDelta']]) {
    const dir = await mkdtemp(join(tmpdir(), 'guoluo-visual-extra-'));
    t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
    const previous = process.env[env];
    process.env[env] = '1';
    let measured;
    try {
      measured = await comparePages({ baseline: await visualPage(join(source, 'original'), 'index.html'),
        candidate: await visualPage(join(source, 'candidate'), 'index.html'), dir, reaPath: fakeRea, channelThreshold: 0, launch: fakeLaunch });
    } finally {
      if (previous === undefined) delete process.env[env];
      else process.env[env] = previous;
    }
    const round = measured.rounds[0];
    assert.equal(round.status, 'conflict', `${env} 应触发冲突`);
    assert.equal(round.conflict.field, field);
    assert.deepEqual(round.conflict.fields, [field]);
    assert.equal(round.conflict.computed, round.computed[field]);
    assert.equal(measured.status, 'blocked');
    assert.equal(measured.routes[0].score, null);
  }
});

test('非 8 位 PNG 让该档 blocked 并标记 unsupported-png，不再猜数值', async t => {
  const { source } = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-visual-depth-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const previous = process.env.GUOLUO_FAKE_PNG_DEPTH;
  process.env.GUOLUO_FAKE_PNG_DEPTH = '16';
  let measured;
  try {
    measured = await comparePages({ baseline: await visualPage(join(source, 'original'), 'index.html'),
      candidate: await visualPage(join(source, 'candidate'), 'index.html'), dir, reaPath: fakeRea, channelThreshold: 0, launch: fakeLaunch });
  } finally {
    if (previous === undefined) delete process.env.GUOLUO_FAKE_PNG_DEPTH;
    else process.env.GUOLUO_FAKE_PNG_DEPTH = previous;
  }
  assert.equal(measured.status, 'blocked');
  assert.equal(measured.kind, 'unsupported-png');
  assert.equal(measured.rounds.length, 1, 'blocked 后不再继续猜后面的档位');
  const round = measured.rounds[0];
  assert.equal(round.status, 'blocked');
  assert.equal(round.kind, 'unsupported-png');
  assert.match(round.reason, /8 位/u);
  assert.equal(round.computed, undefined);
  assert.equal(round.conflict, undefined);
});

test('阈值非 0 时结论写逐通道 N 阈值而不是谎称 0', async t => {
  const { source } = await fixture(t);
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-visual-threshold-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const previous = process.env.GUOLUO_FAKE_SAME_IMAGE;
  process.env.GUOLUO_FAKE_SAME_IMAGE = '1';
  let measured;
  try {
    measured = await comparePages({ baseline: await visualPage(join(source, 'original'), 'index.html'),
      candidate: await visualPage(join(source, 'candidate'), 'index.html'), dir, reaPath: fakeRea, channelThreshold: 3, launch: fakeLaunch });
  } finally {
    if (previous === undefined) delete process.env.GUOLUO_FAKE_SAME_IMAGE;
    else process.env.GUOLUO_FAKE_SAME_IMAGE = previous;
  }
  assert.equal(thresholdNote(0), '本分数按逐通道 0 阈值计算，含抗锯齿差异');
  assert.equal(thresholdNote(3), '本分数按逐通道 3 阈值计算');
  assert.equal(measured.status, 'measured', measured.reason);
  assert.equal(measured.channelThreshold, 3);
  assert.equal(measured.thresholdNote, '本分数按逐通道 3 阈值计算');
  assert.doesNotMatch(measured.thresholdNote, /0 阈值/u);
  for (const round of measured.rounds) {
    assert.equal(round.status, 'verified');
    assert.equal(round.thresholdNote, measured.thresholdNote);
    assert.equal(round.changedPixels, 0);
    assert.equal(round.computed.changedPixels, 0);
  }
});

test('服务层多路由把逐路由状态、自算与 REA 对照及阈值口径写进返回体和 summary.json', async t => {
  const { id, runId, service } = await fixture(t, { launch: fakeLaunch, rea: fakeRea });
  const report = await service.check({ id, runId, visual: { candidateDirectory: 'candidate',
    routes: [{ baselineEntry: 'index.html' }, { baselineEntry: 'about.html', candidateEntry: 'about.html' }] } });
  const visual = report.visual;
  assert.equal(visual.status, 'measured', visual.reason);
  assert.equal(visual.routes.length, 2);
  assert.equal(visual.rounds.length, 6);
  assert.equal(visual.thresholdNote, '本分数按逐通道 0 阈值计算，含抗锯齿差异');
  const summary = JSON.parse(await readFile(join(visual.directory, 'summary.json'), 'utf8'));
  assert.equal(summary.thresholdNote, visual.thresholdNote);
  assert.deepEqual(summary.routes.map(route => route.index), [1, 2]);
  assert.equal(summary.routes[0].rounds.length, 3);
  for (const route of summary.routes) {
    for (const round of route.rounds) {
      assert.equal(round.computed.changedPixels, round.rea.changedPixels);
      assert.equal(round.conflict, null);
    }
  }
  assert.deepEqual(JSON.parse(await readFile(report.file, 'utf8')).visual.routes, visual.routes);
});

test('服务层拒绝超过 16 条路由与 routes/单入口混用', async t => {
  const { id, runId, service } = await fixture(t);
  const routes = Array.from({ length: maxRoutes + 1 }, () => ({ baselineEntry: 'index.html' }));
  const tooMany = await service.check({ id, runId, visual: { candidateDirectory: 'candidate', routes } });
  assert.equal(tooMany.visual.status, 'blocked');
  assert.equal(tooMany.visual.kind, 'invalid-input');
  assert.match(tooMany.visual.reason, /最多 16 条/u);
  const mixed = await service.check({ id, runId, visual: { candidateDirectory: 'candidate', baselineEntry: 'index.html', routes: [{ baselineEntry: 'index.html' }] } });
  assert.equal(mixed.visual.kind, 'invalid-input');
  assert.match(mixed.visual.reason, /不能同时给出/u);
});

test('假 REA 支持成对的多样本比较，每对输出一行证据', async t => {
  const { createHash } = await import('node:crypto');
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-fake-rea-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5 }));
  const ink = encodePng({ width: 2, height: 2, color: [1, 2, 3, 255] });
  const other = encodePng({ width: 2, height: 2, color: [9, 9, 9, 255] });
  const write = async (name, bytes) => {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    await writeFile(join(dir, name), JSON.stringify({ sha256, data_base64: bytes.toString('base64') }));
    return join(dir, name);
  };
  const files = [await write('a1.json', ink), await write('a2.json', ink), await write('b1.json', ink), await write('b2.json', other)];
  const { stdout } = await execFileAsync(process.execPath, [fakeRea, 'compare-web-screenshots', ...files, '--channel-threshold', '0', '--format', 'json']);
  const rows = stdout.trim().split('\n').map(line => JSON.parse(line)).filter(row => row.operation === 'compare_web_screenshots');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].normalized_result.changed_pixels, 0);
  assert.equal(rows[1].normalized_result.changed_pixels, 4);
  assert.equal(rows[1].normalized_result.changed_ratio, 1);
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
