import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectService } from '../lib/projects.mjs';
import { createWorkbench, workbenchLimits } from '../lib/workbench.mjs';

const html = '<!doctype html><html><body><h1 id="hero">蜾蠃</h1><a href="/docs">docs</a></body></html>';
const css = ':root{--accent:#112233}\nbody{color:var(--accent)}';

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-workbench-'));
  const source = join(dir, 'source');
  const archive = join(dir, 'archive');
  for (const path of [join(source, 'site'), archive]) await mkdir(path, { recursive: true });
  await writeFile(join(source, 'site', 'index.html'), html);
  await writeFile(join(source, 'site', 'app.css'), css);
  const projects = projectService({ sourceRoot: source, archiveRoot: archive });
  const workbench = createWorkbench({ projects, version: 'test' });
  return { dir, source, archive, projects, workbench };
}

test('工作台：没有配置目录时说 unconfigured，不伪造空列表', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-workbench-empty-'));
  try {
    const projects = projectService({ sourceRoot: '', archiveRoot: '' });
    const workbench = createWorkbench({ projects, version: 'test' });
    const overview = await workbench.overview();
    assert.equal(overview.ok, true);
    assert.equal(overview.status, 'unconfigured');
    assert.equal(overview.total, 0);
    assert.deepEqual(overview.projects, []);
    assert.match(overview.reason, /绝对路径/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('工作台：登记后是 registered，盘点后是 dissected，产物目录逐类计数', async () => {
  const { dir, projects, workbench } = await scratch();
  try {
    const empty = await workbench.overview();
    assert.equal(empty.status, 'ready');
    assert.equal(empty.total, 0);
    assert.equal(empty.counts.registered, 0);

    const { id } = await projects.add({ kind: 'local', location: 'site' });
    const registered = await workbench.overview();
    assert.equal(registered.total, 1);
    assert.equal(registered.projects[0].stage, 'registered');
    assert.equal(registered.projects[0].runCount, 0);

    const { runId } = await projects.dissect({ id, rea: false });
    const dissected = await workbench.overview();
    const row = dissected.projects[0];
    assert.equal(row.stage, 'dissected');
    assert.equal(row.latest, runId);
    assert.equal(row.runCount, 1);
    assert.equal(dissected.counts.dissected, 1);
    // 还没生成的产物目录按 0 条报，不是缺字段——面板拿不到键就会渲染成「未知」。
    assert.equal(row.artifacts.spec.entries, 0);
    assert.equal(row.artifacts.pack.entries, 0);

    await projects.spec({ id, runId });
    const specified = await workbench.project({ id });
    assert.equal(specified.project.stage, 'specified');
    assert.equal(specified.project.artifacts.spec.entries, 2);
    assert.deepEqual(specified.runs, [runId]);
    assert.equal(specified.latestRun.runId, runId);
    assert.equal(specified.latestRun.totals.asset, 2);
    assert.ok(specified.next.some(line => /guoluo_run/u.test(line)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('工作台：证据分页按页返回，总量与下一页偏移对得上', async () => {
  const { dir, projects, workbench } = await scratch();
  try {
    const { id } = await projects.add({ kind: 'local', location: 'site' });
    const { runId } = await projects.dissect({ id, rea: false });
    const first = await workbench.evidence({ id, runId, kind: 'asset', offset: 0, limit: 1 });
    assert.equal(first.ok, true);
    assert.equal(first.total, 2);
    assert.equal(first.returned, 1);
    assert.equal(first.nextOffset, 1);
    assert.equal(first.rows.length, 1);

    const second = await workbench.evidence({ id, runId, kind: 'asset', offset: 1, limit: 1 });
    assert.equal(second.rows[0].path, 'index.html');
    assert.notEqual(first.rows[0].path, second.rows[0].path);
    assert.equal(second.nextOffset, null);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('工作台：请求上限被夹到 workbenchLimits，坏入参直接拒', async () => {
  const { dir, projects, workbench } = await scratch();
  try {
    await assert.rejects(() => workbench.project({}), /请给出档案 ID/u);
    await assert.rejects(() => workbench.evidence({ id: 'nope' }), /档案 ID 格式错误/u);
    const { id } = await projects.add({ kind: 'local', location: 'site' });
    await projects.dissect({ id, rea: false });
    const page = await workbench.evidence({ id, limit: 999 });
    assert.ok(page.limit <= workbenchLimits.evidence);
    const sized = await workbench.overview({ limit: 999 });
    assert.ok(sized.projects.length <= workbenchLimits.projects);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('工作台：一个目录条目都读不出来时按 0 条报，不让整个列表塌掉', async () => {
  const { dir, archive, projects, workbench } = await scratch();
  try {
    const { id } = await projects.add({ kind: 'local', location: 'site' });
    await projects.dissect({ id, rea: false });
    // 把 spec 目录做成一个同名普通文件：artifactsFor 认它不是目录，按 0 条报。
    await writeFile(join(archive, id, 'spec'), 'not a directory\n');
    const detail = await workbench.project({ id });
    assert.equal(detail.project.artifacts.spec.entries, 0);
    assert.equal(detail.project.artifacts.pack.entries, 0);
    assert.equal(detail.project.stage, 'dissected');
  } finally { await rm(dir, { recursive: true, force: true }); }
});