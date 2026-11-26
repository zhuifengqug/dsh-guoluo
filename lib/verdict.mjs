// 验收结论：人拍板的那一下。
//
// 与其他派生产物不同，verdict 不是「一批一份」，而是「当前状态 + 一小段历史」：
// 一个人可以接受、退回、再接受，谁都该看得见他最后一次是怎么定的。
// 这里只做判定与组装，读写文件由 projectService 负责，工具与工作台按钮共用同一条路径。

export const verdictSchemaVersion = 1;
export const decisions = ['accepted', 'rejected'];
export const verdictHistory = 20;

const invalid = message => Object.assign(new Error(message), { kind: 'invalid-input' });

export function summarizeCheck(check) {
  const candidate = check?.candidate ?? null;
  const coverage = candidate?.coverage ?? null;
  const structure = candidate?.structure ?? null;
  const values = candidate?.values ?? null;
  const unmet = [];
  if (!candidate) unmet.push('这次核对没有候选工程');
  else {
    if ((coverage?.missing ?? 0) > 0) unmet.push(`文件层缺 ${coverage.missing} 个`);
    if ((structure?.missingCount ?? 0) > 0) unmet.push(`结构层缺 ${structure.missingCount} 项`);
    if ((values?.differs?.count ?? 0) > 0) unmet.push(`令牌值不同 ${values.differs.count} 处`);
    if (candidate.verdict !== 'complete') unmet.push(`候选结论是 ${candidate.verdict}`);
  }
  return {
    checkId: check?.checkId ?? null,
    runId: check?.runId ?? null,
    generatedAt: check?.generatedAt ?? null,
    verdict: candidate?.verdict ?? null,
    coverage: coverage ? { total: coverage.total ?? null, present: coverage.present ?? null, missing: coverage.missing ?? null, changed: coverage.changed ?? null } : null,
    structure: structure ? { comparedPages: structure.comparedPages ?? null, missingCount: structure.missingCount ?? null, diverged: structure.diverged === true } : null,
    unmet,
  };
}

// 拍板只要求一件事：这一批次上确实核过一次带候选的核对。
// 允许在接受「没全对上的候选」——但必须把没对上的项写进 unmet，不能悄悄算通过。
export function buildVerdict({ id, decision, note, check, previous, at }) {
  if (!decisions.includes(decision)) throw invalid(`验收结论只能是 ${decisions.join(' 或 ')}。`);
  const summary = summarizeCheck(check);
  if (!summary.checkId) throw invalid('还没有候选核对结果：先跑 guoluo_check 并给 candidate.directory。');
  if (!check?.candidate) throw invalid('最近一次核对没有候选工程：guoluo_check 要带 candidate.directory 才能作为验收依据。');
  if (decision === 'rejected' && !String(note ?? '').trim()) throw invalid('退回要写一句原因，否则下一次还会踩同一个坑。');
  const entry = {
    decision, at, runId: summary.runId, checkId: summary.checkId,
    checkVerdict: summary.verdict, unmet: summary.unmet, note: String(note ?? '').slice(0, 2000),
  };
  const history = [entry, ...(Array.isArray(previous?.history) ? previous.history : [])].slice(0, verdictHistory);
  return {
    schemaVersion: verdictSchemaVersion,
    id,
    ...entry,
    check: summary,
    history,
  };
}

export function describeVerdict(state) {
  if (!state || typeof state !== 'object') return null;
  return {
    decision: state.decision ?? null,
    at: state.at ?? null,
    runId: state.runId ?? null,
    checkId: state.checkId ?? null,
    checkVerdict: state.checkVerdict ?? null,
    unmet: Array.isArray(state.unmet) ? state.unmet : [],
    note: state.note ?? '',
    history: Array.isArray(state.history) ? state.history.length : 0,
  };
}

export function renderVerdictLine(state) {
  if (!state?.decision) return '还没有拍板：候选核对之后由人决定接受还是退回。';
  const head = state.decision === 'accepted' ? '已接受' : '已退回';
  const unmet = state.unmet?.length ? `；未对上的项：${state.unmet.join('、')}` : '';
  const note = state.note ? `；备注：${state.note}` : '';
  return `${head}（${state.at ?? '时间未知'}，批次 ${state.runId ?? '未知'}，核对 ${state.checkId ?? '未知'}${unmet}${note}）`;
}