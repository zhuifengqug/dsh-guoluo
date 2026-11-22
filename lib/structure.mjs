import { parse } from 'parse5';

// 静态结构比对的预算与上限：只解析已读进内存的 HTML 文本，不执行脚本、不建 DOM 之外的任何东西。
export const structureLimits = {
  pages: 24,
  pageBytes: 512 * 1024,
  totalBytes: 8 * 1024 * 1024,
  nodes: 4000,
  selectors: 400,
  links: 200,
  listed: 20,
};

const slash = value => String(value).replaceAll('\\', '/').replace(/^\.\//u, '');
const trim = value => String(value ?? '').trim();
const lower = value => slash(value).toLowerCase();
const baseName = value => slash(value).split('/').at(-1) ?? '';
const comparableLink = value => {
  const target = trim(value);
  if (target === '' || target === '#' || target.startsWith('#')) return null;
  if (/^(?:javascript|mailto|tel|data):/iu.test(target)) return null;
  return target;
};
const unique = values => [...new Set(values)];

/**
 * 只把一份 HTML 文本读成结构事实：标签计数、id / class 选择器、文档顺序里的父子边、元素深度与链接目标。
 * 不做布局、不解析 CSS 选择器匹配、不执行脚本、不展开模板或前端框架生成的节点。
 */
export function profileHtml({ path, text, reason }) {
  const page = { path: slash(path), ok: false, reason: null, nodes: 0, truncated: false,
    tags: new Map(), ids: [], classes: [], edges: new Set(), depths: new Map(), links: [], skippedLinks: 0 };
  if (typeof text !== 'string') {
    page.reason = String(reason ?? '没有读到页面文本').slice(0, 200);
    return page;
  }
  let document;
  try {
    document = parse(text);
  } catch (error) {
    page.reason = `HTML 解析失败：${String(error?.message ?? error).slice(0, 160)}`;
    return page;
  }
  const stack = [{ node: document, depth: 0, parent: null }];
  while (stack.length) {
    if (page.nodes >= structureLimits.nodes) { page.truncated = true; break; }
    const { node, depth, parent } = stack.pop();
    const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : null;
    const childDepth = tag === null ? depth : depth + 1;
    const childParent = tag ?? parent;
    if (tag !== null) {
      page.nodes += 1;
      page.tags.set(tag, (page.tags.get(tag) ?? 0) + 1);
      page.depths.set(`${depth}:${tag}`, (page.depths.get(`${depth}:${tag}`) ?? 0) + 1);
      if (parent !== null) page.edges.add(`${parent}>${tag}`);
      const attrs = node.attrs ?? [];
      for (const attr of attrs) {
        if (attr.name === 'id' && page.ids.length < structureLimits.selectors) {
          const id = trim(attr.value);
          if (id !== '') page.ids.push(id);
        } else if (attr.name === 'class' && page.classes.length < structureLimits.selectors) {
          for (const name of String(attr.value ?? '').split(/\s+/u)) if (name !== '') page.classes.push(name);
        } else if (attr.name === 'href' && tag === 'a' && page.links.length < structureLimits.links) {
          const target = comparableLink(attr.value);
          if (target === null) page.skippedLinks += 1;
          else page.links.push(target);
        }
      }
    }
    const children = node.childNodes ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index], depth: childDepth, parent: childParent });
  }
  page.ok = true;
  page.ids = unique(page.ids).sort();
  page.classes = unique(page.classes).sort();
  page.links = unique(page.links).sort();
  return page;
}

const selectorEntries = page => [
  ...page.ids.map(id => `#${id}`),
  ...page.classes.map(name => `.${name}`),
];

const take = (list, limit = structureLimits.listed) => ({ items: list.slice(0, limit), count: list.length });

function pairPages(evidence, candidate) {
  const byPath = new Map();
  const byName = new Map();
  for (const entry of candidate) {
    byPath.set(lower(entry.path), entry);
    const name = baseName(entry.path).toLowerCase();
    byName.set(name, byName.has(name) ? null : entry);
  }
  const matched = [];
  const missing = [];
  const used = new Set();
  for (const page of evidence) {
    const exact = byPath.get(lower(page.path));
    const pick = exact ?? byName.get(baseName(page.path).toLowerCase()) ?? null;
    if (pick === null) { missing.push({ path: page.path }); continue; }
    if (used.has(pick.path)) { missing.push({ path: page.path }); continue; }
    used.add(pick.path);
    matched.push({ evidence: page, candidate: pick });
  }
  const extra = candidate.filter(entry => !used.has(entry.path)).map(entry => ({
    path: entry.path,
    generated: /^_scaffold\//u.test(slash(entry.path)),
  }));
  return { matched, missing, extra };
}

