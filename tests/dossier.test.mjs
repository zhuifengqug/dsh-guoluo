import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { apply, Config } from '../index.js';
import { projectService } from '../lib/projects.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [sourceRoot, archiveRoot] = ['source', 'archive'].map(name => join(root, name));
  await Promise.all([mkdir(sourceRoot), mkdir(archiveRoot)]);
  const config = { sourceRoot, archiveRoot, reaPath: join(root, 'missing.mjs') };
  return { root, sourceRoot, archiveRoot, config, service: projectService(Config(config)) };
}

test('带行号、摘要、批次和稳定分页的本地档案', async t => {
  const { sourceRoot, service } = await setup(t);
  await mkdir(join(sourceRoot, 'site'));
  await writeFile(join(sourceRoot, 'site/index.html'), '<!doctype html>\n<a href="/docs?token=hidden#ref">Docs</a>\n<script>throw new Error("never executed")</script>\n<img src="https://example.test/a.png?secret=secret">');
  await writeFile(join(sourceRoot, 'site/theme.css'), ':root {\n --accent: #09f;\n background: url("badge.png?private=1");\n}');
  await writeFile(join(sourceRoot, 'site/badge.png'), Buffer.from([1, 2]));
  const target = await service.add({ kind: 'local', location: 'site' });
  assert.equal((await service.status({ id: target.id })).status, 'registered');
  const run = await service.dissect({ id: target.id });
  assert.deepEqual(run.totals, { asset: 3, token: 1, navigation: 1, reference: 2 });
  assert.equal(run.rows, undefined);
  const page = await service.dossier({ id: target.id, runId: run.runId, limit: 2 });
  assert.equal(page.nextOffset, 2);
  const navigation = await service.dossier({ id: target.id, kind: 'navigation' });
  assert.deepEqual(navigation.rows, [{ kind: 'navigation', path: 'index.html', line: 2, value: '/docs' }]);
  assert.equal(navigation.nextOffset, null);
  const tokens = await service.dossier({ id: target.id, kind: 'token' });
  assert.deepEqual(tokens.rows, [{ kind: 'token', path: 'theme.css', line: 2, name: '--accent', value: '#09f' }]);
  assert.ok((await service.dossier({ id: target.id, kind: 'asset' })).rows.some(row => /^\w{64}$/u.test(row.sha256 ?? '')));
  assert.doesNotMatch(JSON.stringify(await service.dossier({ id: target.id })), /secret|hidden|private/u);
  const next = await service.dissect({ id: target.id });
  assert.notEqual(next.runId, run.runId);
  assert.equal((await service.status({ id: target.id })).runCount, 2);
  assert.equal((await service.list()).targets[0].id, target.id);
});

test('URL 不采集，拒绝目录越界和重叠根', async t => {
  const { config, service } = await setup(t);
  await assert.rejects(service.add({ kind: 'local', location: '../private.txt' }), /上级跳转/u);
  await assert.rejects(service.add({ kind: 'local', location: 'C:/asset.css' }), /相对路径/u);
  await assert.rejects(service.add({ kind: 'url', location: 'https://user:pass@example.test' }), /登录信息/u);
  const url = await service.add({ kind: 'url', location: 'http://127.0.0.1:1/page?secret=yes#x' });
  assert.equal(url.location, 'http://127.0.0.1:1/page');
  await assert.rejects(service.dissect({ id: url.id }), /只作登记/u);
  const blocked = projectService({ ...config, archiveRoot: config.sourceRoot });
  assert.equal((await blocked.probe()).directories.ready, false);
  assert.equal((await service.probe()).rea.status, 'unavailable');
});

