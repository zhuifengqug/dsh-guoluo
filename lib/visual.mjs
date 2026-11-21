import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { localPath, readBounded, relativeInput } from './paths.mjs';
import { comparePng } from './png.mjs';
import { captureWebScreenshot, compareWebScreenshots, listBrowserTargets } from './rea.mjs';

export const widths = Object.freeze([390, 768, 1440]);
export const height = 900;
export const maxRoutes = 16;
const maxVisualBudgetMs = 840_000;
// 留出入口检查、浏览器与静态服务清理、报告落盘的时间。
export const checkTimeoutMs = maxVisualBudgetMs + 60_000;
const routePrefix = index => `r${index}`;

// 结论里的阈值口径必须与本次实际传入的阈值一致，0 与非 0 的措辞不同。
export function thresholdNote(channelThreshold) {
  return channelThreshold === 0
    ? '本分数按逐通道 0 阈值计算，含抗锯齿差异'
    : `本分数按逐通道 ${channelThreshold} 阈值计算`;
}

function readRoutes({ baseline, candidate, routes }) {
  const list = routes ?? (baseline || candidate ? [{ baseline, candidate }] : null);
  if (!Array.isArray(list)) throw new Error('视觉核对需要 baseline/candidate 或 routes 数组。');
  if (list.length < 1 || list.length > maxRoutes) throw new Error(`视觉路由须为 1–${maxRoutes} 条。`);
  const seen = new Set();
  return list.map((route, position) => {
    if (!route || typeof route !== 'object') throw new Error(`视觉路由 ${position + 1} 须为对象。`);
    const index = route.index ?? position + 1;
    if (!Number.isInteger(index) || index < 1 || index > 4096) throw new Error('视觉路由序号须为正整数。');
    if (seen.has(index)) throw new Error(`视觉路由序号 ${index} 重复。`);
    seen.add(index);
    for (const side of ['baseline', 'candidate']) {
      const input = route[side];
      if (typeof input?.root !== 'string' || typeof input?.entry !== 'string' || typeof input?.sha256 !== 'string') {
        throw new Error(`视觉路由 ${index} 的 ${side} 入口无效。`);
      }
    }
    return {
      index, baseline: route.baseline, candidate: route.candidate,
      baselineEntry: route.baselineEntry ?? route.baseline.entry, candidateEntry: route.candidateEntry ?? route.candidate.entry,
    };
  });
}
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

