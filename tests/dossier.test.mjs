import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises';
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

test('REA 自动分析并把摘要绑定到当前素材', async t => {
  const { root, sourceRoot, archiveRoot } = await setup(t);
  await mkdir(join(sourceRoot, 'site'));
  await writeFile(join(sourceRoot, 'site/index.html'), '<!doctype html><script src="./app.js"></script>');
  await writeFile(join(sourceRoot, 'site/app.js'), 'export const answer = 42');
  const fakePath = join(root, 'fake-rea.mjs');
  await writeFile(fakePath, await readFile(new URL('./fixtures/fake-rea.mjs', import.meta.url)));
  const service = projectService(Config({ sourceRoot, archiveRoot, reaPath: fakePath }));
  const target = await service.add({ kind: 'local', location: 'site' });
  const run = await service.dissect({ id: target.id });
  assert.equal(run.rea.status, 'analyzed');
  assert.equal(run.rea.version, '9.9.9');
  assert.equal(run.rea.binding.status, 'verified');
  assert.ok(run.rea.binding.checks.every(item => item.ok));
  assert.match(run.rea.artifactSha256, /^[a-f0-9]{64}$/u);
  assert.equal(run.rea.stats.parsed_javascript_files, 1);
  assert.equal(run.rea.evidence.path, `rea/${run.runId}/evidence.json`);
  const off = await service.dissect({ id: target.id, rea: false });
  assert.equal(off.rea.status, 'off');
});

test('REA 绑定在证据字节数或根哈希不符时判为 mismatch', async t => {
  const { root, sourceRoot, archiveRoot } = await setup(t);
  await mkdir(join(sourceRoot, 'site'));
  await writeFile(join(sourceRoot, 'site/app.js'), 'export const answer = 42');
  const fakePath = join(root, 'fake-rea.mjs');
  await writeFile(fakePath, await readFile(new URL('./fixtures/fake-rea.mjs', import.meta.url)));
  const service = projectService(Config({ sourceRoot, archiveRoot, reaPath: fakePath }));
  const target = await service.add({ kind: 'local', location: 'site' });
  const run = await service.dissect({ id: target.id });
  const evidencePath = join(archiveRoot, target.id, 'rea', run.runId, 'evidence.json');
  const original = await readFile(evidencePath, 'utf8');
  await writeFile(evidencePath, `${original} `);
  const { verifyBinding } = await import('../lib/rea.mjs');
  const view = await rebuildView(run, evidencePath, original);
  const binding = await verifyBinding({ target: join(sourceRoot, 'site'), evidencePath, view });
  assert.equal(binding.status, 'mismatch');
  assert.equal(binding.checks.find(item => item.name === 'evidence-bytes').ok, false);
});

async function rebuildView(run, evidencePath, text) {
  const parent = JSON.parse(text).records[0];
  return {
    summary: {
      evidence_id: run.rea.evidenceId,
      normalized_result: {
        parent_evidence_id: parent.evidence_id,
        artifact: { sha256: parent.normalized_result.root_artifact_sha256 },
        summary: { root_artifact_sha256: parent.normalized_result.root_artifact_sha256 },
      },
    },
    evidence_bundle: { path: evidencePath, bytes: Buffer.byteLength(text, 'utf8') },
  };
}

test('注册十二个工具、技能和命令，读取当前 volatile 配置', async t => {
  const { config } = await setup(t);
  const live = Config({ reaPath: config.reaPath });
  const tools = new Map();
  let skill, command;
  apply({ effect: fn => fn(), tools: { register: tool => tools.set(tool.name, tool) }, skills: { register: value => { skill = value; } }, commands: { register: value => { command = value; } } }, live);
  assert.equal(tools.size, 12);
  for (const name of ['probe', 'target_add', 'dissect', 'dossier', 'spec', 'brief', 'tokens', 'export', 'mock', 'check', 'list', 'status']) assert.ok(tools.has(`guoluo_${name}`), name);
  assert.equal(skill.name, 'guoluo-rebuild');
  assert.match(skill.content, /^(?:\r?\n)?# 蜾蠃/u);
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

test('单页证据受序列化字节上限约束，翻页不丢条目', async t => {
  const { sourceRoot, archiveRoot, service } = await setup(t);
  await mkdir(join(sourceRoot, 'probe'));
  await writeFile(join(sourceRoot, 'probe/index.html'), '<!doctype html>');
  const target = await service.add({ kind: 'local', location: 'probe' });
  const runId = `${Date.now()}-e0b9b0f0-1111-4222-8333-444455556666`;
  const rows = Array.from({ length: 40 }, (_, index) => ({ kind: 'reference', path: `app-${index}.html`, line: 1, value: 'x'.repeat(40 * 1024) }));
  await writeFile(join(archiveRoot, target.id, 'runs', `${runId}.json`), JSON.stringify({
    schemaVersion: 2, id: target.id, runId, createdAt: new Date().toISOString(), source: '.', meter: { durationMs: 1, rows: rows.length, textBytes: 0, visited: 1 },
    rea: { status: 'off', reason: '已按要求跳过 REA 分析。' }, rows, totals: { asset: 0, token: 0, navigation: 0, reference: rows.length },
    coverage: { visited: 1, textBytes: 0, skippedText: 0, skippedLinks: 0, clipped: false, limits: {} }, notes: [],
  }));

  const collected = [];
  let offset = 0;
  let pages = 0;
  for (;;) {
    const page = await service.dossier({ id: target.id, runId, limit: 50, offset });
    assert.ok(page.bytes <= 512 * 1024 + 64 * 1024, `一页超过预算：${page.bytes}`);
    if (page.clipped) assert.match(page.clipped, /字节上限/u);
    collected.push(...page.rows);
    pages += 1;
    if (page.nextOffset === null) break;
    assert.ok(page.nextOffset > offset, '翻页必须前进');
    offset = page.nextOffset;
  }
  assert.equal(collected.length, rows.length);
  assert.ok(pages > 1, '应当分多页取回');
  assert.equal(new Set(collected.map(row => row.path)).size, rows.length);
});