test('不跟随目录联接，取消不留下可见档案', async t => {
  const { root, sourceRoot, service } = await setup(t);
  await mkdir(join(sourceRoot, 'site'));
  await mkdir(join(root, 'external'));
  await writeFile(join(root, 'external/private.css'), ':root{--external:x}');
  await symlink(join(root, 'external'), join(sourceRoot, 'site/link'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(service.add({ kind: 'local', location: 'site/link' }), /链接|联接/u);
  const target = await service.add({ kind: 'local', location: 'site' });
  const run = await service.dissect({ id: target.id });
  assert.equal(run.coverage.skippedLinks, 1);
  assert.equal(run.totals.token, 0);
  await assert.rejects(service.dissect({ id: target.id }, AbortSignal.abort()), { name: 'AbortError' });
  assert.equal((await service.status({ id: target.id })).runCount, 1);
});

function asarTree(files) {
  const data = Buffer.from(JSON.stringify({ files }));
  const size = 8 + Math.ceil(data.length / 4) * 4;
  const bytes = Buffer.alloc(8 + size);
  bytes.writeUInt32LE(4, 0); bytes.writeUInt32LE(size, 4);
  bytes.writeUInt32LE(size - 4, 8); bytes.writeUInt32LE(data.length, 12);
  data.copy(bytes, 16);
  return bytes;
}

test('ASAR 只列文件目录，坏归档不产生批次', async t => {
  const { sourceRoot, service } = await setup(t);
  await writeFile(join(sourceRoot, 'app.asar'), asarTree({ ui: { files: { 'style.css': { size: 2, offset: '0' }, 'font.woff2': { size: 8, unpacked: true } } }, 'jump.html': { link: 'elsewhere' } }));
  const good = await service.add({ kind: 'local', location: 'app.asar' });
  const run = await service.dissect({ id: good.id });
  assert.equal(run.totals.asset, 2);
  assert.equal(run.coverage.skippedLinks, 1);
  assert.ok(run.notes.some(note => note.includes('仅盘点头部')));
  await writeFile(join(sourceRoot, 'bad.asar'), Buffer.alloc(16));
  const bad = await service.add({ kind: 'local', location: 'bad.asar' });
  await assert.rejects(service.dissect({ id: bad.id }), /ASAR/u);
  assert.equal((await service.status({ id: bad.id })).runCount, 0);
});

test('REA 导入只返回声明指纹和统计，不外发原始内容', async t => {
  const { sourceRoot, service } = await setup(t);
  await writeFile(join(sourceRoot, 'theme.css'), ':root{--color:red}');
  const target = await service.add({ kind: 'local', location: 'theme.css' });
  const id = `ev_${'a'.repeat(64)}`;
  await writeFile(join(sourceRoot, 'rea.json'), JSON.stringify({ summary: { evidence_id: id, normalized_result: { parent_operation: 'analyze_javascript_application', parent_evidence_id: id, artifact: { sha256: 'b'.repeat(64), path: 'DISCARD_PATH' }, summary: { statistics: { relevant_files: 2 }, graph: 'DISCARD_GRAPH' } } } }));
  const run = await service.dissect({ id: target.id, reaSummary: 'rea.json' });
  assert.equal(run.rea.binding, 'declared-not-verified');
  assert.equal(run.rea.stats.relevant_files, 2);
  assert.doesNotMatch(JSON.stringify(run), /DISCARD/u);
  await writeFile(join(sourceRoot, 'other.json'), '{}');
  await assert.rejects(service.dissect({ id: target.id, reaSummary: 'other.json' }), /JSON 摘要/u);
});

test('注册九个工具、技能和命令，读取当前 volatile 配置', async t => {
  const { config } = await setup(t);
  const live = Config({ reaPath: config.reaPath });
  const tools = new Map();
  let skill, command;
  apply({ effect: fn => fn(), tools: { register: tool => tools.set(tool.name, tool) }, skills: { register: value => { skill = value; } }, commands: { register: value => { command = value; } } }, live);
  assert.equal(tools.size, 11);
  for (const name of ['probe', 'target_add', 'dissect', 'dossier', 'spec', 'tokens', 'export', 'mock', 'check', 'list', 'status']) assert.ok(tools.has(`guoluo_${name}`), name);
  assert.equal(skill.name, 'guoluo-rebuild');
  assert.match(skill.content, /^\n?# 蜾蠃/u);
  const probe = tools.get('guoluo_probe');
  const exec = { signal: new AbortController().signal };
  assert.equal((await probe.execute({}, exec)).directories.ready, false);
  const write = Symbol.for('cosmokit.volatile.write');
  live.sourceRoot[write](config.sourceRoot);
  live.archiveRoot[write](config.archiveRoot);
  assert.equal((await probe.execute({}, exec)).directories.ready, true);
  assert.equal((await command.handler({ rawInput: 'list', ...exec })).kind, 'success');
  assert.equal((await command.handler({ rawInput: 'unknown', ...exec })).kind, 'error');
});
