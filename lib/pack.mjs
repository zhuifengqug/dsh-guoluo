import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// 复刻包索引：把一次 run 的各份派生产物排成一份人能按顺序读的入口文件。
// 这里只做汇总与排序，不新增事实：数字全部来自各步回执，缺口文案原样搬运。

export async function publishPack({ parent, packId, indexText, summaryText, signal }) {
  if (typeof packId !== 'string' || !/^\d{13}-[0-9a-f-]{36}$/u.test(packId)) throw new Error('复刻包批次目录名无效。');
  signal?.throwIfAborted();
  const temporary = join(parent, `.new-${packId}`);
  const destination = join(parent, packId);
  await mkdir(temporary, { mode: 0o700 });
  try {
    await writeFile(join(temporary, 'INDEX.md'), indexText, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal });
    await writeFile(join(temporary, 'pack.json'), summaryText, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal });
    signal?.throwIfAborted();
    await rename(temporary, destination);
    return { directory: destination, index: join(destination, 'INDEX.md'), summary: join(destination, 'pack.json') };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
export const packLimits = { gaps: 20, warnings: 10, files: 40, types: 24 };

const clean = value => String(value ?? '').replace(/[\u0000-\u001f\u007f]/gu, ' ').trim();
const code = value => {
  const text = clean(value);
  return text.includes('`') ? `\`\`${text}\`\`` : `\`${text}\``;
};
const row = (cells) => `| ${cells.map(cell => clean(cell) || '—').join(' | ')} |`;
const count = value => (Number.isSafeInteger(value) ? value.toLocaleString('en-US') : '—');

const bytesLabel = value => {
  if (!Number.isSafeInteger(value) || value < 0) return '—';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
};

const stepLine = step => {
  const state = step.status === 'ok' ? '完成' : step.status === 'reused' ? '沿用既有批次' : step.status === 'skipped' ? '跳过' : step.status;
  const detail = step.note ? `：${clean(step.note)}` : '';
  const ms = Number.isSafeInteger(step.durationMs) ? `（${(step.durationMs / 1000).toFixed(1)} s）` : '';
  return `${code(step.name)} ${state}${ms}${detail}`;
};

// 复刻顺序固定成五步：先读规格、再开骨架、按规格补页面、拿 check 回核、用 mock 起本地服务。
// 顺序写死是有意的——中间任何一步都依赖前一步的产物，换顺序只会让人先看到结论后看到依据。
const order = ({ rootPrefix, spec, scaffold, check, brief }) => {
  const list = [];
  if (spec) list.push(`${code(`${rootPrefix}/spec/spec.md`)} — 复刻规格：要复现的页面、引用、素材与令牌（${count(spec.obligations)} 条义务）。`);
  if (scaffold) list.push(`${code(`${rootPrefix}/scaffold/${scaffold.label}/README.md`)} — 骨架说明、复制了什么、怎么起本地服务。`);
  if (scaffold && scaffold.coverage) list.push(`${code(`${rootPrefix}/scaffold/${scaffold.label}/_scaffold/index.html`)} — 骨架自带的路由索引页。`);
  if (brief) list.push(`${code(`${rootPrefix}/brief/${brief.runId}.md`)} — 交接单：给复刻用的子代理开工那一份。`);
  if (check?.candidate?.report) list.push(`${code(`${rootPrefix}/checks/${check.candidate.reportName}`)} — 结构缺口报告：哪些选择器、链接、层级对不上。`);
  list.push(`${code('./pack.json')} — 同一份内容的机器可读版本（步骤状态、数量、产物路径）。`);
  return list;
};

