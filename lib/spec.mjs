const escape = value => String(value).replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, ' ');
const evidence = row => (row.line === undefined ? { path: row.path } : { path: row.path, line: row.line });
const pad = (prefix, index) => `${prefix}-${String(index).padStart(2, '0')}`;

const gaps = [
  'CSS 选择器作用域未记录：令牌与规则只按文件与行号定位，无法确定其适用面。',
  '未运行目标应用、未抓取网络请求：交互行为、接口契约与运行时状态不在本批证据内。',
  'ASAR 只盘点头部资产目录：归档成员未解包，成员内容与内部依赖图未读。',
];

function obligationsOf(rows) {
  const list = [];
  const pages = new Map();
  const tokens = new Map();
  const routes = new Map();
  const references = new Map();
  let structure = 0;
  let route = 0;
  let reference = 0;
  let asset = 0;
  let file = 0;
  for (const row of rows) {
    if (row.kind === 'page') {
      if (!pages.has(row.path)) {
        structure += 1;
        pages.set(row.path, pad('S', structure));
        list.push({ id: pages.get(row.path), kind: 'structure', target: row.path, requires: '复刻页面的结构层级与元素顺序', status: 'declared', evidence: [evidence(row)] });
      }
    } else if (row.kind === 'token') {
      const existing = tokens.get(row.name);
      if (existing) existing.evidence.push(evidence(row));
      else {
        const entry = { id: row.name.replace(/^--/u, 'T-'), kind: 'style-token', target: row.name, value: row.value, requires: '以同名变量复刻该样式值', status: 'declared', evidence: [evidence(row)] };
        tokens.set(row.name, entry);
        list.push(entry);
      }
    } else if (row.kind === 'navigation') {
      const key = `${row.path}\u0000${row.value}`;
      if (!routes.has(key)) {
        route += 1;
        routes.set(key, true);
        list.push({ id: pad('R', route), kind: 'route', target: row.value, requires: '复刻可导航目标与入口位置', status: 'declared', evidence: [evidence(row)] });
      }
    } else if (row.kind === 'reference') {
      if (!references.has(row.value)) {
        reference += 1;
        references.set(row.value, pad('F', reference));
        list.push({ id: references.get(row.value), kind: 'reference', target: row.value, requires: '落地该外部或相对资源引用', status: 'declared', evidence: [evidence(row)] });
      } else {
        list.find(entry => entry.id === references.get(row.value))?.evidence.push(evidence(row));
      }
    } else if (row.kind === 'asset') {
      asset += 1;
      list.push({ id: pad('A', asset), kind: 'asset', target: row.path, requires: '取得或重新制作该素材文件', status: 'declared', evidence: [evidence(row)] });
    } else {
      file += 1;
    }
  }
  return { list, counts: { structure, 'style-token': tokens.size, route, reference, asset, other: file } };
}

export function buildSpec({ id, runId, run, label, createdAt }) {
  const { list, counts } = obligationsOf(run.rows ?? []);
  const conflicts = [];
  const seen = new Map();
  for (const row of run.rows ?? []) {
    if (row.kind !== 'token') continue;
    const values = seen.get(row.name) ?? new Set();
    values.add(row.value);
    seen.set(row.name, values);
  }
  for (const [name, values] of seen) if (values.size > 1) conflicts.push({ name, values: [...values].slice(0, 8) });
  const unknowns = [...gaps];
  if (run.rea) unknowns.push(`REA 摘要由外部导入，声明哈希 ${run.rea.declaredArtifactSha256.slice(0, 12)}… 未与当前素材校验；其覆盖范围以该摘要自身为准。`);
  return {
    spec: {
      schemaVersion: 1,
      id,
      runId,
      generatedAt: createdAt,
      source: run.source,
      label,
      evidence: { totals: run.totals, coverage: run.coverage, meter: run.meter ?? null, rea: run.rea ?? null },
      obligations: list,
      counts,
      conflicts,
      unknowns,
    },
    counts,
    conflicts,
  };
}

export function renderSpecMarkdown({ spec, notes }) {
  const lines = [
    `# 复刻规格 · ${escape(spec.label)}`,
    '',
    `- 档案：\`${spec.id}\``,
    `- 批次：\`${spec.runId}\``,
    `- 素材：\`${escape(spec.source)}\``,
    `- 生成时间：${spec.generatedAt}`,
    `- 复刻义务：${spec.obligations.length} 项`,
    '',
    '## 1 证据范围',
    '',
    '| 项目 | 数值 |',
    '| --- | --- |',
  ];
  const totals = spec.evidence.totals ?? {};
  for (const key of Object.keys(totals).sort()) lines.push(`| ${key} | ${totals[key]} |`);
  const coverage = spec.evidence.coverage ?? {};
  for (const key of Object.keys(coverage).sort()) {
    const value = coverage[key];
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) lines.push(`| coverage.${key} | ${value} |`);
  }
  const meter = spec.evidence.meter;
  if (meter) lines.push(`| 盘点耗时 | ${meter.durationMs} ms |`);
  if (spec.evidence.rea) lines.push(`| REA 摘要 | ${spec.evidence.rea.stats?.parsed_javascript_files ?? '?'} 个 JS 文件已解析 |`);
  lines.push('');

  const sections = [
    ['structure', '结构（页面）', '页面文件', 'target'],
    ['style-token', '样式令牌', '令牌', 'target'],
    ['route', '路由与导航', '目标', 'target'],
    ['reference', '资源引用', '引用值', 'target'],
    ['asset', '静态素材', '文件', 'target'],
  ];
  let index = 2;
  for (const [kind, title, column, field] of sections) {
    const subset = spec.obligations.filter(entry => entry.kind === kind);
    lines.push(`## ${index} ${title}（${subset.length}）`, '');
    index += 1;
    if (!subset.length) { lines.push('本类无证据。', ''); continue; }
    lines.push(`| 编号 | ${column} | 值 | 证据 |`, '| --- | --- | --- | --- |');
    for (const entry of subset) {
      const where = entry.evidence.map(item => item.line === undefined ? item.path : `${item.path}:${item.line}`).slice(0, 4).join('<br>');
      lines.push(`| ${entry.id} | ${escape(entry[field])} | ${escape(entry.value ?? '')} | ${escape(where)} |`);
    }
    lines.push('');
  }

  if (spec.conflicts.length) {
    lines.push(`## ${index} 令牌冲突（${spec.conflicts.length}）`, '', '| 令牌 | 出现过的值 |', '| --- | --- |');
    for (const entry of spec.conflicts) lines.push(`| ${escape(entry.name)} | ${escape(entry.values.join(' / '))} |`);
    lines.push('');
    index += 1;
  }

  lines.push(`## ${index} 缺口与未知（${spec.unknowns.length}）`, '');
  for (const gap of spec.unknowns) lines.push(`- ${gap}`);
  lines.push('');
  index += 1;

  if (notes?.length) {
    lines.push(`## ${index} 盘点说明`, '');
    for (const note of notes) lines.push(`- ${note}`);
    lines.push('');
  }
  return lines.join('\n');
}
