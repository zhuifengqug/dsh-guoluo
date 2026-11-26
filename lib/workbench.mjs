// 复刻工作台的只读读模型。
//
// 这里不碰文件系统、不判读证据语义：数据只来自 projectService 的
// probe / list / describe / dossier，所以浏览器那一半与 Agent 的工具调用
// 看的是同一份结果——界面上的数字不会和工具回执对不上。
//
// stage 是由产物目录「推」出来的显示状态，不是落盘的档案状态：
// 它只用来在列表里排顺序和上色，判断进度请看 spec/check/pack 三份回执。
const stages = ['registered', 'dissected', 'specified', 'scaffolded', 'built', 'checked', 'packed', 'accepted'];

export const workbenchLimits = { projects: 50, evidence: 50, runs: 10 };

// 入参错和环境错在 HTTP 上要分开：面板据此决定是提示「改一改」还是「看日志」。
const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const invalid = message => Object.assign(new Error(message), { kind: 'invalid-input' });
const requireId = value => {
  if (typeof value !== 'string' || !value) throw invalid('请给出档案 ID。');
  if (!idPattern.test(value)) throw invalid('档案 ID 格式错误。');
  return value;
};

function stageOf(row) {
  const a = row.artifacts ?? {};
  // 拍板是终态：它比「已经出了包」更能说明这条线走完了。
  if (row.verdict?.decision === 'accepted') return 'accepted';
  // 退回意味着当前候选还没被接受；不要让旧 pack 目录把它显示成终态。
  if (row.verdict?.decision === 'rejected') return 'checked';
  if ((a.pack?.entries ?? 0) > 0) return 'packed';
  if ((a.checks?.entries ?? 0) > 0) return 'checked';
  // 有自己生成的工程比只有素材底座(state: scaffolded)更靠后：工程才是复刻的产物。
  if ((a.build?.entries ?? 0) > 0) return 'built';
  if ((a.scaffold?.entries ?? 0) > 0) return 'scaffolded';
  if ((a.spec?.entries ?? 0) > 0) return 'specified';
  return row.latest ? 'dissected' : 'registered';
}

function projectRow(described) {
  return {
    id: described.id,
    label: described.label ?? null,
    kind: described.kind ?? null,
    location: described.location ?? '',
    createdAt: described.createdAt ?? null,
    status: described.status,
    latest: described.latest ?? null,
    runCount: described.runCount ?? 0,
    running: described.running === true,
    stage: stageOf(described),
    artifacts: described.artifacts ?? {},
    verdict: described.verdict ?? null,
  };
}

export function createWorkbench({ projects, version }) {
  const service = 'guoluo';

  async function overview({ offset = 0, limit = 20 } = {}, signal) {
    const probe = await projects.probe(signal);
    const base = { ok: true, service, version, rea: probe.rea, directories: probe.directories };
    if (!probe.directories.ready) {
      return {
        ...base, status: 'unconfigured', reason: probe.directories.reason ?? null,
        note: '先在蜾蠃设置里填素材根与档案根，工作台才有东西可读。',
        offset: 0, total: 0, nextOffset: null, projects: [], counts: null,
      };
    }
    const page = await projects.list({ offset, limit: Math.min(limit, workbenchLimits.projects) }, signal);
    const rows = [];
    for (const target of page.targets) {
      if (target.status === 'unreadable') {
        rows.push({ id: target.id, label: null, status: 'unreadable', stage: 'registered', note: '档案索引读不出来。' });
        continue;
      }
      try {
        rows.push(projectRow(await projects.describe({ id: target.id, run: false }, signal)));
      } catch (error) {
        signal?.throwIfAborted();
        rows.push({ id: target.id, label: null, status: 'unreadable', stage: 'registered', note: String(error?.message ?? error).slice(0, 200) });
      }
    }
    const counts = {};
    for (const name of stages) counts[name] = 0;
    for (const row of rows) counts[row.stage] = (counts[row.stage] ?? 0) + 1;
    return {
      ...base, status: 'ready', offset: page.offset, total: page.total,
      nextOffset: page.nextOffset, projects: rows, counts, stages,
    };
  }

  async function project({ id } = {}, signal) {
    const target = requireId(id);
    const described = await projects.describe({ id: target, run: true }, signal);
    const row = projectRow(described);
    const latestRun = described.latestRun ?? null;
    return {
      ok: true, service, version,
      project: row,
      runs: described.runs ?? [],
      latestRun,
      next: nextSteps(row, latestRun),
    };
  }

  async function evidence({ id, runId, kind, offset = 0, limit = 20 } = {}, signal) {
    const target = requireId(id);
    const page = await projects.dossier({
      id: target, runId, kind,
      offset,
      limit: Math.min(limit, workbenchLimits.evidence),
    }, signal);
    return { ok: true, service, version, ...page, returned: page.rows.length };
  }

  // 界面上的「接受 / 退回」与 guoluo_verdict 走同一条服务方法：
  // 同一个人点按钮和 Agent 调工具，得到的结果与落盘的文件必须完全一致。
  async function verdict({ id, runId, decision, note } = {}, signal) {
    const target = requireId(id);
    const result = await projects.verdict({ id: target, runId, decision, note }, signal);
    // 排完板立刻回一份新的项目行，面板不用自己猜 stage 怎么变。
    const project = projectRow(await projects.describe({ id: target, run: false }, signal));
    return { ...result, project };
  }

  return { overview, project, evidence, verdict };
}

// 下一步只给「已经能做的动作」：没有证据就不谈规格，没有骨架就不谈服务。
function nextSteps(row, latestRun) {
  if (row.stage === 'registered') return ['先盘点：guoluo_dissect（或命令行 /guoluo run <id>）'];
  const steps = ['读规格：guoluo_spec 生成 spec/spec.md'];
  if ((row.artifacts.build?.entries ?? 0) > 0) {
    steps.push('打开自己的工程：build/<批次>/README.md 里有启动命令与自证数字');
  } else if (latestRun) {
    steps.push('生成自己的工程：guoluo_build（先答完 guoluo_questions 的问题更准）');
  }
  if ((row.artifacts.scaffold?.entries ?? 0) === 0 && latestRun) steps.push('要一份素材底座：guoluo_scaffold');
  if ((row.artifacts.pack?.entries ?? 0) === 0) steps.push('一条命令出包：guoluo_run');
  steps.push('改完自己的工程放进素材根，用 guoluo_check 带 candidate.directory 回核');
  if (row.verdict?.decision === 'accepted') steps.push('已经拍板接受；要重开就先退回 guoluo_verdict decision="rejected"');
  else if ((row.artifacts.checks?.entries ?? 0) > 0) steps.push('核对过了就拍板：guoluo_verdict decision="accepted" | "rejected"');
  return steps;
}