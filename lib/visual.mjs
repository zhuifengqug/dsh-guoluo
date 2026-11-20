import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { localPath, readBounded, relativeInput } from './paths.mjs';
import { captureWebScreenshot, compareWebScreenshots, listBrowserTargets } from './rea.mjs';

export const widths = Object.freeze([390, 768, 1440]);
export const height = 900;
const portHost = '127.0.0.1';
const maxFileBytes = 8 * 1024 * 1024;
const mime = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.avif': 'image/avif', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf',
}));
const csp = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const json = (dir, name, data) => writeFile(join(dir, name), JSON.stringify(data), { flag: 'wx', mode: 0o600 });

export async function visualPage(root, entry, expectedSha256, signal) {
  const parts = relativeInput(entry);
  if (!['.html', '.htm'].includes(extname(parts.at(-1)).toLowerCase())) throw new Error('视觉核对入口须为本地 HTML 文件。');
  const { path, stat } = await localPath(root, parts);
  if (!stat.isFile()) throw new Error('视觉核对入口不是普通文件。');
  const sha256 = createHash('sha256').update(await readBounded(path, maxFileBytes, signal)).digest('hex');
  if (expectedSha256 && sha256 !== expectedSha256) throw new Error('基准 HTML 与本次盘点的指纹不同，请重新盘点。');
  return { root, entry: `/${parts.map(encodeURIComponent).join('/')}`, sha256 };
}