/**
 * 证据页与候选页的结构比对，返回完整清单（不截断），供报告渲染与摘要共用。
 * 解析不出、被预算截断、或本就不在可比范围的条目进 unverified，不计失败。
 */
export function analyzeStructure({ evidence = [], candidate = [] }) {
  const evidencePages = evidence.map(entry => profileHtml(entry));
  const candidatePages = candidate.map(entry => profileHtml(entry));
  const { matched, missing, extra } = pairPages(evidencePages, candidatePages);

  const unverified = [];
  const pairs = [];
  const selectors = { total: 0, present: 0, missing: [] };
  const navigation = { total: 0, present: 0, elsewhere: 0, missing: [], skipped: 0 };
  const tags = { total: 0, missing: [] };
  const edges = { total: 0, missing: [] };
  const depths = { total: 0, missing: [] };
  const allCandidateLinks = new Set(candidatePages.filter(page => page.ok).flatMap(page => page.links));
  let compared = 0;

  for (const { evidence: left, candidate: right } of matched) {
    const blocked = [];
    if (!left.ok) blocked.push(`证据页：${left.reason}`);
    if (!right.ok) blocked.push(`候选页：${right.reason}`);
    if (left.truncated || right.truncated) blocked.push(`节点超过 ${structureLimits.nodes} 个，结构比对被截断`);
    if (blocked.length) {
      const reason = blocked.join('；');
      unverified.push({ path: left.path, reason });
      pairs.push({ path: left.path, candidate: right.path, compared: false, reason });
      continue;
    }
    compared += 1;
    pairs.push({ path: left.path, candidate: right.path, compared: true, reason: null });
    const built = new Set(selectorEntries(right));
    for (const selector of selectorEntries(left)) {
      selectors.total += 1;
      if (built.has(selector)) selectors.present += 1;
      else selectors.missing.push({ path: left.path, selector });
    }
    const candidateLinks = new Set(right.links);
    navigation.skipped += left.skippedLinks;
    for (const target of left.links) {
      navigation.total += 1;
      if (candidateLinks.has(target)) navigation.present += 1;
      else if (allCandidateLinks.has(target)) navigation.elsewhere += 1;
      else navigation.missing.push({ path: left.path, target });
    }
    for (const [tag, count] of left.tags) {
      tags.total += count;
      const built2 = right.tags.get(tag) ?? 0;
      if (built2 < count) tags.missing.push({ path: left.path, tag, archive: count, built: built2 });
    }
    for (const edge of left.edges) {
      edges.total += 1;
      if (!right.edges.has(edge)) edges.missing.push({ path: left.path, edge });
    }
    for (const [depth, count] of left.depths) {
      depths.total += count;
      const built2 = right.depths.get(depth) ?? 0;
      if (built2 < count) depths.missing.push({ path: left.path, depth, archive: count, built: built2 });
    }
  }

  const missingTotal = missing.length + selectors.missing.length + navigation.missing.length
    + tags.missing.length + edges.missing.length + depths.missing.length;
  return {
    evidencePages: evidencePages.length,
    candidatePages: candidatePages.length,
    comparedPages: compared,
    pairs,
    missingPages: missing,
    extraPages: extra,
    selectors,
    navigation,
    tags,
    edges,
    depths,
    unverified,
    missingCount: missingTotal,
    diverged: missingTotal > 0,
    method: '静态解析 HTML：比页面清单、id/class 选择器集合、a[href] 原文目标、标签计数占位与父子/深度分布；不执行脚本、不建布局、不匹配 CSS 选择器、不展开模板或前端框架生成的节点',
    limits: structureLimits,
  };
}

