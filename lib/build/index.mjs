// 生成适配器：把「证据 + 访谈答案」变成我自己的一份工程。
//
// 首版只有一个适配器 static-html：结构取自证据页，样式由令牌生成，素材沿用
// 已盘点的原件（按原相对路径落位，指纹逐个复核），脚本一律不搬。它的产物可以
// 直接打开，也可以放回素材根交给 guoluo_check 独立核一遍。
//
// 适配器是注册表而不是 switch：后面接 React/Vite 时新增一项，不动调用方。

import { createHash } from 'node:crypto';
import { renderTokensCss } from '../tokens.mjs';
import { reflowHtml, stylesheetLink } from './reflow.mjs';

export const buildLimits = { pages: 24, pageBytes: 512 * 1024, listedPages: 20 };
export const projectStylesheet = 'styles/project.css';

const slash = value => String(value).replaceAll('\\', '/');
const sha256 = value => createHash('sha256').update(value).digest('hex');

export function renderProjectCss({ id, runId, collected }, { label, generatedAt }) {
  const body = renderTokensCss({ id, runId, collected });
  const header = [
    `/* ${label} · 由蜾蠃从证据里的 CSS 自定义属性生成`,
    ` * 生成时间：${generatedAt}`,
    ' * 这里只有令牌（变量声明）与最小结构规则；证据里的样式表按原路径另存一份，',
    ' * 生成页面同时引用两者，所以视觉差异要先看再决定合并。',
    ' */',
    '',
  ].join('\n');
  // 不编颜色：缺令牌时退回浏览器默认（inherit/transparent），而不是拿一个假的品牌色顶上。
  const base = [
    'html { box-sizing: border-box; }',
    '*, *::before, *::after { box-sizing: inherit; }',
    'body { margin: 0; color: var(--color-text, inherit); background: var(--color-bg, transparent); }',
    'img, video { max-width: 100%; height: auto; }',
    '',
  ].join('\n');
  return `${header}${base}${body}`;
}

export function renderProjectManifest({ id, label, runId, name, buildId, generatedAt, pages, assets, tokens, apps, dropped, gaps }) {
  return {
    schemaVersion: 1,
    kind: 'guoluo-build',
    id,
    label,
    runId,
    name,
    buildId,
    adapter: 'static-html',
    generatedAt,
    entry: pages.find(page => /(^|\/)index\.html?$/iu.test(page.path))?.path ?? pages[0]?.path ?? null,
    pages,
    assets,
    tokens,
    apps,
    dropped,
    gaps,
    // 自证与独立核对的分别：这份工程由本插件写出，这里的数字说明写出来的东西
    // 自己跟证据对不对得上；要第三方口径就把目录放回素材根用 guoluo_check。
    selfCheck: null,
  };
}

export function renderProjectReadme({ id, label, runId, buildId, pages, assets, tokens, dropped, structure, adapter }) {
  const lines = [
    `# ${label} · 复刻工程（${adapter}）`,
    '',
    `- 档案：\`${id}\``,
    `- 批次：\`${runId}\``,
    `- 生成：\`${buildId}\``,
    '',
    '## 这份工程是什么',
    '',
    `页面 ${pages.length} 个、素材 ${assets.copied} 个（${assets.bytes} 字节）、令牌 ${tokens.total} 条。页面结构取自证据页（标签、id/class、链接目标、嵌套层级），正文文本保留，脚本与内联样式没有搬。`,
    '',
    '```text',
    `${pages[0]?.path ?? 'index.html'}`,
    '```',
    '',
    '直接双击打开，或者起一个静态服务：',
    '',
    '```bash',
    'python -m http.server 8080',
    '```',
    '',
    '## 自证',
    '',
    structure
      ? `生成后与证据页做了一次静态结构比对：比对页面 ${structure.comparedPages} 个、缺项 ${structure.missingCount} 条${structure.diverged ? '（有缺口，见 project.json 的 selfCheck）' : '，四项结构事实都对得上'}。`
      : '这一批证据里没有可比的 HTML 页面，所以没有结构自证。',
    '',
    '自证只说明「我写出来的东西跟证据的结构事实一致」，不说明视觉一致，也不说明功能一致。要独立口径就把本目录复制回素材根，用 `guoluo_check` 带 `candidate.directory` 核一遍（文件层 + 结构层），或再加 `visual` 做三档截图比对。',
    '',
    '## 没搬的东西',
    '',
    `- 脚本 ${dropped.emptyScripts} 个：只保留空的 \`<script>\` 占位，不搬内容。`,
    `- 样式块 ${dropped.emptyStyles} 个：只保留空的 \`<style>\` 占位。`,
    `- 事件属性 ${dropped.handlers} 个、内联样式 ${dropped.inlineStyle} 个、\`srcset\` ${dropped.srcset} 个、其它属性 ${dropped.attrs} 个：结构比对不看这些，但视觉与响应式行为可能依赖它们。`,
    '',
    '这些都要靠复刻时自己写一遍：从档案的 `dossier` 读原始行，再决定行为怎么重建。',
    '',
  ];
  return lines.join('\n');
}

