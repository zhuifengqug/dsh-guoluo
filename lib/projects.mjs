import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { rowsToCsv, rowsToMarkdown, renderExportJson } from './export.mjs';
import { checkEvidence } from './check.mjs';
import { inventory } from './inventory.mjs';
import { buildMock, server as serverSource } from './mock.mjs';
import { localPath, readBounded, relativeInput, rootDir, within } from './paths.mjs';
import { probeRea, projectReaSummary } from './rea.mjs';
import { buildSpec, renderSpecMarkdown } from './spec.mjs';
import { collectTokens, renderTailwindCss, renderTokensCss, renderTokensJson } from './tokens.mjs';

const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const readJson = async (path, max, signal) => JSON.parse((await readBounded(path, max, signal)).toString('utf8'));
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
const header = ({ rows, ...rest }) => rest;
const kinds = ['asset', 'token', 'navigation', 'reference'];
const formats = { csv: 'assets.csv', json: 'assets.json', markdown: 'assets.md' };

const setting = value => typeof value?.get === 'function' ? value.get() : value;

async function roots(config) {
  const source = await rootDir(setting(config.sourceRoot), '素材根');
  const archive = await rootDir(setting(config.archiveRoot), '档案根');
  if (within(source, archive) || within(archive, source)) throw new Error('素材根与档案根必须是两个互不包含的目录。');
  return { source, archive };
}

function inputUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入完整 HTTP(S) URL。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只接受不含登录信息的 HTTP(S) URL。');
  return `${url.origin}${url.pathname}`;
}

