// 逆向报告：把一个档案已经掌握的事实写成一份人能读的说明。
//
// 这份报告不产生新证据，只把 run/spec/questions 里已有的东西排成可读顺序，
// 并把「证据」「推断」「缺口」三种成分分开写——混在一起写就是在骗读者。

const listedPaths = 10;

function escape(value) {
  return String(value ?? '').replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

function percent(part, total) {
  if (!total) return '—';
  return `${Math.round((part / total) * 1000) / 10}%`;
}

function typeRows(totals) {
  const byType = totals?.byType ?? {};
  const names = Object.keys(byType).sort((left, right) => Number(byType[right]) - Number(byType[left]));
  return names.map(name => `| ${escape(name)} | ${byType[name]} |`);
}

function statusOf(artifacts) {
  const rows = [];
  const push = (label, entry, hint) => {
    const entries = Number(entry?.entries ?? 0);
    rows.push(`| ${label} | ${entries ? `有（${entries}）` : '没有'} | ${entries ? hint : '还没跑这一步'} |`);
  };
  push('规格', artifacts?.spec, '`spec/spec.md`');
  push('交接单', artifacts?.brief, '`brief/<批次>.md`');
  push('令牌', artifacts?.tokens, '`tokens/tokens.css`');
  push('静态骨架', artifacts?.scaffold, '`scaffold/<名字>/`');
  push('候选核对', artifacts?.checks, '`checks/`');
  push('复刻包', artifacts?.pack, '`pack/<批次>/INDEX.md`');
  return rows;
}

export function renderReport({ project, runId, run, spec, questions, artifacts, generatedAt }) {
  const totals = spec?.evidence?.totals ?? run?.totals ?? {};
  const coverage = spec?.evidence?.coverage ?? run?.coverage ?? {};
  const stack = questions?.stack ?? { label: '无法从静态证据判断', basis: '证据不足。' };
  const obligations = Array.isArray(spec?.obligations) ? spec.obligations : [];
  const unknowns = Array.isArray(spec?.unknowns) ? spec.unknowns : [];
  const missing = Number(coverage.missing ?? 0);
  const total = Number(coverage.total ?? totals?.asset ?? 0);
  const answered = Array.isArray(questions?.questions) ? questions.questions.filter(entry => entry.answer) : [];
  const open = Array.isArray(questions?.questions) ? questions.questions.filter(entry => !entry.answer) : [];
  const label = spec?.label ?? project?.label ?? project?.id ?? '未命名';

  const lines = [
    `# 逆向报告 · ${escape(label)}`,
    '',
    `- 档案：\`${project?.id ?? spec?.id ?? ''}\``,
    `- 批次：\`${runId ?? spec?.runId ?? ''}\``,
    `- 素材：\`${escape(project?.location ?? spec?.source ?? '')}\``,
    `- 生成时间：${generatedAt}`,
    '',
    '## 1 结论',
    '',
    `这份档案认到的是一套「${stack.label}」：${stack.basis} 静态盘点共登记 ${total} 个资产，其中 ${total - missing} 个能在本地按原路径复制，${missing} 个属于静态解析够不到的类型（只登记路径、字节与指纹）。`,
    '',
    `已登记的复刻义务 ${obligations.length} 项，明确写出的未知 ${unknowns.length} 条，访谈里还有 ${open.length} 个问题没答。**下面所有内容都只覆盖静态证据；目标程序没有运行，运行时行为、真实接口与数据流都不在这份报告里。**`,
    '',
    '## 2 目标与素材',
    '',
    '| 项目 | 值 |',
    '| --- | --- |',
    `| 素材类型 | ${escape(project?.kind ?? '—')} |`,
    `| 素材位置 | \`${escape(project?.location ?? '—')}\` |`,
    `| 登记时间 | ${escape(project?.createdAt ?? '—')} |`,
    `| 证据批次 | \`${runId ?? '—'}\`（生成于 ${escape(run?.createdAt ?? '—')}）|`,
    `| REA 状态 | ${escape(run?.rea?.status ?? spec?.evidence?.rea?.status ?? '未分析')}${run?.rea?.reason ? `：${escape(run.rea.reason)}` : ''} |`,
    '',
    '## 3 技术栈判断',
    '',
    `- 判断：${escape(stack.label)}`,
    `- 依据：${escape(stack.basis)}`,
    '- 这是推断，不是观测：判断只看资产类型与解析结果，没有读取框架配置或运行日志。',
    '',
    '## 4 证据规模',
    '',
    '| 项目 | 数值 |',
    '| --- | --- |',
    `| 资产 | ${total} |`,
    `| 本地复制（在范围内） | ${total - missing}（${percent(total - missing, total)}）|`,
    `| 缺口（静态解析够不到） | ${missing}（${percent(missing, total)}）|`,
    `| 令牌义务 | ${Number(spec?.counts?.['style-token'] ?? 0)} |`,
    `| 结构义务 | ${Number(spec?.counts?.structure ?? 0)} |`,
    `| 导航义务 | ${Number(spec?.counts?.route ?? 0)} |`,
    `| 引用义务 | ${Number(spec?.counts?.reference ?? 0)} |`,
    '',
  ];

  const rows = typeRows(totals);
  if (rows.length) {
    lines.push('按类型：', '', '| 类型 | 数量 |', '| --- | --- |', ...rows, '');
  }

  lines.push('## 5 结构与页面', '');
  const structure = Number(spec?.counts?.structure ?? 0);
  if (structure > 0) {
    lines.push(`- 结构义务 ${structure} 项：页面清单、id/class 集合、\`a[href]\` 目标与标签层级。`);
    lines.push('- 结构可以静态比对；布局、尺寸、字体渲染需要视觉核对另开一轮。', '');
  } else {
    lines.push('- 证据里没有可静态解析的 HTML/CSS 页面，所以结构、令牌与导航义务都是空集。');
    lines.push('- **空集不是核对通过**：这类目标只能核到文件层（在不在、指纹对不对）。', '');
  }

  lines.push('## 6 边界与缺口', '');
  if (unknowns.length) {
    for (const gap of unknowns) lines.push(`- ${escape(gap)}`);
    lines.push('');
  } else {
    lines.push('- 这份证据没有声明未知项。', '');
  }
  if (missing > 0) {
    const paths = (Array.isArray(run?.rows) ? run.rows : []).filter(row => row?.kind === 'asset' && row.missing).map(row => row.path);
    lines.push(`缺口文件（前 ${Math.min(paths.length, listedPaths)} 条，共 ${paths.length} 条）：`, '');
    for (const path of paths.slice(0, listedPaths)) lines.push(`- \`${escape(path)}\``);
    if (paths.length > listedPaths) lines.push(`- ……其余 ${paths.length - listedPaths} 条见 \`spec/spec.md\``);
    lines.push('');
  }

  lines.push(`## 7 访谈（已答 ${answered.length} / 共 ${answered.length + open.length}）`, '');
  if (answered.length) {
    for (const entry of answered) {
      lines.push(`- **${escape(entry.question)}**`);
      lines.push(`  - 答：${escape(entry.answer)}`);
      lines.push(`  - 建议是「${escape(entry.suggested)}」，${entry.answer === entry.suggested ? '与建议一致' : '与建议不同，按你的答案走'}。`);
    }
    lines.push('');
  }
  if (open.length) {
    lines.push('还没答的问题（生成工程前需要拍板）：', '');
    for (const entry of open) lines.push(`- \`${entry.key}\` ${escape(entry.question)}（建议：${escape(entry.suggested)}）`);
    lines.push('');
  }
  if (!answered.length && !open.length) lines.push('- 还没跑 `guoluo_questions`，问题清单为空。', '');

  lines.push('## 8 复刻路线与当前状态', '', '| 阶段 | 产物 | 位置 |', '| --- | --- | --- |', ...statusOf(artifacts), '');
  lines.push('按这个顺序往下走：定栈与命名（访谈）→ 生成工程 → 预览 → 候选核对（文件/结构/视觉）→ 收敛到验收。');
  lines.push('生成工程这一步当前还没有适配器：`scaffold` 只把证据素材按原路径搬到一处当底座，它不冒充成品工程。', '');

  lines.push('## 口径', '');
  lines.push('- 本报告由档案里的静态证据生成，没有运行目标程序，没有抓运行时 DOM，没有做样式计算。');
  lines.push('- 「证据」是 `guoluo_dossier` 能查回来的行；「推断」在第 3 节，写了依据；「缺口」在第 6 节，没有补全就当缺口留着。');
  lines.push('- 报告不进档案的证据流：删掉重新生成不会损失任何别的东西。');
  lines.push('');

  return lines.join('\n');
}