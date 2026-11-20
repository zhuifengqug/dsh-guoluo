import { spawn } from 'node:child_process';
import { delimiter, extname, isAbsolute, resolve } from 'node:path';
import { realpath, stat } from 'node:fs/promises';
import { readBounded } from './paths.mjs';

const launcher = /^@echo off\r?\n"([A-Za-z]:\\[^"\r\n]+\\node\.exe)" "([A-Za-z]:\\[^"\r\n]+\.mjs)" %\*\r?\n?$/iu;
const digestPattern = /^[a-f0-9]{64}$/u;
const evidencePattern = /^ev_[a-f0-9]{64}$/u;
const exists = async path => (await stat(path).catch(() => null))?.isFile() === true;

async function resolveRea(configured, signal) {
  if (configured && !isAbsolute(configured)) throw new Error('REA 路径须为绝对路径。');
  const candidates = configured ? [configured] : (process.env.PATH ?? '').split(delimiter).filter(isAbsolute)
    .flatMap(dir => (process.platform === 'win32' ? ['rea.exe', 'rea.cmd'] : ['rea']).map(name => resolve(dir, name)));
  for (const path of candidates) {
    signal?.throwIfAborted();
    if (!await exists(path)) continue;
    const suffix = extname(path).toLowerCase();
    if (suffix === '.mjs') return [process.execPath, [path]];
    if (process.platform === 'win32' && suffix === '.cmd') {
      const m = launcher.exec((await readBounded(path, 4096, signal)).toString('utf8').replace(/^\uFEFF/u, ''));
      if (!m || !await exists(m[1]) || !await exists(m[2])) throw new Error('REA 批处理不是受支持的 Node 启动器；请配置 REA 的 .mjs 路径。');
      return [m[1], [m[2]]];
    }
    if ((process.platform === 'win32' && suffix === '.exe') || (process.platform !== 'win32' && !['.cmd', '.bat'].includes(suffix))) return [path, []];
  }
  throw new Error('未找到 REA CLI。');
}

async function version(path, signal) {
  const [command, baseArgs] = await resolveRea(path, signal);
  signal?.throwIfAborted();
  return new Promise((ok, fail) => {
    const child = spawn(command, [...baseArgs, '--version'], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'ignore'] });
    let reason;
    let text = '';
    const kill = error => { reason ??= error; child.kill(); };
    const cancel = () => kill(signal.reason);
    const timer = setTimeout(() => kill(new Error('REA 版本探测超时。')), 5000);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.setEncoding('utf8').on('data', chunk => {
      if (text.length + chunk.length > 1024) kill(new Error('REA 版本输出超限。'));
      else text += chunk;
    });
    child.on('error', error => { reason ??= error; });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      const match = /^(?:rea\s+)?(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)$/iu.exec(text.trim());
      if (reason) fail(reason);
      else if (code !== 0 || !match) fail(new Error('REA CLI 未返回可识别的版本。'));
      else ok(match[1]);
    });
  });
}

export async function probeRea(configured, signal) {
  try { return { status: 'available', version: await version(configured, signal) }; }
  catch (error) { signal?.throwIfAborted(); return { status: 'unavailable', reason: error.message }; }
}

function lastMatching(text, accept) {
  const lines = text.split(/\r?\n/u).filter(line => line.trim());
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let parsed;
    try { parsed = JSON.parse(lines[index]); } catch { continue; }
    if (accept(parsed)) return parsed;
  }
  return null;
}

// REA can emit progress lines before its JSON result.
function runJson({ reaPath, args, timeoutMs, signal, label, accept, missing }) {
  return resolveRea(reaPath, signal).then(([command, baseArgs]) => new Promise((ok, fail) => {
    signal?.throwIfAborted();
    const child = spawn(command, [...baseArgs, ...args], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let reason;
    let out = '';
    let err = '';
    let bytes = 0;
    const kill = error => { reason ??= error; child.kill(); };
    const cancel = () => kill(signal?.reason ?? new Error('已取消。'));
    const timer = setTimeout(() => kill(new Error(`REA ${label}超时（${timeoutMs} ms）。`)), timeoutMs);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    child.stdout.setEncoding('utf8').on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) kill(new Error('REA 标准输出超限。'));
      else out += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', chunk => { if (err.length < 64 * 1024) err += chunk; });
    child.on('error', error => { reason ??= error; });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (reason) return fail(reason);
      if (code !== 0) {
        const tail = (err.trim() || out.trim().split(/\r?\n/u).at(-1) || '').slice(-500);
        return fail(new Error(`REA ${label}失败（退出码 ${code}）：${tail}`));
      }
      let document;
      try { document = JSON.parse(out); } catch { document = lastMatching(out, accept); }
      if (!accept(document)) return fail(new Error(missing));
      ok(document);
    });
  }));
}