export function projectService(config) {
  const active = new Set();
  async function target(id, signal) {
    signal?.throwIfAborted();
    if (!idPattern.test(id ?? '')) throw new Error('档案 ID 格式错误。');
    const directories = await roots(config);
    const file = await localPath(directories.archive, [id, 'target.json']);
    const data = await readJson(file.path, 8192, signal);
    if (data.id !== id || data.schemaVersion !== 1) throw new Error('档案索引无效。');
    return { ...directories, data, folder: join(directories.archive, id) };
  }
  async function runsFor(archive, id, signal) {
    const path = (await localPath(archive, [id, 'runs'])).path;
    return (await readdir(path, { withFileTypes: true })).filter(entry => entry.isFile() && /^\d{13}-[0-9a-f-]{36}\.json$/u.test(entry.name))
      .map(entry => entry.name).sort().reverse();
  }
  async function loadRun(record, id, runId, signal) {
    const filenames = await runsFor(record.archive, id, signal);
    const name = runId === undefined ? filenames[0] : `${runId}.json`;
    if (!name || !filenames.includes(name)) throw new Error('这批证据不存在。');
    const path = (await localPath(record.archive, [id, 'runs', name])).path;
    const data = await readJson(path, 16 * 1024 * 1024, signal);
    if (data.id !== id || data.runId !== name.slice(0, -5) || !Array.isArray(data.rows)) throw new Error('证据索引无效。');
    return data;
  }
  async function ensureDir(record, name) {
    const dir = join(record.folder, name);
    if (!within(record.archive, dir)) throw new Error('输出目录越界。');
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  async function writeDerived(dir, name, content, signal) {
    const temporary = join(dir, `.new-${name}`);
    signal?.throwIfAborted();
    await rm(temporary, { force: true });
    await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    signal?.throwIfAborted();
    const final = join(dir, name);
    await rename(temporary, final);
    return final;
  }
  async function probe(signal) {
    signal?.throwIfAborted();
    let directories;
    try { await roots(config); directories = { ready: true }; }
    catch (error) { directories = { ready: false, reason: error.code === 'ENOENT' ? '素材根或档案根不存在。' : error.message }; }
    return { pluginVersion: '0.2.0', directories, rea: await probeRea(setting(config.reaPath) ?? '', signal) };
  }
  async function add({ location, kind, label }, signal) {
    signal?.throwIfAborted();
    if (typeof location !== 'string' || !location.length || location.length > 1000) throw new Error('输入路径或 URL 的长度无效。');
    if (label !== undefined && (typeof label !== 'string' || !label.trim() || label.length > 80 || /[\x00-\x1f]/u.test(label))) throw new Error('请输入一行、不超过 80 字符的名称。');
    const directories = await roots(config);
    let data;
    if (kind === 'url') {
      const url = inputUrl(location);
      data = { kind, location: url, label: label?.trim() ?? new URL(url).hostname };
    } else if (kind === 'local') {
      const parts = relativeInput(location);
      const { stat } = await localPath(directories.source, parts);
      if (!stat.isDirectory() && !(stat.isFile() && /\.(html?|css|asar)$/iu.test(parts.at(-1)))) throw new Error('只接受目录、HTML/CSS 或 ASAR。');
      data = { kind, location: parts.join('/'), label: label?.trim() ?? parts.at(-1) };
    } else throw new Error('请选择 local 或 url。');
    const id = randomUUID();
    const record = { schemaVersion: 1, id, ...data, createdAt: new Date().toISOString() };
    const temp = join(directories.archive, `.new-${id}`);
    signal?.throwIfAborted();
    await mkdir(temp, { mode: 0o700 });
    try {
      await mkdir(join(temp, 'runs'), { mode: 0o700 });
      await writeJson(join(temp, 'target.json'), record);
      signal?.throwIfAborted();
      await rename(temp, join(directories.archive, id));
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
    return { ...record, status: 'registered' };
  }
  async function dissect({ id, reaSummary }, signal) {
    const current = await target(id, signal);
    if (current.data.kind !== 'local') throw new Error('URL 只作登记。请把导出的素材放进素材根，登记一本地档案后盘点。');
    const key = current.folder;
    if (active.has(key)) throw new Error('这个档案已有盘点在运行。');
    active.add(key);
    const startedAt = Date.now();
    try {
      const local = await localPath(current.source, relativeInput(current.data.location));
      const notes = await inventory({ ...local, label: basename(local.path) }, signal);
      let rea = null;
      if (reaSummary !== undefined) {
        if (extname(reaSummary).toLowerCase() !== '.json') throw new Error('请指定素材根内的 REA 摘要 JSON。');
        rea = await projectReaSummary((await localPath(current.source, relativeInput(reaSummary))).path, signal);
        notes.notes.push('REA 摘要由外部导入；声明的制品哈希未与当前素材校验。');
      }
      const folder = (await localPath(current.archive, [id, 'runs'])).path;
      const runId = `${Date.now()}-${randomUUID()}`;
      const meter = { durationMs: Date.now() - startedAt, rows: notes.rows.length, textBytes: notes.coverage.textBytes, visited: notes.coverage.visited };
      const run = { schemaVersion: 1, id, runId, createdAt: new Date().toISOString(), source: current.data.location, meter, rea, ...notes };
      const temp = join(folder, `.new-${runId}`);
      const final = join(folder, `${runId}.json`);
      signal?.throwIfAborted();
      try { await writeJson(temp, run); signal?.throwIfAborted(); await rename(temp, final); }
      catch (error) { await rm(temp, { force: true }); throw error; }
      return header(run);
    } finally { active.delete(key); }
  }
  async function status({ id }, signal) {
    const record = await target(id, signal);
    const filenames = await runsFor(record.archive, id, signal);
    const latest = filenames[0]?.slice(0, -5) ?? null;
    return { ...record.data, status: latest ? 'inventoried' : 'registered', latest, runCount: filenames.length, running: active.has(record.folder) };
  }
  async function list({ offset = 0, limit = 20 } = {}, signal) {
    checkPage(offset, limit, 50);
    const { archive } = await roots(config);
    signal?.throwIfAborted();
    const names = (await readdir(archive, { withFileTypes: true })).filter(entry => entry.isDirectory() && idPattern.test(entry.name)).map(entry => entry.name).sort();
    const targets = [];
    for (const id of names.slice(offset, offset + limit)) {
      signal?.throwIfAborted();
      try { targets.push(await status({ id }, signal)); }
      catch { signal?.throwIfAborted(); targets.push({ id, status: 'unreadable' }); }
    }
    return { offset, nextOffset: offset + limit < names.length ? offset + limit : null, total: names.length, targets };
  }
  async function dossier({ id, runId, kind, offset = 0, limit = 20 }, signal) {
    checkPage(offset, limit, 50);
    if (kind !== undefined && !kinds.includes(kind)) throw new Error('未知证据类别。');
    const record = await target(id, signal);
    const data = await loadRun(record, id, runId, signal);
    const rows = kind === undefined ? data.rows : data.rows.filter(row => row.kind === kind);
    return { ...header(data), offset, total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null, rows: rows.slice(offset, offset + limit) };
  }
  async function spec({ id, runId }, signal) {
    const record = await target(id, signal);
    const data = await loadRun(record, id, runId, signal);
    const createdAt = new Date().toISOString();
    const label = record.data.label;
    const built = buildSpec({ id, runId: data.runId, run: data, label, createdAt });
    const dir = await ensureDir(record, 'spec');
    const json = await writeDerived(dir, 'spec.json', `${JSON.stringify(built.spec, null, 2)}\n`, signal);
    const markdown = await writeDerived(dir, 'spec.md', renderSpecMarkdown({ spec: built.spec, notes: data.notes ?? [] }), signal);
    return {
      id, runId: data.runId, generatedAt: createdAt,
      obligations: built.spec.obligations.length, counts: built.counts,
      conflicts: built.conflicts.length, unknowns: built.spec.unknowns.length,
      files: { json, markdown },
    };
  }
  async function tokens({ id, runId }, signal) {
    const record = await target(id, signal);
    const data = await loadRun(record, id, runId, signal);
    const collected = collectTokens(data.rows);
    const createdAt = new Date().toISOString();
    const dir = await ensureDir(record, 'tokens');
    const css = await writeDerived(dir, 'tokens.css', renderTokensCss({ id, runId: data.runId, collected }), signal);
    const tailwind = await writeDerived(dir, 'tokens.tailwind.css', renderTailwindCss({ id, runId: data.runId, collected }), signal);
    const json = await writeDerived(dir, 'tokens.json', `${JSON.stringify(renderTokensJson({ id, runId: data.runId, createdAt, collected }), null, 2)}\n`, signal);
    return { id, runId: data.runId, generatedAt: createdAt, total: collected.total, occurrences: collected.occurrences, conflicts: collected.conflicts.length, files: { css, tailwind, json } };
  }
  async function exportRows({ id, runId, format = 'json', kind }, signal) {
    if (!Object.hasOwn(formats, format)) throw new Error('导出格式请用 json、markdown 或 csv。');
    if (kind !== undefined && !kinds.includes(kind)) throw new Error('未知证据类别。');
    const record = await target(id, signal);
    const data = await loadRun(record, id, runId, signal);
    const rows = kind === undefined ? data.rows : data.rows.filter(row => row.kind === kind);
    const meta = { id, runId: data.runId, createdAt: new Date().toISOString(), source: data.source, label: record.data.label };
    let content;
    if (format === 'csv') content = rowsToCsv(rows);
    else if (format === 'markdown') content = rowsToMarkdown(rows, { ...meta, generatedAt: meta.createdAt });
    else content = `${JSON.stringify(renderExportJson({ ...meta, rows, totals: data.totals, coverage: data.coverage }), null, 2)}\n`;
    const dir = await ensureDir(record, 'export');
    const file = await writeDerived(dir, formats[format], content, signal);
    return { id, runId: data.runId, format, kind: kind ?? null, count: rows.length, bytes: Buffer.byteLength(content, 'utf8'), file };
  }
  async function mock({ id, runId, port = 5173 }, signal) {
    if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('端口请用 1024–65535 之间的整数。');
    const record = await target(id, signal);
    const data = await loadRun(record, id, runId, signal);
    const local = await localPath(record.source, relativeInput(record.data.location));
    const built = buildMock({ id, runId: data.runId, run: data, port });
    built.mock.assets = built.mock.assets.map(item => ({ ...item, root: local.path }));
    const dir = await ensureDir(record, 'mock');
    const config = await writeDerived(dir, 'mock.json', `${JSON.stringify(built.mock, null, 2)}\n`, signal);
    const script = await writeDerived(dir, 'server.mjs', serverSource, signal);
    return { id, runId: data.runId, port, ...built.counts, files: { config, server: script }, start: `node "${script}"` };
  }
  async function check({ id, runId }, signal) {
    const record = await target(id, signal);
    const data = await loadRun(record, id, runId, signal);
    const built = buildSpec({ id, runId: data.runId, run: data, label: record.data.label, createdAt: new Date().toISOString() });
    let stored = null;
    try {
      const path = (await localPath(record.archive, [id, 'spec', 'spec.json'])).path;
      const parsed = await readJson(path, 4 * 1024 * 1024, signal);
      stored = { runId: parsed.runId, obligations: Array.isArray(parsed.obligations) ? parsed.obligations.length : -1 };
    } catch { signal?.throwIfAborted(); stored = null; }
    const result = checkEvidence({ spec: built.spec, run: data, stored });
    const createdAt = new Date().toISOString();
    const dir = await ensureDir(record, 'checks');
    const file = await writeDerived(dir, `check-${Date.now()}.json`, `${JSON.stringify({ schemaVersion: 1, id, runId: data.runId, generatedAt: createdAt, ...result }, null, 2)}\n`, signal);
    return { id, runId: data.runId, generatedAt: createdAt, verdict: result.verdict, orphans: result.orphans.length, dangling: result.dangling.length, stale: result.stale, conflicts: result.conflicts.length, file };
  }
  return { probe, add, dissect, status, list, dossier, spec, tokens, export: exportRows, mock, check };
}

function checkPage(offset, limit, upper) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > upper) throw new Error(`分页每次 1–${upper} 条，偏移须为非负整数。`);
}
