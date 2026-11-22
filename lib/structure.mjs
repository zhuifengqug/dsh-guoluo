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
 * 证据页与候选页的结构比对。解析不出、被预算截断、或本就不在可比范围的条目进 unverified，不计失败。
 * 只回答「页面清单、关键选择器、链接目标与标签层级是否对得上」，不回答样式、布局、脚本行为或业务逻辑是否等价。
 */
export function compareStructure({ evidence = [], candidate = [] }) {
  const evidencePages = evidence.map(entry => profileHtml(entry));
  const candidatePages = candidate.map(entry => profileHtml(entry));
  const { matched, missing, extra } = pairPages(evidencePages, candidatePages);

  const unverified = [];
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
      unverified.push({ path: left.path, reason: blocked.join('；') });
      continue;
    }
    compared += 1;
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
    scope: 'candidate-structure',
    evidencePages: evidencePages.length,
    candidatePages: candidatePages.length,
    comparedPages: compared,
    pages: { total: evidencePages.length, matched: compared, missing: take(missing), extra: take(extra) },
    selectors: { total: selectors.total, present: selectors.present, missing: take(selectors.missing) },
    navigation: { total: navigation.total, present: navigation.present, elsewhere: navigation.elsewhere, skipped: navigation.skipped, missing: take(navigation.missing) },
    hierarchy: { tags: take(tags.missing), edges: take(edges.missing), depths: take(depths.missing), totals: { tags: tags.total, edges: edges.total, depths: depths.total } },
    unverified: take(unverified),
    missingCount: missingTotal,
    diverged: missingTotal > 0,
    method: '静态解析 HTML：比页面清单、id/class 选择器集合、a[href] 原文目标、标签计数占位与父子/深度分布；不执行脚本、不建布局、不匹配 CSS 选择器、不展开模板或前端框架生成的节点',
    limits: structureLimits,
  };
}
