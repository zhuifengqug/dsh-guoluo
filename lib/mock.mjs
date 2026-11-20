const types = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

const contentType = name => types[name.slice(name.lastIndexOf('.')).toLowerCase()] ?? 'application/octet-stream';
const assetPath = relative => `/${String(relative).replace(/\\/gu, '/').replace(/^\/+/u, '')}`;

const placeholder = ({ path, evidence }) => [
  '<!doctype html>',
  '<html lang="zh"><head><meta charset="utf-8">',
  `<title>蜾蠃 mock · ${path}</title>`,
  '</head><body>',
  `<h1>${path}</h1>`,
  '<p>该路由来自静态链接，没有观测到页面内容。蜾蠃只回放证据，不臆造结构。</p>',
  `<p>证据：<code>${evidence}</code></p>`,
  '</body></html>',
  '',
].join('\n');

const playable = path => Boolean(types[path.slice(path.lastIndexOf('.')).toLowerCase()]) && !/\.(?:html?|css)$/iu.test(path);

export function buildMock({ id, runId, run, port }) {
  const rows = run.rows ?? [];
  const routes = [];
  const assets = [];
  const unreplayed = [];
  const seenRoute = new Set();
  const seenAsset = new Set();
  for (const row of rows) {
    if (row.kind !== 'asset' || !playable(row.path)) continue;
    const path = assetPath(row.path);
    if (seenAsset.has(path)) continue;
    seenAsset.add(path);
    assets.push({ path, relative: row.path, type: contentType(row.path), evidence: `${row.path}${row.line === undefined ? '' : `:${row.line}`}` });
  }
  for (const row of rows) {
    if (row.kind !== 'navigation' || seenRoute.has(row.value)) continue;
    seenRoute.add(row.value);
    const path = row.value.startsWith('/') ? row.value : `/${row.value}`;
    routes.push({ method: 'GET', path, status: 200, kind: 'placeholder', html: placeholder({ path, evidence: `${row.path}:${row.line}` }), evidence: `${row.path}:${row.line}` });
  }
  for (const row of rows) {
    if (row.kind !== 'reference') continue;
    if (seenAsset.has(assetPath(row.value))) continue;
    unreplayed.push({ value: row.value, evidence: `${row.path}:${row.line}`, reason: row.value.startsWith('http') ? '外部来源，不代发请求' : '相对引用未校验存在性，未回放' });
  }
  routes.sort((left, right) => left.path.localeCompare(right.path));
  assets.sort((left, right) => left.path.localeCompare(right.path));
  unreplayed.sort((left, right) => left.value.localeCompare(right.value));
  return {
    mock: {
      schemaVersion: 1,
      id,
      runId,
      port,
      note: '只回放本批证据里出现的静态链接与素材。页面路由是占位 HTML，不含未观测到的结构；素材按素材根解析，未推断页面基址。',
      routes,
      assets,
      unreplayed,
    },
    counts: { routes: routes.length, assets: assets.length, unreplayed: unreplayed.length },
  };
}

export const server = String.raw`import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const config = JSON.parse(await readFile(join(here, 'mock.json'), 'utf8'));
const port = Number(process.env.PORT ?? config.port ?? 5173);
const fold = process.platform === 'win32' ? value => value.toLowerCase() : value => value;

function inside(root, target) {
  const base = fold(resolve(root));
  const full = fold(resolve(target));
  return full === base || full.startsWith(base + sep);
}

const assets = new Map(config.assets.map(item => [item.path, item]));
const routes = new Map(config.routes.map(item => [item.path, item]));
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm',
};

function send(response, status, type, body) {
  response.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  response.end(body);
}

const server = createServer(async (request, response) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://127.0.0.1').pathname); }
  catch { return send(response, 400, 'text/plain; charset=utf-8', 'bad request'); }
  const asset = assets.get(pathname);
  if (asset) {
    const file = join(asset.root, asset.relative);
    if (!inside(asset.root, file)) return send(response, 403, 'text/plain; charset=utf-8', 'forbidden');
    try {
      const body = await readFile(file);
      return send(response, 200, types[extname(file).toLowerCase()] ?? asset.type ?? 'application/octet-stream', body);
    } catch {
      return send(response, 404, 'text/plain; charset=utf-8', 'asset missing');
    }
  }
  const route = routes.get(pathname);
  if (route) return send(response, route.status ?? 200, 'text/html; charset=utf-8', route.html ?? '');
  return send(response, 404, 'application/json; charset=utf-8', JSON.stringify({ error: 'not-observed', path: pathname, note: '蜾蠃 mock 只回放已观测到的路由与素材。' }));
});

export { server };

if (process.env.GUOLUO_MOCK_LISTEN !== '0') {
  server.listen(port, '127.0.0.1', () => {
    console.log('蜾蠃 mock -> http://127.0.0.1:' + port + '（路由 ' + routes.size + ' 条，素材 ' + assets.size + ' 个）');
  });
}
`;
