import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runAnalysis, verifyBinding } from '../lib/rea.mjs';

const hex = 'a'.repeat(64);
const other = 'b'.repeat(64);
const parentId = `ev_${'1'.repeat(64)}`;

async function fixture(t, { root = hex, subjectPath = null, parentRoot = hex } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-bind-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'site');
  await mkdir(target);
  const evidencePath = join(dir, 'evidence.json');
  const text = JSON.stringify({
    records: [{ operation: 'analyze_javascript_application', evidence_id: parentId, subject: { local_path: subjectPath ?? target, digest: { sha256: root } }, normalized_result: { root_artifact_sha256: parentRoot } }],
  });
  await writeFile(evidencePath, text);
  const view = {
    summary: { evidence_id: `ev_${'2'.repeat(64)}`, normalized_result: { parent_evidence_id: parentId, artifact: { sha256: root }, summary: { root_artifact_sha256: root } } },
    evidence_bundle: { path: evidencePath, bytes: Buffer.byteLength(text, 'utf8') },
  };
  return { dir, target, evidencePath, view, text };
}

test('逐项对上时绑定判为 verified', async t => {
  const { target, evidencePath, view } = await fixture(t);
  const binding = await verifyBinding({ target, evidencePath, view });
  assert.equal(binding.status, 'verified');
  assert.equal(binding.artifactSha256, hex);
  assert.equal(binding.evidenceId, `ev_${'2'.repeat(64)}`);
  assert.ok(binding.checks.every(item => item.ok));
});

test('证据包记录的路径不是当前素材时报 artifact-path', async t => {
  const { target, evidencePath, view } = await fixture(t, { subjectPath: join(tmpdir(), 'somewhere-else') });
  const binding = await verifyBinding({ target, evidencePath, view });
  assert.equal(binding.status, 'mismatch');
  assert.equal(binding.checks.find(item => item.name === 'artifact-path').ok, false);
});

test('根哈希自相矛盾或证据字节不符都判为 mismatch', async t => {
  const a = await fixture(t, { parentRoot: other });
  const first = await verifyBinding({ target: a.target, evidencePath: a.evidencePath, view: a.view });
  assert.equal(first.checks.find(item => item.name === 'parent-root-digest').ok, false);
  const b = await fixture(t);
  const second = await verifyBinding({ target: b.target, evidencePath: b.evidencePath, view: { ...b.view, evidence_bundle: { bytes: 1 } } });
  assert.equal(second.checks.find(item => item.name === 'evidence-bytes').ok, false);
});

test('证据包缺失时按不可读处理', async t => {
  const { target, evidencePath, view } = await fixture(t);
  await rm(evidencePath);
  const binding = await verifyBinding({ target, evidencePath, view });
  assert.equal(binding.status, 'mismatch');
  assert.equal(binding.checks.find(item => item.name === 'evidence-readable').ok, false);
});

test('非零退出、无摘要和超时都报错', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-run-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = join(dir, 'site');
  await mkdir(target);
  const evidencePath = join(dir, 'evidence.json');
  const make = async (name, body) => { const path = join(dir, name); await writeFile(path, body); return path; };
  const failing = await make('fail.mjs', 'process.exit(3);');
  await assert.rejects(runAnalysis({ reaPath: failing, target, evidencePath }), /退出码 3/u);
  const quiet = await make('quiet.mjs', 'console.log(JSON.stringify({ rea_progress: { terminal: true } }));');
  await assert.rejects(runAnalysis({ reaPath: quiet, target, evidencePath }), /分析摘要/u);
  const slow = await make('slow.mjs', 'await new Promise(ok => setTimeout(ok, 5000));');
  await assert.rejects(runAnalysis({ reaPath: slow, target, evidencePath, timeoutMs: 300 }), /超时/u);
});