export async function serveStaticPage({ root, entry, sha256 }, signal) {
  let origin;
  let requests = 0;
  let inFlight = 0;
  let servedBytes = 0;
  let exhausted = false;
  let changed = false;
  let skipped = 0;
  const fingerprints = new Map();
  const server = createServer(async (request, response) => {
    const headers = { 'content-security-policy': csp, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' };
    if (++requests > 1024 || inFlight >= 16) {
      exhausted = true;
      response.writeHead(429, headers);
      response.end();
      return;
    }
    inFlight += 1;
    try {
      signal?.throwIfAborted();
      if (request.method !== 'GET' || request.headers.host !== new URL(origin).host || !request.url?.startsWith('/') || request.url.startsWith('//')) throw new Error();
      const url = new URL(request.url, origin);
      const parts = relativeInput(url.pathname.slice(1).split('/').map(decodeURIComponent).map(part => {
        if (/[\\/]/u.test(part)) throw new Error();
        return part;
      }).join('/'));
      const media = mime.get(extname(parts.at(-1)).toLowerCase());
      if (!media) throw new Error();
      const { path, stat } = await localPath(root, parts);
      if (!stat.isFile()) throw new Error();
      if (stat.size > maxFileBytes || servedBytes + stat.size > 64 * 1024 * 1024) {
        exhausted = true;
        response.writeHead(429, headers);
        response.end();
        return;
      }
      servedBytes += stat.size;
      const data = await readBounded(path, stat.size, signal);
      const digest = createHash('sha256').update(data).digest('hex');
      const key = parts.join('/');
      const previous = url.pathname === entry ? sha256 : fingerprints.get(key);
      if (previous && previous !== digest) { changed = true; throw new Error(); }
      fingerprints.set(key, digest);
      response.writeHead(200, { ...headers, 'content-type': media });
      response.end(data);
    } catch {
      if (request.url !== '/favicon.ico') skipped += 1;
      response.writeHead(404, headers);
      response.end();
    } finally { inFlight -= 1; }
  });
  server.requestTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, portHost, () => { server.removeListener('error', reject); resolve(); });
  });
  origin = `http://${portHost}:${server.address().port}`;
  return { origin, get resources() { return { exhausted, changed, skipped, uniqueFiles: fingerprints.size, servedBytes }; },
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

function validArtifact({ evidence, target, origin, url, width }) {
  const shot = evidence.normalized_result;
  const artifact = shot.artifact;
  if (shot.target?.target_id !== target || shot.target?.origin !== origin || shot.target?.url !== url ||
      shot.viewport?.width !== width || shot.viewport?.height !== height || shot.completeness?.status !== 'complete_within_window') {
    throw new Error('REA 截图没有绑定到预期页面或完整视口。');
  }
  if (artifact?.media_type !== 'image/png' || typeof artifact.data_base64 !== 'string' || artifact.data_base64.length > Math.ceil(maxFileBytes / 3) * 4) {
    throw new Error('REA 截图格式或大小不受支持。');
  }
  const bytes = Buffer.from(artifact.data_base64, 'base64');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (bytes.length < 24 || bytes.length > maxFileBytes || bytes.toString('base64') !== artifact.data_base64 ||
      bytes.length !== artifact.bytes || sha256 !== artifact.sha256 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' ||
      bytes.toString('ascii', 12, 16) !== 'IHDR' || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) {
    throw new Error('REA PNG 哈希、字节数或尺寸校验失败。');
  }
  return { artifact: { media_type: 'image/png', bytes: bytes.length, sha256, data_base64: artifact.data_base64 }, bytes, capturedAt: shot.captured_at ?? null };
}

export function visualMetrics(evidence, { width, channelThreshold, beforeSha256, afterSha256 }) {
  const diff = evidence.normalized_result;
  const pixels = width * height;
  const changed = diff.changed_pixels;
  const peak = diff.maximum_channel_delta;
  const mean = diff.mean_absolute_channel_delta;
  const fraction = changed / pixels;
  if (evidence.parameters?.before_artifact_sha256 !== beforeSha256 || evidence.parameters?.after_artifact_sha256 !== afterSha256 ||
      diff.before?.width !== width || diff.before?.height !== height || diff.after?.width !== width || diff.after?.height !== height ||
      diff.channel_threshold !== channelThreshold || diff.compared_pixels !== pixels ||
      !Number.isSafeInteger(changed) || changed < 0 || changed > pixels || !Number.isFinite(diff.changed_ratio) ||
      diff.changed_ratio < 0 || diff.changed_ratio > 1 || Math.abs(diff.changed_ratio - fraction) > 1e-9 ||
      diff.status !== (changed ? 'different' : 'identical') || !Number.isInteger(peak) || peak < 0 || peak > 255 ||
      (changed > 0) !== (peak > channelThreshold) || !Number.isFinite(mean) || mean < 0 || mean > peak) {
    throw new Error('REA 差异证据与截图指纹、尺寸或像素计数不符。');
  }
  return { evidenceId: evidence.evidence_id, status: diff.status, comparedPixels: pixels, changedPixels: changed, changedRatio: fraction,
    maximumChannelDelta: peak, meanAbsoluteChannelDelta: mean };
}

async function devToolsPort(profile, signal) {
  const file = join(profile, 'DevToolsActivePort');
  for (let tries = 0; ; tries += 1) {
    signal?.throwIfAborted();
    try { return (await readFile(file, { encoding: 'utf8', signal })).split(/\r?\n/u)[0]; }
    catch (error) {
      if (error.code !== 'ENOENT' || tries >= 9) throw error;
      await delay(100, undefined, { signal });
    }
  }
}

export async function comparePages({ baseline, candidate, dir, reaPath, chromiumPath, channelThreshold, signal, launch }) {
  if (chromiumPath && !isAbsolute(chromiumPath)) throw new Error('Chromium 路径须为绝对路径。');
  if (!Number.isInteger(channelThreshold) || channelThreshold < 0 || channelThreshold > 255) throw new Error('逐通道阈值须为 0–255 的整数。');
  signal?.throwIfAborted();
  const budget = AbortSignal.timeout(175000);
  signal = signal ? AbortSignal.any([signal, budget]) : budget;
  const open = launch ?? (async (profileDir, options) => {
    const { chromium } = await import('playwright-core');
    try { return await chromium.launchPersistentContext(profileDir, options); }
    catch (error) {
      if (options.executablePath) throw error;
      return chromium.launchPersistentContext(profileDir, { ...options, channel: 'msedge' });
    }
  });
  const profile = join(dir, 'browser');
  await mkdir(profile, { mode: 0o700 });
  const origins = new Map();
  const rounds = [];
  let browser;
  const abort = () => { void browser?.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    for (const [side, input] of Object.entries({ baseline, candidate })) origins.set(side, await serveStaticPage(input, signal));
    signal?.throwIfAborted();
    browser = await open(profile, {
      ...(chromiumPath ? { executablePath: chromiumPath } : { channel: 'chrome' }),
      headless: true, chromiumSandbox: true, javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false,
      viewport: { width: widths[0], height }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce',
      args: ['--remote-debugging-port=0'], timeout: 15000,
    });
    signal?.throwIfAborted();
    const active = await devToolsPort(profile, signal);
    if (!/^\d{1,5}$/u.test(active) || Number(active) < 1 || Number(active) > 65535) throw new Error('隔离浏览器没有分配有效的本机调试端口。');
    const endpoint = `http://${portHost}:${Number(active)}`;
    const page = browser.pages()[0] ?? await browser.newPage();
    let allowedOrigin;
    await browser.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === allowedOrigin ? route.continue() : route.abort();
    });
    for (const width of widths) {
      await page.setViewportSize({ width, height });
      const captures = {};
      for (const [side, input] of Object.entries({ baseline, candidate })) {
        signal?.throwIfAborted();
        const { origin } = origins.get(side);
        allowedOrigin = origin;
        const url = `${origin}${input.entry}`;
        const response = await page.goto(url, { waitUntil: 'load', timeout: 15000 });
        if (response?.status() !== 200 || page.url() !== url) throw new Error(`视觉核对入口未正常加载：${side}。`);
        const list = await listBrowserTargets({ reaPath, endpoint, origin, signal });
        const targets = list.normalized_result.targets?.filter(target => target.type === 'page' && target.url === url && target.origin === origin);
        if (targets?.length !== 1 || !/^[a-f0-9]{32}$/iu.test(targets[0].target_id ?? '')) throw new Error('REA 未定位到唯一的隔离页面。');
        const target = targets[0].target_id;
        const evidence = await captureWebScreenshot({ reaPath, endpoint, target, origin, signal });
        const shot = validArtifact({ evidence, target, origin, url, width });
        const artifactFile = `${width}-${side}.artifact.json`;
        const file = `${width}-${side}.png`;
        await json(dir, artifactFile, shot.artifact);
        await writeFile(join(dir, file), shot.bytes, { flag: 'wx', mode: 0o600 });
        captures[side] = { evidenceId: evidence.evidence_id, sha256: shot.artifact.sha256, bytes: shot.bytes.length, capturedAt: shot.capturedAt, file, artifactFile };
      }
      const before = captures.baseline;
      const after = captures.candidate;
      const evidence = await compareWebScreenshots({ reaPath, before: join(dir, before.artifactFile), after: join(dir, after.artifactFile), channelThreshold, signal });
      const metrics = visualMetrics(evidence, { width, channelThreshold, beforeSha256: before.sha256, afterSha256: after.sha256 });
      await json(dir, `${width}-diff.json`, evidence);
      rounds.push({ width, height, ...metrics, ...captures, diffFile: `${width}-diff.json` });
    }
    if ([...origins.values()].some(service => service.exhausted)) throw new Error('视觉核对超过静态资源读取预算。');
    signal?.throwIfAborted();
    return { scope: 'static-html-viewport', status: 'measured', widths: [...widths], height, deviceScaleFactor: 1, channelThreshold, rounds,
      note: '只衡量相同视口内变化像素的比例；禁用脚本和外站请求，不代表动态页面、功能或整体复刻质量。差异像素数由 REA 计算，本插件只校验其与本次截图指纹、尺寸和代数关系的自洽性，未独立复算像素。' };
  } finally {
    signal?.removeEventListener('abort', abort);
    try { await browser?.close(); }
    finally {
      await Promise.all([...origins.values()].map(service => service.close()));
      await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}