/** 把完整比对结果压成回执里的 structure 摘要：清单类字段只留前 structureLimits.listed 条并带总数。 */
export function summarizeStructure(detail) {
  return {
    scope: 'candidate-structure',
    evidencePages: detail.evidencePages,
    candidatePages: detail.candidatePages,
    comparedPages: detail.comparedPages,
    pages: { total: detail.evidencePages, matched: detail.comparedPages, missing: take(detail.missingPages), extra: take(detail.extraPages) },
    selectors: { total: detail.selectors.total, present: detail.selectors.present, missing: take(detail.selectors.missing) },
    navigation: { total: detail.navigation.total, present: detail.navigation.present, elsewhere: detail.navigation.elsewhere, skipped: detail.navigation.skipped, missing: take(detail.navigation.missing) },
    hierarchy: { tags: take(detail.tags.missing), edges: take(detail.edges.missing), depths: take(detail.depths.missing), totals: { tags: detail.tags.total, edges: detail.edges.total, depths: detail.depths.total } },
    unverified: take(detail.unverified),
    missingCount: detail.missingCount,
    diverged: detail.diverged,
    method: detail.method,
    limits: detail.limits,
  };
}

/**
 * 证据页与候选页的结构比对摘要（工具回执用）。
 * 只回答「页面清单、关键选择器、链接目标与标签层级是否对得上」，不回答样式、布局、脚本行为或业务逻辑是否等价。
 */
export function compareStructure({ evidence = [], candidate = [] }) {
  return summarizeStructure(analyzeStructure({ evidence, candidate }));
}

// —— 报告渲染 ——

export const reportLimits = { perSection: 100, pages: 200 };

const cell = value => String(value ?? '').replaceAll('|', '\\|').replaceAll('`', "'");
const code = value => `\`${String(value ?? '').replaceAll('`', "'")}\``;
const bytes = value => {
  if (value >= 1024 * 1024) return `${value / (1024 * 1024)} MiB`;
  if (value >= 1024) return `${Math.round(value / 1024)} KiB`;
  return `${value} B`;
};

function capped(items, limit = reportLimits.perSection) {
  const listed = items.slice(0, limit);
  const rest = items.length - listed.length;
  return { listed, rest };
}

function sectionLines(title, format, items) {
  if (!items.length) return [];
  const { listed, rest } = capped(items);
  return [`- ${title}（${items.length}）：${listed.map(format).join('、')}${rest > 0 ? ` …另有 ${rest} 项未列出` : ''}`];
}

/**
 * 把结构比对结果渲染成按页面分组的 Markdown 核对报告。
 * 只复述 detail 里已有的静态事实，不新增推断；超长清单每节只列前 reportLimits.perSection 条并注明余量。
 */
