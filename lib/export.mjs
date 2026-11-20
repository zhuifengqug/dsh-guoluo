const columns = ['kind', 'path', 'line', 'name', 'value'];

const cell = value => {
  const text = value === undefined || value === null ? '' : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
};

export function rowsToCsv(rows) {
  return [columns.join(','), ...rows.map(row => columns.map(key => cell(row[key])).join(','))].join('\r\n') + '\r\n';
}

const escapeMarkdown = value => String(value).replace(/\|/gu, '\\|').replace(/[\r\n]+/gu, ' ');

export function rowsToMarkdown(rows, meta) {
  const groups = new Map();
  for (const row of rows) {
    const list = groups.get(row.kind) ?? [];
    list.push(row);
    groups.set(row.kind, list);
  }
  const lines = [
    `# 资产清单 · ${escapeMarkdown(meta.label)}`,
    '',
    `- 档案：\`${meta.id}\``,
    `- 批次：\`${meta.runId}\``,
    `- 素材：\`${escapeMarkdown(meta.source)}\``,
    `- 导出时间：${meta.generatedAt}`,
    `- 条目：${rows.length}`,
    '',
  ];
  for (const kind of [...groups.keys()].sort()) {
    const list = groups.get(kind);
    lines.push(`## ${kind}（${list.length}）`, '', '| 文件 | 行 | 名称 | 值 |', '| --- | --- | --- | --- |');
    for (const row of list) {
      lines.push(`| ${escapeMarkdown(row.path)} | ${row.line ?? ''} | ${escapeMarkdown(row.name ?? '')} | ${escapeMarkdown(row.value ?? '')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function renderExportJson({ id, runId, createdAt, source, label, rows, totals, coverage }) {
  return {
    schemaVersion: 1,
    id,
    runId,
    generatedAt: createdAt,
    source,
    label,
    totals,
    coverage,
    rows,
  };
}
