import { spawn } from 'node:child_process';
import { delimiter, extname, isAbsolute, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { readBounded } from './paths.mjs';

const launcher = /^@echo off\r?\n"([A-Za-z]:\\[^"\r\n]+\\node\.exe)" "([A-Za-z]:\\[^"\r\n]+\.mjs)" %\*\r?\n?$/iu;
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

// Deliberately project only static inventory metadata, not the full REA graph.
export async function projectReaSummary(path, signal) {
  const doc = JSON.parse((await readBounded(path, 512 * 1024, signal)).toString('utf8'));
  const evidence = doc.summary;
  const normalized = evidence?.normalized_result;
  const id = evidence?.evidence_id;
  const parentId = normalized?.parent_evidence_id;
  const digest = normalized?.artifact?.sha256;
  if (normalized?.parent_operation !== 'analyze_javascript_application' || !/^ev_[a-f0-9]{64}$/u.test(id ?? '') || !/^ev_[a-f0-9]{64}$/u.test(parentId ?? '') || !/^[a-f0-9]{64}$/u.test(digest ?? '')) throw new Error('请导入 REA JavaScript 应用分析的 JSON 摘要，而非完整图谱。');
  const stats = {};
  for (const name of ['relevant_files', 'text_bytes_read', 'parsed_javascript_files', 'skipped_javascript_files', 'parse_failures']) {
    const value = normalized.summary?.statistics?.[name];
    if (Number.isSafeInteger(value) && value >= 0) stats[name] = value;
  }
  return { source: 'imported-rea-summary', binding: 'declared-not-verified', evidenceId: id, parentEvidenceId: parentId, declaredArtifactSha256: digest, stats };
}