export function renderPackIndex({ id, label, runId, location, kind, createdAt, version, steps, totals, types, notes, spec, brief, tokens, exported, scaffold, check, gaps, rootPrefix = '..' }) {
  const out = [];
  const pages = scaffold?.web?.pages ?? 0;
  const verdict = check?.candidate?.verdict ?? null;
  const evidence = check?.verdict ?? null;
  const headline = kind === 'local'
    ? pages > 0
      ? `这是一份可开工的静态复刻包：${count(totals?.asset)} 个素材、${count(pages)} 个页面，骨架已按原路径复制。`
      : `这是一份可开工的资产复刻包：${count(totals?.asset)} 个素材，但没有 HTML 页面，页面结构与令牌维度是空集。`
    : '这是一份只含登记信息的档案：来源是 URL，没有素材副本。';

  out.push(`# 复刻包：${clean(label) || clean(id)}`, '', headline, '');
  out.push(row(['项', '值']));
  out.push(row(['—', '—']));
  out.push(row(['档案', code(id)]));
  out.push(row(['批次', code(runId)]));
  out.push(row(['素材', `${code(location)}（${kind === 'local' ? '本地' : 'URL 登记'}）`]));
  out.push(row(['生成', clean(createdAt)]));
  out.push(row(['插件', `v${clean(version)}`]));
  out.push(row(['证据核对', evidence ? `${clean(evidence)}` : '未做']));
  out.push(row(['候选核对', verdict ? `${clean(verdict)}` : '未做（没给候选目录）']));
  out.push('');

  out.push('## 步骤');
  out.push('');
  for (const step of steps) out.push(`- ${stepLine(step)}`);
  out.push('');

  out.push('## 先看什么（按这个顺序）');
  out.push('');
  const sequence = order({ rootPrefix, spec, scaffold: scaffold ? { ...scaffold, label: scaffold.label } : null, check, brief });
  sequence.forEach((line, index) => out.push(`${index + 1}. ${line}`));
  out.push('');

  out.push('## 证据事实');
  out.push('');
  out.push(row(['项', '数']));
  out.push(row(['—', '—']));
  if (totals) for (const [name, value] of Object.entries(totals)) out.push(row([name, count(value)]));
  if (types && Object.keys(types).length) {
    const pairs = Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, packLimits.types);
    out.push(row(['类型分布', pairs.map(([name, value]) => `${name} ${value}`).join('、')]));
  }
  if (tokens) out.push(row(['设计令牌', `${count(tokens.total)} 个（出现 ${count(tokens.occurrences)} 次，冲突 ${count(tokens.conflicts)}）`]));
  if (spec) out.push(row(['规格义务', count(spec.obligations)]));
  if (scaffold) out.push(row(['骨架文件', `复制 ${count(scaffold.counts?.copied)}，生成 ${count(scaffold.counts?.generated)}，合计 ${bytesLabel(scaffold.counts?.bytes)}`]));
  if (exported) out.push(row(['导出行数', count(exported.count)]));
  out.push('');

  const warnings = scaffold?.warnings?.length ? scaffold.warnings.slice(0, packLimits.warnings) : [];
  const gapLines = Array.isArray(gaps) ? gaps.slice(0, packLimits.gaps) : [];
  out.push('## 缺口与待确认');
  out.push('');
  if (!gapLines.length && !warnings.length) out.push('- 这一步没有记下新的缺口；已核对的边界见文末「口径」。');
  if (gapLines.length) {
    for (const gap of gapLines) out.push(`- ${clean(gap)}`);
    if ((gaps?.length ?? 0) > gapLines.length) out.push(`- 另有 ${(gaps.length - gapLines.length)} 条缺口未列出，完整清单位于 ${code(`${rootPrefix}/spec/spec.json`)} 的 unknowns。`);
  }
  for (const warning of warnings) out.push(`- ${clean(warning)}`);
  if ((scaffold?.warnings?.length ?? 0) > warnings.length) out.push(`- 另有 ${scaffold.warnings.length - warnings.length} 条骨架告警未列出。`);
  if (scaffold?.skippedCount) out.push(`- ${count(scaffold.skippedCount)} 个素材没进骨架（预算、类型或指纹不符），明细见 ${code(`${rootPrefix}/scaffold/${scaffold.label}/_scaffold/scaffold.json`)} 的 skipped。`);
  if (check?.candidate?.note) out.push(`- 候选核对口径：${clean(check.candidate.note)}`);
  if (notes?.length) {
    out.push('');
    out.push(`盘点备注（原文，共 ${notes.length} 条）：`);
    out.push('');
    for (const note of notes.slice(0, packLimits.gaps)) out.push(`- ${clean(note)}`);
    if (notes.length > packLimits.gaps) out.push(`- 另有 ${notes.length - packLimits.gaps} 条备注未列出。`);
  }
  out.push('');

  out.push('## 怎么复刻');
  out.push('');
  out.push(`1. 读 ${code(`${rootPrefix}/spec/spec.md`)}，把「义务」表当成验收清单：每一行都要能在你的工程里指到具体文件。`);
  if (scaffold) out.push(`2. 进 ${code(`${rootPrefix}/scaffold/${scaffold.label}/`)}：原路径复制过来的页面、样式与媒体就是基线，不要重新命名目录。`);
  else out.push('2. 这一步没有生成骨架（素材不是目录型，或不是本地档案）：先把素材导出成本地目录再盘点一次。');
  if (scaffold?.start) out.push(`3. 起本地服务看基线：${code(scaffold.start)}`);
  else out.push('3. 起本地服务这一步要等有骨架之后再做。');
  out.push('4. 改完自己的工程后，把它放进素材根，再跑 `guoluo_check` 带 `candidate.directory`：先看文件层缺失，再看结构层缺口报告。');
  out.push('5. 需要按请求路径回放原始素材时，用 `guoluo_mock` 生成的服务脚本，不要手搭路由。');
  out.push('');

  out.push('## 产物清单');
  out.push('');
  out.push(row(['文件', '用途']));
  out.push(row(['—', '—']));
  if (spec) out.push(row([`${code(`${rootPrefix}/spec/spec.md`)}`, '复刻规格（人读）']));
  if (spec) out.push(row([`${code(`${rootPrefix}/spec/spec.json`)}`, '复刻规格（机器读）']));
  if (brief) out.push(row([`${code(`${rootPrefix}/brief/${brief.runId}.md`)}`, '交接单']));
  if (tokens) out.push(row([`${code(`${rootPrefix}/tokens/tokens.css`)}`, '设计令牌变量']));
  if (tokens) out.push(row([`${code(`${rootPrefix}/tokens/tokens.tailwind.css`)}`, 'Tailwind 主题映射']));
  if (exported) out.push(row([`${code(`${rootPrefix}/export/${exported.fileName}`)}`, '证据行导出']));
  if (scaffold) out.push(row([`${code(`${rootPrefix}/scaffold/${scaffold.label}/`)}`, '静态骨架目录']));
  if (scaffold) out.push(row([`${code(`${rootPrefix}/scaffold/${scaffold.label}/_scaffold/scaffold.json`)}`, '骨架清单与逐文件指纹']));
  if (check?.file) out.push(row([`${code(`${rootPrefix}/checks/${check.fileName}`)}`, '核对回执']));
  if (check?.candidate?.report) out.push(row([`${code(`${rootPrefix}/checks/${check.candidate.reportName}`)}`, '结构缺口报告']));
  out.push('');

  out.push('## 口径');
  out.push('');
  out.push('- 这个包只描述**从素材里静态读到的事实**：不执行目标应用的代码，不打开浏览器，不推断运行时行为。');
  out.push('- 复制是逐字节的，清单里每个文件都带 SHA-256；改了源素材再来一次，指纹对不上的文件会被跳过并记进缺口。');
  out.push('- 「核对通过」只表示文件和结构对得上，不表示样式、布局、脚本行为或业务逻辑等价。');
  out.push('');
  return out.join('\n');
}

export function summarizePack({ steps, totals, coverage, spec, scaffold, check, version, runId, id }) {
  return {
    schemaVersion: 1,
    id,
    runId,
    version,
    steps: steps.map(step => ({ name: step.name, status: step.status, durationMs: step.durationMs ?? null, note: step.note ?? null, artifact: step.artifact ?? null })),
    totals: totals ?? null,
    coverage: coverage ?? null,
    spec: spec ? { obligations: spec.obligations, counts: spec.counts, conflicts: spec.conflicts, unknowns: spec.unknowns } : null,
    scaffold: scaffold ? { directory: scaffold.directory, counts: scaffold.counts, web: scaffold.web, budget: scaffold.budget, skippedCount: scaffold.skippedCount, warningCount: scaffold.warningCount, coverageVerdict: scaffold.coverage?.verdict ?? null } : null,
    check: check ? { verdict: check.verdict, candidate: check.candidate ? { verdict: check.candidate.verdict, missing: check.candidate.assets?.missing?.length ?? null, report: check.candidate.reportName ?? null } : null } : null,
    files: { index: 'INDEX.md', summary: 'pack.json' },
  };
}
