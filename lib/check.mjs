const mapped = { page: 'structure', token: 'style-token', navigation: 'route', reference: 'reference', asset: 'asset' };
const key = (kind, path, line) => `${kind}\u0000${path}\u0000${line ?? ''}`;

export function checkEvidence({ spec, run, stored }) {
  const index = new Map();
  for (const entry of spec.obligations) {
    for (const item of entry.evidence) index.set(key(entry.kind, item.path, item.line), entry.id);
  }
  const rows = run.rows ?? [];
  const consumed = new Set();
  const orphans = [];
  for (const row of rows) {
    const kind = mapped[row.kind];
    const id = kind === undefined ? undefined : index.get(key(kind, row.path, row.line));
    if (id === undefined) orphans.push({ kind: row.kind, path: row.path, line: row.line ?? null, name: row.name ?? null, value: row.value ?? null });
    else consumed.add(key(kind, row.path, row.line));
  }
  const dangling = [];
  for (const [entry, id] of index) {
    if (consumed.has(entry)) continue;
    const [kind, path, line] = entry.split('\u0000');
    dangling.push({ kind, path, line: line === '' ? null : Number(line), obligation: id });
  }
  const storedMismatch = stored === null ? null : {
    runId: stored.runId !== run.runId ? { stored: stored.runId, current: run.runId } : null,
    obligations: stored.obligations !== spec.obligations.length ? { stored: stored.obligations, current: spec.obligations.length } : null,
  };
  const stale = storedMismatch !== null && (storedMismatch.runId !== null || storedMismatch.obligations !== null);
  const rea = { status: run.rea?.status ?? null, binding: run.rea?.binding?.status ?? null };
  const reaMismatch = rea.status === 'analyzed' && rea.binding !== 'verified';
  let verdict = 'complete';
  if (orphans.length || dangling.length || stale || reaMismatch) verdict = 'blocked';
  else if (spec.conflicts.length) verdict = 'needs-decision';
  return {
    scope: 'evidence-self-consistency',
    verdict,
    note: verdict === 'complete'
      ? '本批证据与复刻义务互相对齐，没有漏项或悬空证据；这只说明规格自洽，不说明目标应用已被复刻。'
      : reaMismatch
        ? 'REA 摘要未能绑定到本次素材（路径、根哈希或证据字节数对不上），行为侧证据需重新采集。'
        : null,
    evidence: { rows: rows.length, obligations: spec.obligations.length, consumed: consumed.size },
    orphans,
    dangling,
    stale,
    stored: storedMismatch,
    rea,
    conflicts: spec.conflicts,
    unknowns: spec.unknowns,
  };
}

const slash = value => String(value).replaceAll('\\', '/').replace(/^\.\//u, '');
const baseName = value => {
  const parts = slash(value).split('/');
  return parts.at(-1) ?? '';
};
const tokenPattern = name => new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*:`, 'u');
// 只取声明值本身：到下一个分号或右括号为止，不做任何归一化（不展开简写、不解析 var()、不比较计算值）。
const tokenValue = (name, text) => {
  const hit = new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\s*:\\s*([^;}]+)`, 'u').exec(text);
  return hit ? hit[1].trim() : null;
};

/**
 * 候选工程覆盖度：只回答「规格里声明的东西在候选目录里找得到吗」。
 * 不判断做得好不好，也不代表行为等价。
 * files: [{ path, size }] 相对候选根；css: [{ path, text }] 候选里的样式文本（已按预算截断）。
 */
export function checkCandidate({ spec, run, files, css }) {
  const listing = new Map();
  for (const file of files) listing.set(slash(file.path).toLowerCase(), slash(file.path));
  const archive = new Map();
  for (const row of run.rows ?? []) {
    if (row.kind === 'asset' && row.archive) archive.set(slash(row.path).toLowerCase(), row.archive);
  }
  const styles = css.map(entry => ({ path: slash(entry.path), text: entry.text }));

  const assets = { total: 0, present: [], archived: [], missing: [] };
  const structures = { total: 0, present: [], missing: [] };
  const tokens = { total: 0, declared: [], missing: [], method: '在候选 CSS 文本里检索同名变量声明；不解析级联、作用域与运行时取值' };
  const values = { checked: 0, same: 0, differs: [], method: '逐字符比较声明值（仅去首尾空白），不展开简写、不解析 var()、不比较计算值' };
  for (const entry of spec.obligations) {
    if (entry.kind === 'asset') {
      assets.total += 1;
      const target = slash(entry.target);
      const lower = target.toLowerCase();
      const kind = archive.get(lower);
      if (kind) {
        assets.archived.push({ id: entry.id, target, archive: kind });
        continue;
      }
      if (listing.has(lower)) assets.present.push({ id: entry.id, target, path: listing.get(lower) });
      else assets.missing.push({ id: entry.id, target });
    } else if (entry.kind === 'structure') {
      structures.total += 1;
      const target = slash(entry.target);
      const lower = target.toLowerCase();
      const exact = listing.get(lower);
      const byName = exact ?? [...listing.entries()].find(([key]) => baseName(key) === baseName(lower))?.[1];
      if (byName) structures.present.push({ id: entry.id, target, path: byName });
      else structures.missing.push({ id: entry.id, target });
    } else if (entry.kind === 'style-token') {
      tokens.total += 1;
      const pattern = tokenPattern(entry.target);
      const hit = styles.find(style => pattern.test(style.text));
      if (hit) {
        tokens.declared.push({ id: entry.id, target: entry.target, path: hit.path });
        const built = tokenValue(entry.target, hit.text);
        if (entry.value !== undefined && built !== null) {
          values.checked += 1;
          if (built === entry.value) values.same += 1;
          else values.differs.push({ id: entry.id, target: entry.target, archive: entry.value, built, path: hit.path });
        }
      } else tokens.missing.push({ id: entry.id, target: entry.target });
    }
  }
  const missing = assets.missing.length + structures.missing.length + tokens.missing.length;
  const base = missing === 0
    ? '规格声明的素材、页面与令牌在候选目录里都找到了对应物；这只说明文件层面对得上，不说明结构、样式或行为等价。'
    : '部分规格声明的对象在候选目录里没有找到对应物，见 assets.missing、structures.missing 与 tokens.missing。';
  return {
    scope: 'candidate-coverage',
    verdict: missing === 0 ? 'complete' : 'partial',
    note: values.differs.length === 0
      ? base
      : `${base} 另有 ${values.differs.length} 个令牌的声明值与档案不同，见 values.differs。`,
    files: { total: files.length, css: styles.length },
    assets,
    structures,
    tokens,
    values,
    unchecked: [
      '归档成员（ASAR / APK / PCK）不回放，只记录其来源，未核对候选工程是否重新制作。',
      '路由、外部引用与选择器作用域不在文件层核对范围内。',
      '令牌取值只比声明文本，不判断该值最终是否生效（级联、继承、媒体查询与运行时样式均未计算）。',
    ],
  };
}
