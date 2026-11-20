import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join } from 'node:path';
import { inventory } from './inventory.mjs';
import { localPath, readBounded, relativeInput, rootDir, within } from './paths.mjs';
import { probeRea, projectReaSummary } from './rea.mjs';

const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const readJson = async (path, max, signal) => JSON.parse((await readBounded(path, max, signal)).toString('utf8'));
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
const header = ({ rows, ...rest }) => rest;

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
  async function probe(signal) {
    signal?.throwIfAborted();
    let directories;
    try { await roots(config); directories = { ready: true }; }
    catch (error) { directories = { ready: false, reason: error.code === 'ENOENT' ? '素材根或档案根不存在。' : error.message }; }
    return { pluginVersion: '0.1.0', directories, rea: await probeRea(setting(config.reaPath) ?? '', signal) };
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
      const run = { schemaVersion: 1, id, runId, createdAt: new Date().toISOString(), source: current.data.location, rea, ...notes };
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
    if (kind !== undefined && !['asset', 'token', 'reference', 'navigation'].includes(kind)) throw new Error('未知证据类别。');
    const record = await target(id, signal);
    const filenames = await runsFor(record.archive, id, signal);
    const name = runId === undefined ? filenames[0] : `${runId}.json`;
    if (!name || !filenames.includes(name)) throw new Error('这批证据不存在。');
    const path = (await localPath(record.archive, [id, 'runs', name])).path;
    const data = await readJson(path, 16 * 1024 * 1024, signal);
    if (data.id !== id || data.runId !== name.slice(0, -5) || !Array.isArray(data.rows)) throw new Error('证据索引无效。');
    const rows = kind === undefined ? data.rows : data.rows.filter(row => row.kind === kind);
    return { ...header(data), offset, total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null, rows: rows.slice(offset, offset + limit) };
  }
  return { probe, add, dissect, status, list, dossier };
}

function checkPage(offset, limit, upper) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > upper) throw new Error(`分页每次 1–${upper} 条，偏移须为非负整数。`);
}