/** 结构事实只在标签、id/class、链接与层级上重建；这是适配器声明的适用范围。 */
export function staticHtmlApplicable({ pages = 0, styles = 0 }) {
  if (pages > 0 || styles > 0) return { ok: true, reason: null };
  return { ok: false, reason: '这一批证据里没有 HTML/CSS 页面，静态适配器没有可重建的结构。' };
}

/**
 * @param {{id,name,label,runId,buildId,generatedAt,plan,tokens,answers}} input
 * plan 是 planScaffold 的结果：素材与页面已经按原相对路径规划好并核过指纹。
 */
export function buildStaticHtml({ id, label, runId, name, buildId, generatedAt, plan, collected, answers }) {
  const pages = [];
  const assets = { copied: 0, bytes: 0, integrity: 'match', changed: 0 };
  const dropped = { attrs: 0, handlers: 0, inlineStyle: 0, srcset: 0, emptyScripts: 0, emptyStyles: 0 };
  const apps = { scriptsRemoved: 0, stylesheetsKept: 0 };
  const files = [];

  for (const file of plan.files) {
    const path = slash(file.path);
    // 骨架自己生成的那些（_scaffold/* 与 README.md）不搬：工程有自己的入口页、
    // 自己的样式表与自己的说明，混进来只会两份说明互相矛盾。
    if (path.startsWith('_scaffold/') || file.origin === 'generated') continue;
    if (/\.html?$/iu.test(path)) {
      const source = Buffer.isBuffer(file.content) ? file.content.toString('utf8') : String(file.content);
      const rebuilt = reflowHtml({ text: source, stylesheet: stylesheetLink(path) });
      const content = rebuilt.html;
      for (const key of Object.keys(dropped)) dropped[key] += Number(rebuilt.dropped?.[key] ?? 0);
      dropped.emptyScripts += rebuilt.emptyScripts;
      dropped.emptyStyles += rebuilt.emptyStyles;
      apps.scriptsRemoved += rebuilt.emptyScripts;
      files.push({ path, content, bytes: Buffer.byteLength(content, 'utf8'), origin: 'rebuilt', sha256: sha256(content) });
      pages.push({ path });
      continue;
    }
    if (/\.css$/iu.test(path)) apps.stylesheetsKept += 1;
    files.push({ ...file, path, origin: 'copied' });
    assets.copied += 1;
    assets.bytes += Number(file.bytes ?? 0);
  }

  const css = renderProjectCss({ id, runId, collected }, { label, generatedAt });
  files.push({ path: projectStylesheet, content: css, bytes: Buffer.byteLength(css, 'utf8'), origin: 'generated', sha256: sha256(css) });

  const gaps = [];
  if (answers?.missing) gaps.push({ kind: 'missing', note: `访谈里对缺口文件的处理：${answers.missing}` });
  if (answers?.native) gaps.push({ kind: 'native', note: `访谈里对原生组件的处理：${answers.native}` });
  if (apps.scriptsRemoved > 0) gaps.push({ kind: 'scripts', note: `${apps.scriptsRemoved} 个脚本没有搬，行为要自己写。` });
  if (apps.stylesheetsKept > 0) gaps.push({ kind: 'styles', note: `沿用证据样式表 ${apps.stylesheetsKept} 份，与生成的 ${projectStylesheet} 同时生效。` });

  return { files, pages: pages.slice(0, buildLimits.listedPages), assets, apps, dropped, gaps, tokens: collected.total };
}

export const adapters = {
  'static-html': {
    id: 'static-html',
    name: '静态 HTML 工程',
    summary: '按证据页的结构重排成新页面，素材按原路径落位，令牌生成为自己的样式表；脚本不搬。',
    build: buildStaticHtml,
    applicable: staticHtmlApplicable,
  },
};

export function adapterFor(id) {
  const adapter = adapters[id];
  if (!adapter) {
    throw Object.assign(new Error(`没有这个生成适配器：${id}。可用的有：${Object.keys(adapters).join('、')}。`), { kind: 'invalid-input' });
  }
  return adapter;
}