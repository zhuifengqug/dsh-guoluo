const namePattern = /^--[A-Za-z0-9_-]{1,120}$/u;
const sourceLimit = 8;

const usableValue = value => typeof value === 'string' && value.length > 0 && value.length <= 300 && !/url\(|image-set\(|@/iu.test(value);
const safeComment = value => String(value).replace(/\*\//gu, '*\\/').replace(/[\r\n]+/gu, ' ');

export function collectTokens(rows) {
  const grouped = new Map();
  for (const row of rows) {
    if (row?.kind !== 'token' || !namePattern.test(row.name ?? '') || !usableValue(row.value)) continue;
    const uses = grouped.get(row.name) ?? [];
    uses.push({ path: row.path, line: row.line, value: row.value });
    grouped.set(row.name, uses);
  }
  const tokens = [];
  const conflicts = [];
  for (const name of [...grouped.keys()].sort()) {
    const uses = grouped.get(name);
    const distinct = [...new Set(uses.map(use => use.value))];
    tokens.push({ name, value: uses.at(-1).value, occurrences: uses.length, sources: uses.slice(0, sourceLimit) });
    if (distinct.length > 1) conflicts.push({ name, values: distinct.slice(0, sourceLimit), sources: uses.slice(0, sourceLimit) });
  }
  return { tokens, conflicts, total: tokens.length, occurrences: tokens.reduce((sum, token) => sum + token.occurrences, 0) };
}

const header = lines => [':root {', ...lines, '}'];
const declaration = token => `  ${token.name}: ${token.value}; /* ${safeComment(token.sources.at(-1).path)}:${token.sources.at(-1).line} */`;

export function renderTokensCss({ id, runId, collected }) {
  return [
    `/* 蜾蠃 · 设计令牌 · 档案 ${safeComment(id)} · 批次 ${safeComment(runId)}`,
    ' * 来源为素材中声明的 CSS 自定义属性，按文件与行号定位；未记录选择器作用域，不推断适用面。',
    ` * 令牌 ${collected.total} 项，声明 ${collected.occurrences} 处，值冲突 ${collected.conflicts.length} 项。`,
    ' */',
    ...header(collected.tokens.map(declaration)),
    '',
  ].join('\n');
}

export function renderTailwindCss({ id, runId, collected }) {
  return [
    `/* 蜾蠃 · Tailwind v4 主题片段 · 档案 ${safeComment(id)} · 批次 ${safeComment(runId)}`,
    ' * 变量名按素材原样保留，未做语义归类。Tailwind v4 只对 --color-*、--spacing-* 等',
    ' * 既定命名空间生成工具类；需要 bg-accent 这类工具时，人工把对应变量改名后再用。',
    ' * inline 形式只做变量透传，不改动默认主题。',
    ' */',
    '@theme inline {',
    ...collected.tokens.map(token => `  ${token.name}: ${token.value};`),
    '}',
    '',
  ].join('\n');
}

export function renderTokensJson({ id, runId, createdAt, collected }) {
  return {
    schemaVersion: 1,
    id,
    runId,
    generatedAt: createdAt,
    note: '令牌按 CSS 自定义属性声明提取；作用域未记录，同名多值以最后出现者为准并列入 conflicts。',
    total: collected.total,
    occurrences: collected.occurrences,
    tokens: collected.tokens,
    conflicts: collected.conflicts,
  };
}