function describe(error) {
  const code = error?.code ?? error?.cause?.code;
  const message = String(error?.message ?? error);
  return (code && !message.includes(code) ? `${message}（${code}）` : message).slice(0, 4000);
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

export async function comparePages({ baseline, candidate, routes, dir, reaPath, chromiumPath, channelThreshold = 0,
  signal: externalSignal, launch, createBudgetSignal = ms => AbortSignal.timeout(ms) }) {
  if (chromiumPath && !isAbsolute(chromiumPath)) throw new Error('Chromium 路径须为绝对路径。');
  if (!Number.isInteger(channelThreshold) || channelThreshold < 0 || channelThreshold > 255) throw new Error('逐通道阈值须为 0–255 的整数。');
  const planned = readRoutes({ baseline, candidate, routes });
  const note = thresholdNote(channelThreshold);
  externalSignal?.throwIfAborted();
  const budgetMs = Math.min(maxVisualBudgetMs, 85_000 + 90_000 * planned.length);
  const budget = createBudgetSignal(budgetMs);
  const signal = externalSignal ? AbortSignal.any([externalSignal, budget]) : budget;
  const budgetReason = `视觉核对的 ${budgetMs} ms 总预算已用尽。`;
  const newResult = route => ({
    index: route.index, baselineEntry: route.baselineEntry, candidateEntry: route.candidateEntry,
    baselineHtmlSha256: route.baseline.sha256, candidateHtmlSha256: route.candidate.sha256,
    status: 'verified', rounds: [], thresholdNote: note, score: null, worstWidth: null,
  });
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
  const services = new Set();
  const routeResults = [];
  let browser;
  let closing;
  const closeBrowser = () => browser && (closing ??= browser.close());
  const abort = () => { void closeBrowser()?.catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    browser = await open(profile, {
      ...(chromiumPath ? { executablePath: chromiumPath } : { channel: 'chrome' }),
      headless: true, chromiumSandbox: true, javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false,
      viewport: { width: widths[0], height }, deviceScaleFactor: 1, colorScheme: 'light', reducedMotion: 'reduce',
      args: ['--remote-debugging-port=0'], timeout: 15000,
    });
    signal.throwIfAborted();
    const active = await devToolsPort(profile, signal);
    if (!/^\d{1,5}$/u.test(active) || Number(active) < 1 || Number(active) > 65535) throw new Error('隔离浏览器没有分配有效的本机调试端口。');
    const endpoint = `http://${portHost}:${Number(active)}`;
    const page = browser.pages()[0] ?? await browser.newPage();
    let allowedOrigin;
    await browser.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === allowedOrigin ? route.continue() : route.abort();
    });
    for (const route of planned) {
      signal.throwIfAborted();
      const result = newResult(route);
      routeResults.push(result);
      const origins = {};
      try {
        for (const side of ['baseline', 'candidate']) {
          const service = await serveStaticPage(route[side], signal);
          services.add(service);
          origins[side] = service;
        }
        for (const width of widths) {
          signal.throwIfAborted();
          const prefix = `${routePrefix(route.index)}-${width}`;
          const round = { route: route.index, width, height, status: 'verified', thresholdNote: note };
          let failure = null;
          try {
            await page.setViewportSize({ width, height });
            const captures = {};
            for (const [label, side] of [['before', 'baseline'], ['after', 'candidate']]) {
              signal.throwIfAborted();
              const { origin } = origins[side];
              const url = `${origin}${route[side].entry}`;
              allowedOrigin = origin;
              const response = await page.goto(url, { waitUntil: 'load', timeout: 15000 });
              if (response?.status() !== 200 || page.url() !== url) throw new Error(`视觉核对入口未正常加载：r${route.index} ${width} ${label}。`);
              const list = await listBrowserTargets({ reaPath, endpoint, origin, signal });
              const targets = list.normalized_result.targets?.filter(target => target.type === 'page' && target.url === url && target.origin === origin);
              if (targets?.length !== 1 || !/^[a-f0-9]{32}$/iu.test(targets[0].target_id ?? '')) throw new Error('REA 未定位到唯一的隔离页面。');
              const target = targets[0].target_id;
              const evidence = await captureWebScreenshot({ reaPath, endpoint, target, origin, signal });
              const shot = validArtifact({ evidence, target, origin, url, width });
              const artifactFile = `${prefix}-${label}.artifact.json`;
              const file = `${prefix}-${label}.png`;
              await json(dir, artifactFile, shot.artifact);
              await writeFile(join(dir, file), shot.bytes, { flag: 'wx', mode: 0o600 });
              captures[side] = { evidenceId: evidence.evidence_id, sha256: shot.artifact.sha256, bytes: shot.bytes.length, capturedAt: shot.capturedAt, file, artifactFile, raw: shot.bytes };
            }
            const before = captures.baseline;
            const after = captures.candidate;
            round.baseline = stripRaw(before);
            round.candidate = stripRaw(after);
            const evidence = await compareWebScreenshots({ reaPath, before: join(dir, before.artifactFile), after: join(dir, after.artifactFile), channelThreshold, signal });
            const metrics = visualMetrics(evidence, { width, channelThreshold, beforeSha256: before.sha256, afterSha256: after.sha256 });
            const diffFile = `${prefix}-diff.json`;
            await json(dir, diffFile, evidence);
            round.diffFile = diffFile;
            round.rea = { evidenceId: metrics.evidenceId, status: metrics.status, comparedPixels: metrics.comparedPixels,
              changedPixels: metrics.changedPixels, changedRatio: metrics.changedRatio,
              maximumChannelDelta: metrics.maximumChannelDelta, meanAbsoluteChannelDelta: metrics.meanAbsoluteChannelDelta };
            round.changedPixels = metrics.changedPixels;
            round.changedRatio = metrics.changedRatio;
            round.maximumChannelDelta = metrics.maximumChannelDelta;
            round.meanAbsoluteChannelDelta = metrics.meanAbsoluteChannelDelta;
            const computed = comparePng(before.raw, after.raw, { channelThreshold });
            round.computed = { changedPixels: computed.changedPixels, changedRatio: computed.changedRatio,
              maximumChannelDelta: computed.maximumChannelDelta, meanAbsoluteChannelDelta: computed.meanAbsoluteChannelDelta };
            const diffs = [];
            if (computed.changedPixels !== metrics.changedPixels) {
              diffs.push({ field: 'changedPixels', rea: metrics.changedPixels, computed: computed.changedPixels });
            }
            if (computed.maximumChannelDelta !== metrics.maximumChannelDelta) {
              diffs.push({ field: 'maximumChannelDelta', rea: metrics.maximumChannelDelta, computed: computed.maximumChannelDelta });
            }
            if (Math.abs(computed.meanAbsoluteChannelDelta - metrics.meanAbsoluteChannelDelta) > 1e-9) {
              diffs.push({ field: 'meanAbsoluteChannelDelta', rea: metrics.meanAbsoluteChannelDelta, computed: computed.meanAbsoluteChannelDelta });
            }
            if (diffs.length) {
              const [first] = diffs;
              round.status = 'conflict';
              round.conflict = { field: first.field, rea: first.rea, computed: first.computed,
                fields: diffs.map(diff => diff.field), diffs,
                note: `插件独立解码 PNG 复算的差异数值与 REA 差异证据不一致（${diffs.map(diff => diff.field).join('、')}）；本档并列两边数值，不以 REA 数字为结论。` };
            }
            signal.throwIfAborted();
          } catch (error) {
            externalSignal?.throwIfAborted();
            failure = error;
            round.status = 'blocked';
            round.kind = budget.aborted ? 'budget' : error?.code === 'unsupported-png' ? 'unsupported-png'
              : error?.kind === 'invalid-input' ? 'invalid-input' : 'environment';
            round.reason = budget.aborted ? budgetReason : describe(error);
          }
          result.rounds.push(round);
          if (failure) break;
        }
      } catch (error) {
        externalSignal?.throwIfAborted();
        result.status = 'blocked';
        result.kind = budget.aborted ? 'budget' : error?.kind === 'invalid-input' ? 'invalid-input' : 'environment';
        result.reason = budget.aborted ? budgetReason : describe(error);
      } finally {
        for (const service of Object.values(origins)) { services.delete(service); await service.close().catch(() => {}); }
      }
      const resources = Object.values(origins).map(service => service.resources);
      const changed = resources.some(resource => resource.changed);
      const exhausted = resources.some(resource => resource.exhausted);
      if (changed || exhausted) {
        const issues = [changed && '视觉核对期间发现静态素材内容变化。', exhausted && '视觉核对超过静态资源读取预算。'].filter(Boolean);
        const timeLimited = result.kind === 'budget' || result.rounds.some(round => round.kind === 'budget');
        result.status = 'blocked';
        result.kind = timeLimited || exhausted ? 'budget' : 'changed-asset';
        result.reason = [...issues, timeLimited && budgetReason].filter(Boolean).join(' ');
      }
      const blockedRound = result.rounds.find(round => round.status === 'blocked');
      const conflicts = result.rounds.filter(round => round.status === 'conflict');
      if (result.status !== 'blocked') {
        if (blockedRound) {
          result.status = 'blocked';
          result.kind = blockedRound.kind;
          result.reason ??= `r${result.index} 在 ${blockedRound.width} 档 blocked：${blockedRound.reason}`;
        } else if (conflicts.length) {
          result.status = 'conflict';
          result.kind = 'conflict';
          result.reason = `r${result.index} 有 ${conflicts.length} 档的差异数值与插件自算不一致：${conflicts.map(round => round.width).join('、')}。`;
        }
      }
      if (result.status === 'verified' && result.rounds.length === widths.length && result.rounds.every(round => round.status === 'verified')) {
        const worst = result.rounds.reduce((max, round) => round.computed.changedRatio > max.computed.changedRatio ? round : max);
        result.score = Number((1 - worst.computed.changedRatio).toFixed(6));
        result.worstWidth = worst.width;
      }
    }
  } catch (error) {
    externalSignal?.throwIfAborted();
    if (!budget.aborted) throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    for (const service of services) await service.close().catch(() => {});
    services.clear();
    try { await closeBrowser(); }
    finally { await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
  externalSignal?.throwIfAborted();
  for (const route of planned.slice(routeResults.length)) {
    routeResults.push({ ...newResult(route), status: 'blocked', kind: 'budget', reason: `${budgetReason} 本路由未开始测量。` });
  }
  const flat = routeResults.flatMap(result => result.rounds);
  const blockedRoutes = routeResults.filter(result => result.status === 'blocked');
  const conflictRoutes = routeResults.filter(result => result.status === 'conflict');
  const status = blockedRoutes.length || conflictRoutes.length ? 'blocked' : 'measured';
  const kind = status === 'measured' ? null
    : (budget.aborted && blockedRoutes.some(result => result.kind === 'budget') ? 'budget'
      : blockedRoutes.find(result => result.kind !== 'invalid-input')?.kind ?? (blockedRoutes.length ? 'invalid-input' : 'conflict'));
  const reason = status === 'measured' ? null : [
    conflictRoutes.length ? `路由 ${conflictRoutes.map(result => `r${result.index}`).join('、')} 的 REA 差异像素数与插件自算不一致。` : null,
    blockedRoutes.length ? `路由 ${blockedRoutes.map(result => `r${result.index}`).join('、')} 未完成测量：${blockedRoutes.map(result => result.reason ?? result.kind).join('；')}` : null,
  ].filter(Boolean).join(' ') || null;
  return {
    scope: 'static-html-viewport', status, ...(kind ? { kind } : {}), ...(reason ? { reason } : {}),
    widths: [...widths], height, deviceScaleFactor: 1, channelThreshold, thresholdNote: note,
    routes: routeResults, rounds: flat,
    note: '只衡量相同视口内变化像素的比例；禁用脚本和外站请求，不代表动态页面、功能或整体复刻质量。只有三档全部 verified 且静态资源检查通过的路由才发布 score，按 1 − 各档自算变化像素比例的最大值计算。差异像素数、最大通道差值与平均绝对通道差值由插件独立解码 PNG 复算，再与 REA 差异证据逐项交叉核对：三项都必须一致，任一项不符即该档记 conflict 并并列两边数值；比率仍按 changed/pixels 口径核对。',
  };
}

function stripRaw({ raw, ...rest }) { return rest; }