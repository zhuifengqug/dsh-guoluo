// 复刻工作台的只读读模型。
//
// 这里不碰文件系统、不判读证据语义：数据只来自 projectService 的
// probe / list / describe / dossier，所以浏览器那一半与 Agent 的工具调用
// 看的是同一份结果——界面上的数字不会和工具回执对不上。
//
// stage 是由产物目录「推」出来的显示状态，不是落盘的档案状态：
// 它只用来在列表里排顺序和上色，判断进度请看 spec/check/pack 三份回执。
const stages = ['registered', 'dissected', 'specified', 'scaffolded', 'checked', 'packed'];

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
  if ((a.pack?.entries ?? 0) > 0) return 'packed';
  if ((a.checks?.entries ?? 0) > 0) return 'checked';
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

  return { overview, project, evidence };
}

// 下一步只给「已经能做的动作」：没有证据就不谈规格，没有骨架就不谈服务。
function nextSteps(row, latestRun) {
  if (row.stage === 'registered') return ['先盘点：guoluo_dissect（或命令行 /guoluo run <id>）'];
  const steps = ['读规格：guoluo_spec 生成 spec/spec.md'];
  if ((row.artifacts.scaffold?.entries ?? 0) > 0) {
    steps.push('起本地服务看骨架：node <scaffold>/_scaffold 里的绝对路径见 pack/INDEX.md');
  } else if (latestRun) {
    steps.push('生成骨架：guoluo_scaffold');
  }
  if ((row.artifacts.pack?.entries ?? 0) === 0) steps.push('一条命令出包：guoluo_run');
  steps.push('改完自己的工程放进素材根，用 guoluo_check 带 candidate.directory 回核');
  return steps;
}