export function runAnalysis({ reaPath, target, evidencePath, timeoutMs = 120000, signal }) {
  return runJson({ reaPath, timeoutMs, signal, label: '分析', missing: 'REA 未返回可识别的分析摘要。',
    args: ['analyze-javascript-application', target, '--format', 'json', '--detail', 'summary', '--evidence_output', evidencePath],
    accept: doc => typeof doc?.summary?.evidence_id === 'string' });
}

function browserEvidence(reaPath, verb, args, signal) {
  return runJson({ reaPath, args: [verb, ...args, '--format', 'json'], timeoutMs: 40000, signal, label: verb,
    missing: `REA 未返回 ${verb} 证据。`, accept: doc => doc?.operation === verb.replaceAll('-', '_') &&
      evidencePattern.test(doc.evidence_id ?? '') && doc.normalized_result !== null && typeof doc.normalized_result === 'object' });
}

export const listBrowserTargets = ({ reaPath, endpoint, origin, signal }) =>
  browserEvidence(reaPath, 'list-browser-targets', [endpoint, '--allowed-origins', origin], signal);
export const captureWebScreenshot = ({ reaPath, endpoint, target, origin, signal }) =>
  browserEvidence(reaPath, 'capture-web-screenshot', [endpoint, target, '--allowed-origins', origin], signal);
export const compareWebScreenshots = ({ reaPath, before, after, channelThreshold, signal }) =>
  browserEvidence(reaPath, 'compare-web-screenshots', [before, after, '--channel-threshold', String(channelThreshold)], signal);

async function samePath(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const [a, b] = await Promise.all([realpath(left).catch(() => null), realpath(right).catch(() => null)]);
  return a !== null && a === b;
}

// Bind the analysis to THIS artifact: same path, same root digest, same evidence file.
export async function verifyBinding({ target, evidencePath, view, signal }) {
  const checks = [];
  const check = (name, ok, detail) => { checks.push(ok ? { name, ok } : { name, ok, detail }); return ok; };
  const evidence = view?.summary;
  const parentId = evidence?.normalized_result?.parent_evidence_id;
  const viewRoot = evidence?.normalized_result?.summary?.root_artifact_sha256;
  const viewArtifact = evidence?.normalized_result?.artifact?.sha256;
  check('view-shape', evidencePattern.test(evidence?.evidence_id ?? '') && evidencePattern.test(parentId ?? ''), '摘要视图的 evidence_id 或 parent_evidence_id 不合法');
  check('view-digest', digestPattern.test(viewRoot ?? '') && digestPattern.test(viewArtifact ?? ''), '摘要视图缺少合法的制品哈希');
  let parent = null;
  let bytes = null;
  try {
    bytes = (await stat(evidencePath)).size;
    const doc = JSON.parse((await readBounded(evidencePath, 64 * 1024 * 1024, signal)).toString('utf8'));
    parent = (doc.records ?? []).find(record => record?.operation === 'analyze_javascript_application') ?? null;
    check('evidence-readable', parent !== null, '证据包中没有 analyze_javascript_application 记录');
  } catch (error) {
    signal?.throwIfAborted();
    check('evidence-readable', false, error.message);
  }
  if (parent) {
    const parentRoot = parent?.normalized_result?.root_artifact_sha256;
    const parentSubject = parent?.subject?.digest?.sha256;
    check('parent-operation', parent.evidence_id === parentId, '摘要视图未指向证据包里的这次分析');
    check('artifact-path', await samePath(parent?.subject?.local_path, target), `证据包记录的路径不是当前素材：${parent?.subject?.local_path ?? '缺失'}`);
    check('parent-root-digest', digestPattern.test(parentRoot ?? '') && parentRoot === parentSubject, '证据包自身的根哈希与受试对象哈希不一致');
    check('view-root-digest', parentRoot === viewRoot && viewRoot === viewArtifact, '摘要视图的根哈希与证据包不一致');
    check('evidence-bytes', bytes !== null && bytes === view?.evidence_bundle?.bytes, `证据文件字节数与摘要声明不符：${bytes} ≠ ${view?.evidence_bundle?.bytes}`);
  }
  const ok = checks.length > 0 && checks.every(item => item.ok);
  return {
    status: ok ? 'verified' : 'mismatch',
    artifactSha256: ok ? viewRoot : null,
    evidenceId: ok ? evidence.evidence_id : null,
    parentEvidenceId: ok ? parentId : null,
    checks,
  };
}
