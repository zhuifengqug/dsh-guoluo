import { createHash } from 'node:crypto';
import { renderTailwindCss, renderTokensCss } from './tokens.mjs';

// 生成只做两件事：逐字节搬运已盘点的静态素材，和在 _scaffold/ 里放索引与令牌。
// 不合成页面结构、不猜未观测的路由，也不执行任何素材内容。
export const scaffoldLimits = { files: 512, fileBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, listedSkipped: 20, listedRoutes: 200 };
// 调用方可以调高预算，但不超过这组硬上限：一次生成不该把档案根写满。
export const scaffoldHardLimits = { files: 4096, fileBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 };
const copyTypes = new Set(['page', 'style', 'image', 'font', 'audio', 'video']);
const generatedRoot = '_scaffold';
const rootReadme = 'README.md';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const text = value => String(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/gu, ' ').slice(0, 400);
const escapeHtml = value => String(value).replace(/[&<>"']/gu, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const href = path => path.split('/').map(encodeURIComponent).join('/');
const slash = path => String(path).replaceAll('\\', '/');

const readmeText = ({ id, runId, source, counts, skipped, gaps, budget }) => [
  '# 复刻工程骨架（蜾蠃生成）',
  '',
  `- 档案：\`${text(id)}\``,
  `- 批次：\`${text(runId)}\``,
  `- 素材：\`${text(source)}\``,
  `- 生成：${counts.copied} 个素材逐字节复制、${counts.generated} 个文件生成，共 ${counts.bytes} 字节`,
  '',
  '## 这里面有什么',
  '',
  '- 根目录按素材根内的相对路径逐字节复制已盘点的页面、样式、图片、字体与音视频文件。',
  '- `_scaffold/index.html`：观测到的页面与导航目标索引，不伪造不存在的路由。',
  '- `_scaffold/tokens.css`、`_scaffold/tokens.tailwind.css`：按证据里的 CSS 自定义属性生成的令牌表。',
  '- `_scaffold/scaffold.json`：逐文件清单、指纹、跳过项与证据位置。',
  '',
  '复制的文件保持原样，所以现有的相对引用（`./app.css`、`assets/hero.png`）仍然指向正确位置；',
  '生成物不写进被复制的页面，不会改动观测到的结构。',
  '',
  '## 怎么跑起来',
  '',
  '这是一个纯静态目录，直接打开根目录的 HTML 文件，或在本目录执行：',
  '',
  '```bash',
  'python -m http.server 8080',
  '```',
  '',
  '## 边界',
  '',
  '- 没有脚本运行时：HTML 里的脚本标签原样保留，但本骨架不提供执行环境。',
  '- 归档成员（ASAR/APK/PCK）、可执行文件与非静态素材没有复制，只在清单里说明。',
  '- 未被证据覆盖的路由、接口、交互状态与运行时行为不在本骨架内。',
  ...(budget?.hit ? ['', '## 复制预算', '', `本次因预算未复制 ${budget.blocked} 个可复制素材（files ${budget.files} / fileBytes ${budget.fileBytes} / totalBytes ${budget.totalBytes}）。这不是素材缺失：调高 guoluo_scaffold 的对应上限再生成即可。`] : []),
  ...(skipped.length ? ['', `## 跳过 ${skipped.length} 项`, '', ...skipped.slice(0, budget.listedSkipped).map(item => `- \`${text(item.path)}\`：${text(item.reason)}`)] : []),
  ...(gaps.length ? ['', '## 证据缺口', '', ...gaps.map(gap => `- ${text(gap)}`)] : []),
  '',
].join('\n');

const indexText = ({ id, runId, pages, routes, tokens }) => {
  const links = pages.map(page => `      <li><a href="../${escapeHtml(href(page.path))}">${escapeHtml(page.path)}</a> <span class="meta">${page.bytes} 字节 · ${escapeHtml(page.type)}</span></li>`).join('\n');
  const routeRows = routes.map(route => `      <tr><td><code>${escapeHtml(route.value)}</code></td><td>${escapeHtml(route.path)}:${route.line ?? '?'}</td></tr>`).join('\n');
  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>复刻工程骨架 · ${escapeHtml(id)}</title>`,
    '<link rel="stylesheet" href="tokens.css">',
    '<style>',
    '  :root { color-scheme: light dark }',
    '  body { margin: 0; padding: 2rem; font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; }',
    '  h1 { font-size: 1.25rem; margin: 0 0 .25rem }',
    '  h2 { font-size: 1rem; margin: 2rem 0 .5rem }',
    '  p.meta, span.meta { opacity: .7; font-size: .85em }',
    '  ul { padding-left: 1.25rem }',
    '  table { border-collapse: collapse; font-size: .9em }',
    '  td, th { border-bottom: 1px solid color-mix(in oklab, currentColor 20%, transparent); padding: .25rem .75rem .25rem 0; text-align: left }',
    '</style>',
    '</head>',
    '<body>',
    '  <main>',
    '    <h1>复刻工程骨架</h1>',
    `    <p class="meta">批次 ${escapeHtml(runId)} · ${tokens.total} 个令牌 · ${pages.length} 个页面 · ${routes.length} 个导航目标</p>`,
    '    <p class="meta">本页由蜾蠃生成，只做索引；页面内容是逐字节复制来的观测素材。</p>',
    '    <h2>已观测页面</h2>',
    pages.length ? `    <ul>\n${links}\n    </ul>` : '    <p class="meta">这批证据里没有 HTML 页面。</p>',
    '    <h2>观测到的导航目标</h2>',
    routeRows ? `    <table>\n      <thead><tr><th>目标</th><th>证据位置</th></tr></thead>\n      <tbody>\n${routeRows}\n      </tbody>\n    </table>` : '    <p class="meta">这批证据里没有静态链接。</p>',
    '    <h2>设计令牌</h2>',
    '    <p class="meta">同名变量在 <code>tokens.css</code>；作用域未记录，取值以最后声明为准。</p>',
    '  </main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');
};

/**
 * 规划一次工程骨架：返回内存里的文件列表与清单，由调用方写到档案根的新目录。
 * read(rel, maxBytes) 只读已登记素材根内的普通文件；所有路径来自本批证据。
 */
export async function planScaffold({ id, runId, run, spec, collected, source, read, signal, limits = null }) {
  const budget = { ...scaffoldLimits, ...(limits ?? {}) };
  const rows = Array.isArray(run.rows) ? run.rows : [];
  const files = [];
  const skipped = [];
  const warnings = [];
  const overBudget = { files: 0, fileBytes: 0, totalBytes: 0 };
  const seen = new Set();
  const styles = [];
  const pages = [];
  const total = { files: 0, bytes: 0 };
  let styleCopied = 0;
  const skip = (path, reason) => {
    if (skipped.length < budget.listedSkipped) skipped.push({ path: text(path), reason: text(reason) });
    else skipped.counted = (skipped.counted ?? 0) + 1;
  };
  for (const row of rows) {
    signal?.throwIfAborted();
    if (row?.kind !== 'asset') continue;
    const path = slash(row.path);
    if (seen.has(path)) continue;
    seen.add(path);
    // 任何已盘点素材落在生成路径上都会与索引/令牌/清单撞名，与它的类型无关。
    if (path === rootReadme || path === generatedRoot || path.startsWith(`${generatedRoot}/`)) {
      throw Object.assign(new Error(`素材里的 ${path} 与生成路径冲突；请改素材结构再生成。`), { kind: 'invalid-input' });
    }
    if (row.archive || !copyTypes.has(row.type)) continue;
    if (total.files >= budget.files) { overBudget.files += 1; skip(path, `超过单次复制上限 ${budget.files} 个文件`); continue; }
    if (row.bytes > budget.fileBytes) { overBudget.fileBytes += 1; skip(path, `单文件超过 ${budget.fileBytes} 字节，未复制`); continue; }
    if (total.bytes + (row.bytes ?? 0) > budget.totalBytes) { overBudget.totalBytes += 1; skip(path, `超过单次复制总量 ${budget.totalBytes} 字节，未复制`); continue; }
    let bytes;
    try {
      bytes = await read(path, Math.min(budget.fileBytes, budget.totalBytes - total.bytes));
    } catch (error) {
      signal?.throwIfAborted();
      skip(path, String(error?.message ?? error));
      continue;
    }
    const digest = sha256(bytes);
    if (row.sha256 && row.sha256 !== digest) {
      // 盘点之后源文件变过：不把未核对的字节当证据写进工程。
      skip(path, `内容指纹与档案不同（档案 ${row.sha256.slice(0, 12)}…，当前 ${digest.slice(0, 12)}…），未复制`);
      continue;
    }
    if (!row.sha256) warnings.push(`${path} 在盘点时未取内容指纹，复制的是当前字节，无法与档案比对。`);
    total.files += 1;
    total.bytes += bytes.length;
    files.push({ path, bytes: bytes.length, content: bytes, origin: 'copied', integrity: row.sha256 ? 'match' : 'unrecorded', evidence: row.path });
    if (row.type === 'style') { styles.push({ path, text: bytes.toString('utf8') }); styleCopied += 1; }
    if (row.type === 'page') pages.push({ path, bytes: bytes.length, type: row.type });
  }
  const web = { pages: pages.length, styles: styleCopied, tokens: collected.total, applicable: pages.length > 0 };
  const blocked = overBudget.files + overBudget.fileBytes + overBudget.totalBytes;
  if (blocked) warnings.push(`有 ${blocked} 个可复制素材因预算未复制（files ${budget.files} / fileBytes ${budget.fileBytes} / totalBytes ${budget.totalBytes}）。要全部搬过来，就调高对应上限再生成。`);
  if (!web.applicable) warnings.push('这批证据里没有 HTML 页面，也没有可复用的页面样式：骨架只搬静态媒体与文件级证据，结构、令牌与导航维度是空集而不是核对通过。');
  const tokensCss = renderTokensCss({ id, runId, collected });
  const tailwindCss = renderTailwindCss({ id, runId, collected });
  const routes = rows.filter(row => row?.kind === 'navigation').slice(0, budget.listedRoutes).map(row => ({ value: String(row.value), path: String(row.path), line: row.line ?? null }));
  const generated = [
    { path: `${generatedRoot}/index.html`, text: indexText({ id, runId, pages, routes, tokens: collected }) },
    { path: `${generatedRoot}/tokens.css`, text: tokensCss },
    { path: `${generatedRoot}/tokens.tailwind.css`, text: tailwindCss },
  ];
  for (const entry of generated) files.push({ path: entry.path, bytes: Buffer.byteLength(entry.text, 'utf8'), content: Buffer.from(entry.text, 'utf8'), origin: 'generated', integrity: 'generated', evidence: null });
  styles.push({ path: `${generatedRoot}/tokens.css`, text: tokensCss }, { path: `${generatedRoot}/tokens.tailwind.css`, text: tailwindCss });
  const gaps = Array.isArray(spec.unknowns) ? spec.unknowns : [];
  const counts = { copied: total.files, generated: generated.length, bytes: total.bytes + generated.reduce((sum, entry) => sum + Buffer.byteLength(entry.text, 'utf8'), 0), pages: pages.length, styles: styleCopied, tokens: collected.total };
  const readme = readmeText({ id, runId, source, counts, skipped, gaps, budget: { ...budget, hit: blocked > 0, blocked } });
  files.push({ path: rootReadme, bytes: Buffer.byteLength(readme, 'utf8'), content: Buffer.from(readme, 'utf8'), origin: 'generated', integrity: 'generated', evidence: null });
  counts.generated += 1;
  counts.bytes += Buffer.byteLength(readme, 'utf8');
  return {
    files,
    styles,
    counts,
    skipped,
    warnings,
    gaps,
    web,
    budget: { ...budget, hit: blocked > 0, blocked },
    limits: budget,
    manifest: {
      schemaVersion: 1,
      id,
      runId,
      source: String(source),
      generatedAt: new Date().toISOString(),
      note: '页面、样式与媒体按素材根内相对路径逐字节复制；索引与令牌由批次证据生成。骨架不代表复刻完成，也不执行素材里的脚本。',
      policy: {
        copied: 'type 为 page/style/image/font/audio/video 且非归档成员的已盘点素材，路径与素材根一致，逐字节复制并核对档案指纹',
        generated: [`${generatedRoot}/index.html`, `${generatedRoot}/tokens.css`, `${generatedRoot}/tokens.tailwind.css`, `${generatedRoot}/scaffold.json`, rootReadme],
        excluded: '可执行文件、归档成员（ASAR/APK/PCK）、Unity/PE 与 IL2CPP 条目、符号链接与超过预算的文件',
      },
      counts,
      web,
      budget: { files: budget.files, fileBytes: budget.fileBytes, totalBytes: budget.totalBytes, hit: blocked > 0, blocked },
      files: [],
      skipped,
      ...(skipped.counted ? { skippedBeyondListed: skipped.counted } : {}),
      warnings,
      gaps,
    },
  };
}

/** 把文件清单写进清单文件本身（先算清单再回填，避免清单漏掉自己）。 */
export function sealManifest(manifest, files) {
  return { ...manifest, files: files.map(file => ({ path: file.path, bytes: file.bytes, sha256: sha256(file.content), origin: file.origin, integrity: file.integrity })) };
}