export function renderStructureReport({ id, label, runId, directory, detail, createdAt }) {
  const lines = [];
  lines.push('# 结构核对报告', '');
  lines.push('| 项 | 值 |', '| --- | --- |');
  lines.push(`| 目标 | ${code(label ?? id)}（${code(id)}） |`);
  lines.push(`| 批次 | ${code(runId)} |`);
  lines.push(`| 候选目录 | ${code(directory)} |`);
  lines.push(`| 生成时间 | ${cell(createdAt)} |`);
  const verdict = detail.diverged ? `有 ${detail.missingCount} 项对不上` : '四项均对得上';
  lines.push(`| 结构结论 | ${verdict} |`);
  lines.push(`| 比较页数 | ${detail.comparedPages} / 证据 ${detail.evidencePages} 页，候选 ${detail.candidatePages} 页 |`);
  lines.push(`| 未核页面 | ${detail.unverified.length} |`);
  lines.push('');
  lines.push(`口径：${detail.method}。`);
  lines.push(`上限：${detail.limits.pages} 页 / 单页 ${bytes(detail.limits.pageBytes)} / 合计 ${bytes(detail.limits.totalBytes)} / 每页 ${detail.limits.nodes} 节点 / 每页 ${detail.limits.selectors} 选择器 / 每页 ${detail.limits.links} 链接。`);
  lines.push('');

  lines.push('## 总览', '');
  lines.push('| 维度 | 证据 | 命中 | 缺失 |', '| --- | --- | --- | --- |');
  lines.push(`| 页面 | ${detail.evidencePages} | ${detail.comparedPages} | ${detail.missingPages.length} |`);
  lines.push(`| 选择器 | ${detail.selectors.total} | ${detail.selectors.present} | ${detail.selectors.missing.length} |`);
  const elsewhere = detail.navigation.elsewhere ? `（另 ${detail.navigation.elsewhere} 条在别的候选页命中）` : '';
  lines.push(`| 链接目标 | ${detail.navigation.total} | ${detail.navigation.present}${elsewhere} | ${detail.navigation.missing.length} |`);
  lines.push(`| 标签计数 | ${detail.tags.total} | — | ${detail.tags.missing.length} |`);
  lines.push(`| 父子关系 | ${detail.edges.total} | — | ${detail.edges.missing.length} |`);
  lines.push(`| 深度分布 | ${detail.depths.total} | — | ${detail.depths.missing.length} |`);
  lines.push('');

  const byPage = new Map();
  const entryFor = path => {
    if (!byPage.has(path)) byPage.set(path, { selectors: [], links: [], tags: [], edges: [], depths: [] });
    return byPage.get(path);
  };
  for (const item of detail.selectors.missing) entryFor(item.path).selectors.push(item.selector);
  for (const item of detail.navigation.missing) entryFor(item.path).links.push(item.target);
  for (const item of detail.tags.missing) entryFor(item.path).tags.push(item);
  for (const item of detail.edges.missing) entryFor(item.path).edges.push(item.edge);
  for (const item of detail.depths.missing) entryFor(item.path).depths.push(item);

  const compared = detail.pairs.filter(pair => pair.compared);
  const gapPages = compared.filter(pair => byPage.has(pair.path));
  const cleanPages = compared.filter(pair => !byPage.has(pair.path));

  lines.push(`## 对不上的页面（${gapPages.length}）`, '');
  if (!gapPages.length) lines.push('没有对不上的页面。', '');
  let index = 0;
  for (const pair of gapPages) {
    index += 1;
    const gaps = byPage.get(pair.path);
    lines.push(`### ${index}. ${code(pair.path)} → ${code(pair.candidate)}`, '');
    lines.push(...sectionLines('缺失选择器', value => code(value), gaps.selectors));
    lines.push(...sectionLines('缺失链接目标', value => code(value), gaps.links));
    lines.push(...sectionLines('标签数量不足', item => `${code(item.tag)} 证据 ${item.archive} / 候选 ${item.built}`, gaps.tags));
    lines.push(...sectionLines('缺失父子关系', value => code(value), gaps.edges));
    lines.push(...sectionLines('深度分布不足', item => `${code(item.depth)} 证据 ${item.archive} / 候选 ${item.built}`, gaps.depths));
    lines.push('');
  }

  if (cleanPages.length) {
    lines.push(`## 对得上的页面（${cleanPages.length}）`, '');
    const { listed, rest } = capped(cleanPages, reportLimits.pages);
    for (const pair of listed) lines.push(`- ${code(pair.path)} → ${code(pair.candidate)}`);
    if (rest > 0) lines.push(`- …另有 ${rest} 页`);
    lines.push('');
  }

  if (detail.unverified.length) {
    lines.push(`## 未核页面（${detail.unverified.length}）`, '');
    const { listed, rest } = capped(detail.unverified, reportLimits.pages);
    for (const item of listed) lines.push(`- ${code(item.path)} — ${cell(item.reason)}`);
    if (rest > 0) lines.push(`- …另有 ${rest} 页`);
    lines.push('');
  }

  if (detail.missingPages.length) {
    lines.push(`## 候选里找不到的证据页（${detail.missingPages.length}）`, '');
    const { listed, rest } = capped(detail.missingPages, reportLimits.pages);
    for (const item of listed) lines.push(`- ${code(item.path)}`);
    if (rest > 0) lines.push(`- …另有 ${rest} 页`);
    lines.push('');
  }

  if (detail.extraPages.length) {
    lines.push(`## 候选多出的页面（${detail.extraPages.length}）`, '');
    const { listed, rest } = capped(detail.extraPages, reportLimits.pages);
    for (const item of listed) lines.push(`- ${code(item.path)}${item.generated ? '（生成物）' : ''}`);
    if (rest > 0) lines.push(`- …另有 ${rest} 页`);
    lines.push('');
  }

  lines.push('## 这份报告不回答什么', '');
  lines.push('- 只复述静态解析出的事实：不执行脚本、不建布局、不匹配 CSS 选择器、不展开模板或前端框架生成的节点。');
  lines.push('- 多出来的选择器、链接与标签不判失败；只报「证据有、候选少」。');
  lines.push('- 未核页面不计失败，也不代表一致。');
  lines.push('');
  return lines.join('\n');
}
