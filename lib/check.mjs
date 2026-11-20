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
  let verdict = 'complete';
  if (orphans.length || dangling.length || stale) verdict = 'blocked';
  else if (spec.conflicts.length) verdict = 'needs-decision';
  return {
    scope: 'evidence-self-consistency',
    verdict,
    note: verdict === 'complete'
      ? '本批证据与复刻义务互相对齐，没有漏项或悬空证据；这只说明规格自洽，不说明目标应用已被复刻。'
      : null,
    evidence: { rows: rows.length, obligations: spec.obligations.length, consumed: consumed.size },
    orphans,
    dangling,
    stale,
    stored: storedMismatch,
    conflicts: spec.conflicts,
    unknowns: spec.unknowns,
  };
}
