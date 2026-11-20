import { tokenRows } from './tokens.mjs';

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
  const tokens = tokenRows(rows);
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
    } else if (row.kind !== 'token') {
      file += 1;
    }
  }
  for (const name of [...tokens.keys()].sort()) {
    const uses = tokens.get(name);
    list.push({
      id: name.replace(/^--/u, 'T-'),
      kind: 'style-token',
      target: name,
      value: uses.at(-1).value,
      requires: '以同名变量复刻该样式值',
      status: 'declared',
      evidence: uses.map(use => (use.line === undefined ? { path: use.path } : { path: use.path, line: use.line })),
    });
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
  const rea = run.rea ?? null;
  if (!rea || ['off', 'skipped', 'unavailable'].includes(rea.status)) {
    unknowns.push(`未取得 REA 静态分析证据${rea?.reason ? `（${rea.reason}）` : ''}：函数级行为、模块依赖与配置读取不在本批证据内。`);
  } else if (rea.status !== 'analyzed' || rea.binding?.status !== 'verified') {
    unknowns.push(`REA 分析未给出可采信的行为侧证据（状态 ${rea.status}${rea.reason ? `：${rea.reason}` : ''}），相关结论缺失。`);
  }
  const evidenceRea = rea === null ? null : {
    status: rea.status,
    version: rea.version ?? null,
    binding: rea.binding?.status ?? null,
    artifactSha256: rea.artifactSha256 ?? null,
    evidenceId: rea.evidenceId ?? null,
    stats: rea.stats ?? null,
    evidence: rea.evidence ?? null,
    reason: rea.reason ?? null,
  };
  return {
    spec: {
      schemaVersion: 2,
      id,
      runId,
      generatedAt: createdAt,
      source: run.source,
      label,
      evidence: { totals: run.totals, coverage: run.coverage, meter: run.meter ?? null, rea: evidenceRea },
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
  if (spec.evidence.rea) {
    const rea = spec.evidence.rea;
    lines.push(`| REA 状态 | ${rea.status}${rea.version ? `（${rea.version}）` : ''} |`);
    lines.push(`| REA 绑定 | ${rea.binding ?? '无'} |`);
    if (rea.artifactSha256) lines.push(`| REA 根哈希 | ${rea.artifactSha256} |`);
    if (rea.stats?.parsed_javascript_files !== undefined) lines.push(`| REA 已解析 JS 文件 | ${rea.stats.parsed_javascript_files} |`);
  }
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
