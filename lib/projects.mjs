import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { rowsToCsv, rowsToMarkdown, renderExportJson } from './export.mjs';
import { renderBrief } from './brief.mjs';
import { checkCandidate, checkEvidence } from './check.mjs';
import { inventory } from './inventory.mjs';
import { buildMock, server as serverSource } from './mock.mjs';
import { localPath, maxAssetHashFileBytes, readBounded, relativeInput, rootDir, within } from './paths.mjs';
import { probeRea, runAnalysis, verifyBinding } from './rea.mjs';
import { publishPack, renderPackIndex, summarizePack } from './pack.mjs';
import { planScaffold, scaffoldHardLimits, scaffoldLimits, sealManifest } from './scaffold.mjs';
import { renderStructureReport, structureLimits } from './structure.mjs';
import { buildSpec, renderSpecMarkdown } from './spec.mjs';
import { collectTokens, renderTailwindCss, renderTokensCss, renderTokensJson } from './tokens.mjs';
import { comparePages, maxRoutes, visualPage } from './visual.mjs';
import { unityCandidate } from './unity.mjs';
import { parsePe } from './pe.mjs';
import { readIl2cppPage } from './il2cpp.mjs';
import { readFileSync } from 'node:fs';

const { version: pluginVersion } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const idPattern = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u;
const readJson = async (path, max, signal) => JSON.parse((await readBounded(path, max, signal)).toString('utf8'));
const writeJson = (path, value) => writeFile(path, `${JSON.stringify(value)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
// 概要只回显可核对的数量与状态：清单正文（权限、活动逐条）一律走 dossier 的专用类别分页读，
// 这样 dissect/status/spec 的返回不会因为一部 APK 声明了上千条权限而整批回灌。
const listSummary = (manifest, field, label) => {
  const items = Array.isArray(manifest?.[field]) ? manifest[field] : null;
  const page = manifest?.[`${field}Page`];
  return {
    label,
    total: Number.isSafeInteger(manifest?.[`${field}Total`]) ? manifest[`${field}Total`] : Number.isSafeInteger(page?.total) ? page.total : items ? items.length : null,
    retained: Number.isSafeInteger(manifest?.[`${field}Retained`]) ? manifest[`${field}Retained`] : items ? items.length : null,
    truncated: typeof manifest?.[`${field}Truncated`] === 'boolean' ? manifest[`${field}Truncated`] : typeof page?.truncated === 'boolean' ? page.truncated : null,
    note: manifest?.[`${field}Note`] ?? null,
  };
};
const apkSummary = apk => !apk ? null : {
  counts: apk.counts ?? null,
  abis: apk.abis ?? [],
  manifestStatus: apk.manifestStatus ?? null,
  scanned: apk.scanned ?? null,
  scanTruncated: apk.scanTruncated ?? null,
  manifest: apk.manifest ? {
    package: apk.manifest.package ?? null,
    versionCode: apk.manifest.versionCode ?? null,
    versionName: apk.manifest.versionName ?? null,
    minSdk: apk.manifest.minSdk ?? null,
    targetSdk: apk.manifest.targetSdk ?? null,
    label: apk.manifest.label ?? null,
    launcherActivity: apk.manifest.launcherActivity ?? null,
    activityAliases: apk.manifest.activityAliases ?? null,
    permissions: listSummary(apk.manifest, 'permissions', '权限'),
    activities: listSummary(apk.manifest, 'activities', '活动'),
  } : null,
  detail: '权限与活动列表用 guoluo_dossier kind=apk-permission / kind=apk-activity 按 offset/limit 分页读取。',
};
const header = ({ rows, pe, unity, apk, ...rest }) => ({
  ...rest,
  ...(apk ? { apk: apkSummary(apk) } : {}),
  ...(unity ? { unity: { files: unity.length, headersRead: unity.filter(item => item.status === 'header-read' || item.status === 'parsed' || item.status === 'unverified').length, detail: '逐文件头部证据见 guoluo_dossier kind=binary。' } } : {}),
  ...(pe ? {
    pe: {
      files: pe.length,
      parsed: pe.filter(item => item.status === 'parsed').length,
      unreadable: pe.filter(item => item.status === 'unreadable').length,
      paths: pe.slice(0, 50).map(item => ({ path: item.path, status: item.status })),
      detail: '逐文件明细用 guoluo_dossier kind=binary 分页读取；完整导入符号与命名导出用 kind=pe-imports / kind=pe-exports 按 offset/limit 分页读。',
    },
  } : {}),
});
const kinds = ['asset', 'token', 'navigation', 'reference', 'binary'];
// APK 清单列表不是证据行，而是随批次落盘的清单正文：单独两个类别，按固定 runId 读档续页。
const apkKinds = { 'apk-permission': 'permissions', 'apk-activity': 'activities' };
// PE 的导入/导出符号在盘点时只留前若干条，全量按固定 runId 读源文件现解析现分页。
const peKinds = { 'pe-imports': 'imports', 'pe-exports': 'exports' };
const il2cppKinds = ['il2cpp-types', 'il2cpp-fields'];
const dossierKinds = [...kinds, ...Object.keys(apkKinds), ...Object.keys(peKinds), ...il2cppKinds];
// 一页证据的序列化上限：单条再大也必须能整条回，所以只截条数不截字段。
const pageBytes = 512 * 1024;
const formats = { csv: 'assets.csv', json: 'assets.json', markdown: 'assets.md' };
const invalid = message => Object.assign(new Error(message), { kind: 'invalid-input' });
const asInvalid = async run => {
  try { return await run(); } catch (error) { throw error?.kind ? error : invalid(String(error?.message ?? error)); }
};

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
    return { pluginVersion, directories, rea: await probeRea(setting(config.reaPath) ?? '', signal) };
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
      if (!stat.isDirectory() && !(stat.isFile() && (/\.(html?|css|asar|apk|pck|exe|dll)$/iu.test(parts.at(-1)) || unityCandidate(parts.at(-1))))) throw new Error('只接受目录、HTML/CSS、ASAR、APK、PCK、PE 或 Unity 素材文件。');
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
  const statNames = ['relevant_files', 'text_bytes_read', 'parsed_javascript_files', 'skipped_javascript_files', 'parse_failures', 'nested_asar_containers', 'findings'];
  const clampTimeout = value => Number.isSafeInteger(value) ? Math.min(Math.max(value, 10000), 1800000) : 180000;
  async function analyzeRea({ record, local, runId, enabled, timeoutMs, notes, signal }) {
    if (!enabled) return { status: 'off', reason: '已按要求跳过 REA 分析。' };
    if (!local.stat.isDirectory()) return { status: 'skipped', reason: 'REA 的 JavaScript 自动分析只接收目录。' };
    const configured = setting(config.reaPath) ?? '';
    const probe = await probeRea(configured, signal);
    if (probe.status !== 'available') return { status: 'unavailable', reason: probe.reason };
    const dir = await ensureDir(record, join('rea', runId));
    const evidencePath = join(dir, 'evidence.json');
    try {
      const view = await runAnalysis({ reaPath: configured, target: local.path, evidencePath, timeoutMs: clampTimeout(timeoutMs), signal });
      const binding = await verifyBinding({ target: local.path, evidencePath, view, signal });
      const source = view?.summary?.normalized_result?.summary?.statistics ?? {};
      const stats = {};
      for (const name of statNames) if (Number.isSafeInteger(source[name]) && source[name] >= 0) stats[name] = source[name];
      const bytes = (await stat(evidencePath)).size;
      notes.notes.push(binding.status === 'verified'
        ? `REA ${probe.version} 自动分析完成，摘要与本次素材的根哈希、证据字节数逐项对上。`
        : 'REA 自动分析已运行，但摘要与本次素材的绑定校验未通过，这批行为侧证据不可作结论依据。');
      return {
        status: 'analyzed',
        version: probe.version,
        binding: { status: binding.status, checks: binding.checks },
        artifactSha256: binding.artifactSha256,
        evidenceId: binding.evidenceId,
        parentEvidenceId: binding.parentEvidenceId,
        stats,
        evidence: { path: `rea/${runId}/evidence.json`, bytes },
      };
    } catch (error) {
      signal?.throwIfAborted();
      notes.notes.push(`REA 自动分析未完成：${error.message}；静态盘点结果不受影响。`);
      return { status: 'failed', reason: error.message };
    }
  }
  async function dissect({ id, rea, reaTimeoutMs }, signal) {
    const current = await target(id, signal);
    if (current.data.kind !== 'local') throw new Error('URL 只作登记。请把导出的素材放进素材根，登记一本地档案后盘点。');
    const key = current.folder;
    if (active.has(key)) throw new Error('这个档案已有盘点在运行。');
    active.add(key);
    const startedAt = Date.now();
    const runId = `${Date.now()}-${randomUUID()}`;
    try {
      const local = await localPath(current.source, relativeInput(current.data.location));
      const notes = await inventory({ ...local, label: basename(local.path) }, signal);
      const reaState = await analyzeRea({ record: current, local, runId, enabled: rea !== false, timeoutMs: reaTimeoutMs, notes, signal });
      const folder = (await localPath(current.archive, [id, 'runs'])).path;
      const meter = { durationMs: Date.now() - startedAt, rows: notes.rows.length, textBytes: notes.coverage.textBytes, visited: notes.coverage.visited };
      const run = { schemaVersion: 2, id, runId, createdAt: new Date().toISOString(), source: current.data.location, meter, rea: reaState, ...notes };
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
  // APK 权限与活动只从落盘批次读：旧批次只存首页，后续页一律标记需重新盘点，不回读素材根伪造历史证据。
  function apkPage({ data, kind, offset, limit }) {
    const field = apkKinds[kind];
    const label = kind === 'apk-permission' ? '权限' : '活动';
    if (!data.apk) throw new Error(`这批证据没有 APK 盘点结果，${label}列表不可读。`);
    const manifest = data.apk.manifest;
    const items = Array.isArray(manifest?.[field]) ? manifest[field] : null;
    if (!items) throw new Error(`这批证据没有落盘的 APK ${label}列表；重新盘点后再读。`);
    const list = listSummary(manifest, field, label);
    const legacy = !Number.isSafeInteger(manifest[`${field}Retained`]);
    const retained = Math.min(list.retained ?? items.length, items.length);
    const page = [];
    let bytes = 0;
    let clipped = 0;
    const candidates = items.slice(offset, offset + limit);
    for (const [index, name] of candidates.entries()) {
      const row = { kind, name };
      const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
      if (page.length && bytes + size > pageBytes) { clipped = candidates.length - index; break; }
      page.push(row);
      bytes += size;
    }
    const consumed = offset + page.length;
    const nextOffset = consumed < retained ? consumed : null;
    const incomplete = list.total !== null && list.total > retained;
    return {
      ...header(data), kind, offset, limit,
      total: list.total, retained, returned: page.length, nextOffset,
      truncated: nextOffset !== null,
      incomplete,
      stale: legacy,
      reInventoryRequired: legacy || incomplete,
      bytes,
      clipped: clipped ? `本页受 ${pageBytes} 字节上限截断。` : null,
      note: legacy
        ? `这批证据只保留${label}首页（${items.length} 条），后续页需重新盘点。`
        : incomplete ? list.note ?? `原始 ${list.total} 条，仅保留 ${retained} 条；其余需重新盘点。` : list.note,
      rows: page,
    };
  }
  // 批次用于选定路径；符号来自当前源文件，不是历史快照。
  async function pePage({ record, data, kind, path, offset, limit, signal }) {
    const files = Array.isArray(data.pe) ? data.pe : [];
    if (!files.length) throw new Error('这批证据没有 PE 静态解析结果。');
    const wanted = path === undefined ? (files.length === 1 ? files[0].path : null) : path;
    if (!wanted) throw new Error('这批证据登记了多个 PE 文件，请用 path 指明要读哪一个。');
    const entry = files.find(item => item.path === wanted);
    if (!entry) throw new Error('这批证据里没有登记该 PE 文件。');
    const field = peKinds[kind];
    let table;
    try {
      const location = record.data.location.split('/');
      const registered = await localPath(record.source, location);
      const base = registered.stat.isDirectory() ? location : location.slice(0, -1);
      const source = await localPath(record.source, [...base, ...entry.path.split('/')]);
      const facts = await parsePe(source.path, signal, { nameLimit: 20000, descriptorLimit: 512 });
      table = facts[field];
    } catch (error) {
      signal?.throwIfAborted();
      table = { status: 'unreadable', items: [], reason: `无法从当前源文件读取符号表：${error.message}` };
    }
    const rows = [];
    let total;
    if (field === 'imports') {
      const dlls = table.items;
      total = dlls.reduce((sum, item) => sum + item.symbols.length, 0);
      let index = 0;
      for (const item of dlls) {
        for (const symbol of item.symbols) {
          if (index++ < offset) continue;
          if (rows.length === limit) break;
          rows.push({ kind, dll: item.dll, symbol: symbol.name ?? `#${symbol.ordinal}` });
        }
        if (rows.length === limit) break;
      }
    } else {
      const named = table.items;
      total = named.length;
      for (const item of named.slice(offset, offset + limit)) rows.push({ kind, name: item.name, ordinal: item.ordinal });
    }
    const consumed = offset + rows.length;
    const nextOffset = rows.length && consumed < total ? consumed : null;
    const incomplete = table.status === 'partial' || table.status === 'unreadable';
    return {
      ...header(data), kind, path: entry.path, offset, limit, source: 'current-file',
      total, returned: rows.length,
      ...(field === 'exports' ? { namedCount: table.namedCount ?? (table.status === 'absent' ? 0 : null) } : {}),
      nextOffset, status: table.status, truncated: nextOffset !== null, incomplete,
      note: table.status === 'partial'
        ? '符号表超过读取预算；只能翻阅已解析的条目，翻页结束不代表读完整张表。'
        : table.reason ?? null,
      rows,
    };
  }
  async function il2cppPage({ record, data, kind, path, offset, limit, signal }) {
    const files = Array.isArray(data.unity) ? data.unity.filter(item => item.kind === 'il2cpp-metadata') : [];
    if (!files.length) throw new Error('这批证据没有 IL2CPP 元数据文件。');
    const wanted = path === undefined ? (files.length === 1 ? files[0].path : null) : path;
    if (!wanted) throw new Error('这批证据登记了多个 IL2CPP 元数据文件，请用 path 指明要读哪一个。');
    const entry = files.find(item => item.path === wanted);
    if (!entry) throw new Error('这批证据里没有登记该 IL2CPP 元数据文件。');
    const base = { ...header(data), kind, path: entry.path, offset, limit, source: 'current-file' };
    try {
      const location = record.data.location.split('/');
      const registered = await localPath(record.source, location);
      const root = registered.stat.isDirectory() ? location : location.slice(0, -1);
      const source = await localPath(record.source, [...root, ...entry.path.split('/')]);
      const page = await readIl2cppPage(source.path, source.stat.size, { kind, offset, limit, signal });
      return { ...base, ...page };
    } catch (error) {
      signal?.throwIfAborted();
      const unverified = /布局未核对/u.test(String(error?.message ?? ''));
      return {
        ...base, total: null, returned: 0, nextOffset: null, rows: [],
        status: unverified ? 'unverified' : 'unreadable',
        note: unverified ? String(error.message) : `无法从当前源文件读取元数据表：${String(error?.message ?? error).slice(0, 200)}`,
      };
    }
  }
  async function dossier({ id, runId, kind, offset = 0, limit = 20, path }, signal) {
    checkPage(offset, limit, 50);
    if (kind !== undefined && !dossierKinds.includes(kind)) throw new Error('未知证据类别。');
    const record = await target(id, signal);
    const data = await loadRun(record, id, runId, signal);
    if (kind !== undefined && Object.hasOwn(apkKinds, kind)) return apkPage({ data, kind, offset, limit });
    if (kind !== undefined && Object.hasOwn(peKinds, kind)) return pePage({ record, data, kind, path, offset, limit, signal });
    if (kind !== undefined && il2cppKinds.includes(kind)) return il2cppPage({ record, data, kind, path, offset, limit, signal });
    const rows = kind === 'binary'
      ? [...(data.pe ?? []), ...(data.unity ?? [])]
      : kind === undefined ? data.rows : data.rows.filter(row => row.kind === kind);
    // 单条证据可以很大（PE 导入表、Unity 块信息）。按序列化字节给一页设上限，
    // 保证工具输出不会因为一条记录就回灌整包里最贵的那段。
    const page = [];
    let bytes = 0;
    let clipped = 0;
    for (const row of rows.slice(offset, offset + limit)) {
      const size = Buffer.byteLength(JSON.stringify(row), 'utf8');
      if (page.length && bytes + size > pageBytes) { clipped = rows.length - offset - page.length; break; }
      page.push(row);
      bytes += size;
    }
    const consumed = offset + page.length;
    return {
      ...header(data), offset, limit, total: rows.length,
      nextOffset: consumed < rows.length ? consumed : null,
      bytes, clipped: clipped ? `本页受 ${pageBytes} 字节上限截断。` : null,
      rows: page,
    };
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
      conflicts: built.conflicts.length, unknowns: built.spec.unknowns.length, gaps: built.spec.unknowns,
      files: { json, markdown },
    };
  }
  async function brief({ id, runId }, signal) {
    if (typeof runId !== 'string' || !/^\d{13}-[0-9a-f-]{36}$/u.test(runId)) throw invalid('交接单需要明确的盘点批次 runId。');
    const record = await target(id, signal);
    const data = await loadRun(record, id, runId, signal);
    const built = buildSpec({ id, runId, run: data, label: record.data.label, createdAt: data.createdAt });
    const asar = data.notes?.includes('ASAR 仅盘点头部资产目录；未解包、未读取归档成员内容。');
    const markdown = renderBrief({ spec: built.spec, rows: data.rows, asar });
    signal?.throwIfAborted();
    await mkdir(join(record.folder, 'brief'), { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error;
    });
    const dir = (await localPath(record.archive, [id, 'brief'])).path;
    const temporary = join(dir, `.new-${randomUUID()}`);
    const file = join(dir, `${runId}.md`);
    try {
      await writeFile(temporary, markdown, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal });
      signal?.throwIfAborted();
      await rename(temporary, file);
    } catch (error) {
      if (error.code !== 'EEXIST') await rm(temporary, { force: true });
      throw error;
    }
    return { id, runId, file, bytes: Buffer.byteLength(markdown), counts: built.counts, unknowns: built.spec.unknowns.length };
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
  async function scaffold({ id, runId, name, files, fileBytes, totalBytes }, signal) {
    const record = await target(id, signal);
    if (record.data.kind !== 'local') throw invalid('工程骨架只接受本地档案。');
    const data = await loadRun(record, id, runId, signal);
    const local = await localPath(record.source, relativeInput(record.data.location));
    // 单文件的相邻素材不在登记范围内：只对目录型素材生成，避免按猜的路径去读素材根。
    if (!local.stat.isDirectory()) throw invalid('工程骨架需要目录型素材：单个 HTML/CSS 的相邻素材不在登记范围内。');
    const label = name ?? data.runId;
    if (typeof label !== 'string' || !/^[0-9A-Za-z._-]{1,80}$/u.test(label) || /^\.+$/u.test(label)) throw invalid('工程目录名请用 1–80 个字母、数字、点、下划线或连字符。');
    // 预算是上限而不是目标：只允许在硬上限内调高，避免一次生成把档案根写满。
    const budget = { ...scaffoldLimits };
    const clamp = (value, field, max, labelText) => {
      if (value === undefined || value === null) return;
      if (!Number.isSafeInteger(value) || value < 1 || value > max) throw invalid(`${labelText} 需为 1–${max} 的整数。`);
      budget[field] = value;
    };
    clamp(files, 'files', scaffoldHardLimits.files, '单次复制的文件数上限');
    clamp(fileBytes, 'fileBytes', scaffoldHardLimits.fileBytes, '单个文件的字节上限');
    clamp(totalBytes, 'totalBytes', scaffoldHardLimits.totalBytes, '单次复制的总字节上限');
    const built = buildSpec({ id, runId: data.runId, run: data, label: record.data.label, createdAt: data.createdAt });
    const collected = collectTokens(data.rows);
    const read = async (rel, max) => {
      const file = await localPath(local.path, relativeInput(rel));
      if (!file.stat.isFile()) throw new Error('跳过非普通文件。');
      return readBounded(file.path, max, signal);
    };
    const planned = await planScaffold({
      id, runId: data.runId, run: data, spec: built.spec, collected,
      source: record.data.location, read, signal, limits: budget,
    });
    const digest = buffer => createHash('sha256').update(buffer).digest('hex');
    const evidence = await readEvidencePages(record, data, signal);
    // 候选侧只喂生成目录里真正落下的页面：复制的原页 + 生成的 _scaffold/index.html。
    const html = planned.files
      .filter(file => /\.html?$/u.test(file.path))
      .map(file => ({ path: file.path, text: Buffer.isBuffer(file.content) ? file.content.toString('utf8') : String(file.content) }));
    const coverage = checkCandidate({
      spec: built.spec,
      run: data,
      files: planned.files.map(file => ({ path: file.path, size: file.bytes, sha256: digest(file.content) })),
      css: planned.styles,
      html,
      evidencePages: evidence.pages,
    });
    const parent = await ensureDir(record, 'scaffold');
    const final = join(parent, label);
    if (!within(record.archive, final)) throw new Error('输出目录越界。');
    const temporary = join(parent, `.new-${randomUUID()}`);
    const manifest = sealManifest(planned.manifest, planned.files);
    try {
      await mkdir(temporary, { mode: 0o700 });
      for (const file of planned.files) {
        signal?.throwIfAborted();
        const path = join(temporary, ...file.path.split('/'));
        if (!within(temporary, path)) throw new Error('生成路径越界。');
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await writeFile(path, file.content, { flag: 'wx', mode: 0o600, signal });
      }
      await mkdir(join(temporary, '_scaffold'), { recursive: true, mode: 0o700 });
      await writeFile(join(temporary, '_scaffold', 'scaffold.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600, signal });
      signal?.throwIfAborted();
      await rename(temporary, final);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw invalid(`档案里已有 scaffold/${label}；换一个目录名再生成，或先手动移除旧目录。`);
      throw error;
    }
    const rel = `${id}/scaffold/${label}`;
    return {
      id, runId: data.runId, generatedAt: manifest.generatedAt,
      directory: rel,
      counts: planned.counts,
      web: planned.web,
      budget: planned.budget,
      tokens: { total: collected.total, conflicts: collected.conflicts.length },
      skipped: planned.skipped,
      skippedCount: planned.skipped.length + (planned.skipped.counted ?? 0),
      warnings: planned.warnings.slice(0, 10),
      warningCount: planned.warnings.length,
      coverage: {
        scope: coverage.scope,
        verdict: coverage.verdict,
        assets: { total: coverage.assets.total, present: coverage.assets.present.length, archived: coverage.assets.archived.length, missing: coverage.assets.missing.length, changed: coverage.assets.changed.length },
        structures: { total: coverage.structures.total, present: coverage.structures.present.length, missing: coverage.structures.missing.length },
        tokens: { total: coverage.tokens.total, declared: coverage.tokens.declared.length, missing: coverage.tokens.missing.length },
        values: { checked: coverage.values.checked, same: coverage.values.same, differs: coverage.values.differs.length },
        structure: {
          scope: coverage.structure.scope,
          comparedPages: coverage.structure.comparedPages,
          pages: { total: coverage.structure.pages.total, matched: coverage.structure.pages.matched, missing: coverage.structure.pages.missing.count, extra: coverage.structure.pages.extra.count },
          selectors: { total: coverage.structure.selectors.total, present: coverage.structure.selectors.present, missing: coverage.structure.selectors.missing.count },
          navigation: { total: coverage.structure.navigation.total, present: coverage.structure.navigation.present, elsewhere: coverage.structure.navigation.elsewhere, missing: coverage.structure.navigation.missing.count },
          hierarchy: { tags: coverage.structure.hierarchy.tags.count, edges: coverage.structure.hierarchy.edges.count, depths: coverage.structure.hierarchy.depths.count },
          unverified: coverage.structure.unverified.count,
          diverged: coverage.structure.diverged,
        },
        missing: coverage.assets.missing.slice(0, 10).map(item => item.target),
        note: coverage.note,
      },
      files: { manifest: `${rel}/_scaffold/scaffold.json`, routes: `${rel}/_scaffold/index.html`, readme: `${rel}/README.md` },
      start: `python -m http.server 8080 --directory "${final}"`,
    };
  }
  const visualSummary = visual => ({
    version: 'visual-summary/1',
    scope: visual.scope,
    status: visual.status,
    kind: visual.kind ?? null,
    reason: visual.reason ?? null,
    widths: visual.widths,
    height: visual.height,
    channelThreshold: visual.channelThreshold,
    thresholdNote: visual.thresholdNote,
    note: visual.note,
    routes: visual.routes.map(route => ({
      index: route.index,
      status: route.status,
      kind: route.kind ?? null,
      reason: route.reason ?? null,
      score: route.score ?? null,
      worstWidth: route.worstWidth ?? null,
      baselineEntry: route.baselineEntry ?? null,
      candidateEntry: route.candidateEntry ?? null,
      baselineHtmlSha256: route.baselineHtmlSha256 ?? null,
      candidateHtmlSha256: route.candidateHtmlSha256 ?? null,
      thresholdNote: route.thresholdNote ?? visual.thresholdNote,
      rounds: (route.rounds ?? []).map(round => ({
        width: round.width,
        status: round.status,
        kind: round.kind ?? null,
        changedPixels: round.changedPixels ?? null,
        changedRatio: round.changedRatio ?? null,
        rea: round.rea ?? null,
        computed: round.computed ?? null,
        conflict: round.conflict ?? null,
        diffFile: round.diffFile ?? null,
      })),
    })),
  });

async function checkVisual({ record, data, visual, dir, checkId, signal }) {
    if (!visual || typeof visual !== 'object' || record.data.kind !== 'local') throw invalid('视觉核对只接受本地静态 HTML 档案。');
    const originalParts = await asInvalid(async () => relativeInput(record.data.location));
    const source = await asInvalid(() => localPath(record.source, originalParts));
    const defaultEntry = source.stat.isFile() ? originalParts.at(-1) : 'index.html';
    const baselineRoot = source.stat.isDirectory() ? source.path : join(source.path, '..');
    const channelThreshold = visual.channelThreshold ?? 0;
    if (!Number.isInteger(channelThreshold) || channelThreshold < 0 || channelThreshold > 255) throw invalid('逐通道阈值须为 0–255 的整数。');
    if (visual.routes !== undefined && (visual.baselineEntry !== undefined || visual.candidateEntry !== undefined)) throw invalid('routes 与 baselineEntry/candidateEntry 不能同时给出。');
    // 旧的单入口写法等价于一条路由；默认入口仍是 index.html（单文件档案用文件名）。
    const requested = visual.routes ?? [{ baselineEntry: visual.baselineEntry, candidateEntry: visual.candidateEntry }];
    if (!Array.isArray(requested) || requested.length < 1) throw invalid('视觉路由须为 1–16 条。');
    if (requested.length > maxRoutes) throw invalid(`视觉路由最多 ${maxRoutes} 条。`);
    const candidateRoot = await asInvalid(async () => localPath(record.source, relativeInput(visual.candidateDirectory)));
    if (!candidateRoot.stat.isDirectory()) throw invalid('候选工程须为素材根内的目录。');
    const prepared = [];
    const rejected = [];
    const seen = new Set();
    for (const [position, input] of requested.entries()) {
      const index = position + 1;
      try {
        if (!input || typeof input !== 'object') throw invalid(`视觉路由 ${index} 须为对象。`);
        const baselineEntry = (input.baselineEntry ?? defaultEntry).replaceAll('\\', '/');
        if (!source.stat.isDirectory() && baselineEntry !== originalParts.at(-1)) throw invalid('基准入口必须是已登记的单个 HTML 文件。');
        const baselineRow = data.rows.find(row => row.kind === 'asset' && row.type === 'page' && String(row.path).replaceAll('\\', '/') === baselineEntry);
        if (!/^[a-f0-9]{64}$/u.test(baselineRow?.sha256 ?? '')) throw invalid('基准 HTML 入口缺少本次盘点的文件指纹；请检查路径或重新盘点。');
        const candidateEntry = (input.candidateEntry ?? baselineEntry).replaceAll('\\', '/');
        const key = `${baselineEntry}\u0000${candidateEntry}`;
        if (seen.has(key)) throw invalid(`视觉路由 ${index} 与前面的路由重复。`);
        seen.add(key);
        const baseline = await asInvalid(() => visualPage(baselineRoot, baselineEntry, baselineRow.sha256, signal));
        const candidate = await asInvalid(() => visualPage(candidateRoot.path, candidateEntry, undefined, signal));
        if (baseline.root === candidate.root && baseline.entry === candidate.entry) throw invalid('基准与候选必须是两个不同的入口。');
        prepared.push({ index, baseline, candidate, baselineEntry, candidateEntry });
      } catch (error) {
        signal?.throwIfAborted();
        // 单条路由坏掉不丢整批：记下原因，其余路由照常测量。
        rejected.push({ index, status: 'blocked', kind: error?.kind === 'invalid-input' ? 'invalid-input' : 'environment',
          reason: String(error?.message ?? error).slice(0, 500), baselineEntry: input?.baselineEntry ?? null, candidateEntry: input?.candidateEntry ?? null });
      }
    }
    if (!prepared.length) {
      if (rejected.length === 1) throw Object.assign(new Error(rejected[0].reason), { kind: rejected[0].kind === 'invalid-input' ? 'invalid-input' : 'environment' });
      throw invalid(`视觉路由全部不可用：${rejected.map(item => `r${item.index} ${item.reason}`).join('；')}`);
    }
    const output = join(dir, checkId);
    await mkdir(output, { mode: 0o700 });
    try {
      const measured = await comparePages({ routes: prepared, dir: output, reaPath: setting(config.reaPath),
        chromiumPath: setting(config.chromiumPath), channelThreshold, signal, launch: config.launch, createBudgetSignal: config.createBudgetSignal });
      signal?.throwIfAborted();
      const routes = [...measured.routes, ...rejected].sort((left, right) => left.index - right.index);
      const settled = { ...measured, routes };
      if (rejected.length) {
        settled.status = 'blocked';
        settled.kind ??= rejected.find(item => item.kind !== 'invalid-input')?.kind ?? 'invalid-input';
        const tail = `路由 ${rejected.map(item => `r${item.index}`).join('、')} 未通过入口校验：${rejected.map(item => item.reason).join('；')}`;
        settled.reason = settled.reason ? `${settled.reason} ${tail}` : tail;
      }
      const first = routes[0];
      const result = { ...settled, directory: output, routeCount: routes.length,
        baselineEntry: first.baselineEntry, candidateEntry: first.candidateEntry,
        baselineHtmlSha256: first.baselineHtmlSha256 ?? null, candidateHtmlSha256: first.candidateHtmlSha256 ?? null };
      await writeFile(join(output, 'summary.json'), `${JSON.stringify(visualSummary(result), null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600, signal });
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      await rm(output, { recursive: true, force: true, maxRetries: 5 });
      throw error;
    }
  }
const candidateLimits = { entries: 20000, depth: 32, cssFiles: 64, cssPerFile: 512 * 1024, cssTotal: 8 * 1024 * 1024, htmlFiles: 64, htmlPerFile: 512 * 1024, htmlTotal: 8 * 1024 * 1024, hashFiles: 4096, hashPerFile: maxAssetHashFileBytes, hashBytes: 256 * 1024 * 1024 };
const candidateSkip = new Set(['.git', 'node_modules', '.svn']);
const pageDecoder = new TextDecoder('utf-8', { fatal: true });

// 只读候选工程的目录树、样式与页面文本：不跟随链接、不执行候选代码、按预算截断。
async function scanCandidate(root, signal) {
  const files = [];
  const css = [];
  const html = [];
  let cssBytes = 0;
  let htmlBytes = 0;
  let hashBytes = 0;
  let hashed = 0;
  let skippedHashes = 0;
  let clipped = false;
  const walk = async (dir, prefix, depth) => {
    signal?.throwIfAborted();
    if (depth > candidateLimits.depth) { clipped = true; return; }
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
      signal?.throwIfAborted();
      if (files.length >= candidateLimits.entries) { clipped = true; return; }
      if (entry.isSymbolicLink() || entry.name.startsWith('.git')) continue;
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (candidateSkip.has(entry.name)) continue;
        await walk(path, rel, depth + 1);
      } else if (entry.isFile()) {
        const info = await stat(path);
        const file = { path: rel, size: info.size };
        // 内容指纹只在预算内取，和素材指纹用同一套上限；超预算就留空，日志里计数。
        if (hashed < candidateLimits.hashFiles && info.size <= candidateLimits.hashPerFile && hashBytes + info.size <= candidateLimits.hashBytes) {
          const bytes = await readBounded(path, Math.min(candidateLimits.hashPerFile, candidateLimits.hashBytes - hashBytes), signal);
          file.sha256 = createHash('sha256').update(bytes).digest('hex');
          hashed += 1;
          hashBytes += bytes.length;
        } else if (info.size > 0) skippedHashes += 1;
        files.push(file);
        const name = entry.name.toLowerCase();
        if (name.endsWith('.css')) {
          if (css.length >= candidateLimits.cssFiles || cssBytes >= candidateLimits.cssTotal) { clipped = true; continue; }
          const text = (await readBounded(path, Math.min(candidateLimits.cssPerFile, candidateLimits.cssTotal - cssBytes), signal)).toString('utf8');
          cssBytes += text.length;
          css.push({ path: rel, text });
        } else if (name.endsWith('.html') || name.endsWith('.htm')) {
          if (html.length >= candidateLimits.htmlFiles || htmlBytes >= candidateLimits.htmlTotal) { clipped = true; continue; }
          const budget = Math.min(candidateLimits.htmlPerFile, candidateLimits.htmlTotal - htmlBytes);
          try {
            const bytes = await readBounded(path, budget, signal);
            htmlBytes += bytes.length;
            html.push({ path: rel, text: pageDecoder.decode(bytes) });
          } catch (error) {
            signal?.throwIfAborted();
            html.push({ path: rel, reason: String(error?.message ?? error).slice(0, 200) });
          }
        }
      }
    }
  };
  await walk(root, '', 0);
  return { files, css, html, clipped, cssBytes, htmlBytes, hashed, skippedHashes };
}

// 证据侧页面文本：从素材根按盘点行重读，走同一套路径校验与预算；读不到就带回原因，交给结构维度记 unverified。
async function readEvidencePages(record, data, signal) {
  const pages = [];
  if (record.data.kind !== 'local') return { pages, bytes: 0, clipped: false };
  const parts = await asInvalid(() => relativeInput(record.data.location));
  const source = await asInvalid(() => localPath(record.source, parts));
  const base = source.stat.isDirectory() ? source.path : join(source.path, '..');
  let bytes = 0;
  let clipped = false;
  for (const row of data.rows ?? []) {
    if (row.kind !== 'asset' || row.type !== 'page' || row.archive) continue;
    if (pages.length >= structureLimits.pages) { clipped = true; break; }
    const budget = Math.min(structureLimits.pageBytes, structureLimits.totalBytes - bytes);
    if (budget <= 0) { clipped = true; break; }
    try {
      const file = await asInvalid(() => localPath(base, relativeInput(row.path)));
      if (!file.stat.isFile()) { pages.push({ path: row.path, reason: '跳过非普通文件。' }); continue; }
      const bytesRead = await readBounded(file.path, budget, signal);
      bytes += bytesRead.length;
      pages.push({ path: row.path, text: pageDecoder.decode(bytesRead) });
    } catch (error) {
      signal?.throwIfAborted();
      pages.push({ path: row.path, reason: String(error?.message ?? error).slice(0, 200) });
    }
  }
  return { pages, bytes, clipped };
}

async function checkCandidateRun({ record, spec, data, candidate, signal }) {
    if (!candidate || typeof candidate !== 'object') throw invalid('candidate 须为对象。');
    if (record.data.kind !== 'local') throw invalid('候选覆盖度只接受本地档案。');
    const root = await asInvalid(async () => localPath(record.source, relativeInput(candidate.directory)));
    if (!root.stat.isDirectory()) throw invalid('候选工程须为素材根内的目录。');
    const scan = await scanCandidate(root.path, signal);
    signal?.throwIfAborted();
    const evidence = await readEvidencePages(record, data, signal);
    const result = checkCandidate({ spec, run: data, files: scan.files, css: scan.css, html: scan.html, evidencePages: evidence.pages });
    return { ...result, directory: candidate.directory, clipped: scan.clipped, cssBytes: scan.cssBytes, htmlBytes: scan.htmlBytes,
      evidencePages: evidence.pages.length, evidenceClipped: evidence.clipped,
      hashedFiles: scan.hashed, skippedHashes: scan.skippedHashes, limits: candidateLimits };
  }

  async function check({ id, runId, visual, candidate }, signal) {
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
    const checkId = `check-${Date.now()}-${randomUUID()}`;
    let visualResult;
    if (visual !== undefined) {
      try { visualResult = await checkVisual({ record, data, visual, dir, checkId, signal }); }
      catch (error) {
        signal?.throwIfAborted();
        const kind = error?.kind === 'invalid-input' ? 'invalid-input' : 'environment';
        visualResult = { scope: 'static-html-viewport', status: 'blocked', kind, reason: String(error?.message ?? error).slice(0, kind === 'invalid-input' ? 500 : 4000) };
      }
    }
    const assessed = visualResult ? { visual: visualResult } : {};
    let candidateResult;
    if (candidate !== undefined) {
      try {
        const assessedCandidate = await checkCandidateRun({ record, spec: built.spec, data, candidate, signal });
        // 完整结构清单只用于渲染报告，不回写进 JSON 回执（回执保留摘要 structure）。
        const { structureDetail, ...candidateSummary } = assessedCandidate;
        candidateResult = candidateSummary;
        if (structureDetail) {
          const markdown = renderStructureReport({ id, label: record.data.label, runId: data.runId, directory: candidate.directory, detail: structureDetail, createdAt });
          signal?.throwIfAborted();
          candidateResult.report = await writeDerived(dir, `${checkId}.md`, markdown, signal);
        }
      }
      catch (error) {
        signal?.throwIfAborted();
        const kind = error?.kind === 'invalid-input' ? 'invalid-input' : 'environment';
        candidateResult = { scope: 'candidate-coverage', verdict: 'blocked', kind, reason: String(error?.message ?? error).slice(0, kind === 'invalid-input' ? 500 : 4000) };
      }
    }
    const withCandidate = candidateResult ? { ...assessed, candidate: candidateResult } : assessed;
    const schemaVersion = visualResult?.status === 'measured' ? 2 : 1;
    const file = await writeDerived(dir, `${checkId}.json`, `${JSON.stringify({ schemaVersion, id, runId: data.runId, generatedAt: createdAt, ...result, ...withCandidate }, null, 2)}\n`, signal);
    return { id, runId: data.runId, generatedAt: createdAt, verdict: result.verdict, orphans: result.orphans.length, dangling: result.dangling.length, stale: result.stale, conflicts: result.conflicts.length, ...withCandidate, file };
  }
  // 一条命令跑完整链：盘点 → 规格 → 交接单 → 令牌 → 导出 → 骨架 → 核对 → 复刻包索引。
  // 每步都落在 <档案>/<id>/ 下的固定位置，pack/ 只是索引：删了重跑不损失别的产物。
  // 中途失败就停下并报“第几步、哪一步、为什么”，不写半截索引——半截索引会被当成完整结论读。
  async function run({ id, runId, rea, reaTimeoutMs, name, files, fileBytes, totalBytes, candidate, visual }, signal) {
    const record = await target(id, signal);
    const steps = [];
    const startedAt = Date.now();
    const mark = (name, status, extra = {}) => steps.push({ name, status, ...extra });
    const timed = async (name, work, artifact) => {
      const begin = Date.now();
      try {
        const value = await work();
        mark(name, 'ok', { durationMs: Date.now() - begin, artifact: artifact?.(value) ?? null });
        return value;
      } catch (error) {
        signal?.throwIfAborted();
        const wrapped = invalid(`复刻包在第 ${steps.length + 1} 步「${name}」停下：${String(error?.message ?? error)}`);
        wrapped.cause = error;
        wrapped.stage = name;
        throw wrapped;
      }
    };

    const data = await timed('dissect', async () => {
      const selected = runId ?? (await dissect({ id, rea, reaTimeoutMs }, signal)).runId;
      return loadRun(record, id, selected, signal);
    }, value => value.runId);
    if (runId !== undefined) Object.assign(steps[0], { status: 'reused', note: `沿用批次 ${data.runId}，未重新盘点` });

    const specResult = await timed('spec', () => spec({ id, runId: data.runId }, signal), value => value.files.markdown);
    const briefResult = await timed('brief', () => brief({ id, runId: data.runId }, signal), value => value.file);
    const tokensResult = await timed('tokens', () => tokens({ id, runId: data.runId }, signal), value => value.files.css);
    const exportResult = await timed('export', () => exportRows({ id, runId: data.runId, format: 'json' }, signal), value => value.file);

    const scaffoldResult = await timed('scaffold', async () => {
      if (record.data.kind !== 'local') return null;
      const local = await localPath(record.source, relativeInput(record.data.location));
      if (!local.stat.isDirectory()) return null;
      return scaffold({ id, runId: data.runId, name, files, fileBytes, totalBytes }, signal);
    }, value => value?.directory ?? null);
    if (!scaffoldResult) {
      const note = record.data.kind === 'local' ? '素材是单个文件，骨架需要一个目录' : 'URL 登记只有出处，没有本地素材可搬进骨架';
      Object.assign(steps.at(-1), { status: 'skipped', note });
    }

    const checkResult = await timed('check', () => check({ id, runId: data.runId, visual, candidate }, signal), value => value.file);

    const types = {};
    for (const row of data.rows) if (row.kind === 'asset' && typeof row.type === 'string') types[row.type] = (types[row.type] ?? 0) + 1;
    const scaffoldLabel = scaffoldResult ? basename(scaffoldResult.directory) : (name ?? data.runId);
    const createdAt = new Date().toISOString();
    const packId = `${Date.now()}-${randomUUID()}`;
    const packDirectory = `${id}/pack/${packId}`;
    const packStep = async () => {
      const begin = Date.now();
      const entry = { name: 'pack', status: 'ok', durationMs: null, artifact: `${packDirectory}/INDEX.md` };
      steps.push(entry);
      const parent = await ensureDir(record, 'pack');
      const indexText = renderPackIndex({
        id, label: record.data.label, runId: data.runId, location: record.data.location, kind: record.data.kind,
        createdAt, version: pluginVersion, steps, rootPrefix: '../..',
        totals: data.totals, types, notes: data.notes ?? [],
        spec: specResult,
        brief: { runId: data.runId },
        tokens: tokensResult,
        exported: { count: exportResult.count, fileName: basename(exportResult.file) },
        scaffold: scaffoldResult ? { ...scaffoldResult, label: scaffoldLabel } : null,
        check: {
          ...checkResult,
          fileName: basename(checkResult.file),
          candidate: checkResult.candidate ? { ...checkResult.candidate, reportName: checkResult.candidate.report ? basename(checkResult.candidate.report) : null } : null,
        },
        gaps: specResult.gaps,
      });
      const summaryText = `${JSON.stringify(summarizePack({
        steps, totals: data.totals, coverage: data.coverage, spec: specResult,
        scaffold: scaffoldResult ? { ...scaffoldResult, label: scaffoldLabel } : null,
        check: { ...checkResult, candidate: checkResult.candidate ? { ...checkResult.candidate, reportName: checkResult.candidate.report ? basename(checkResult.candidate.report) : null } : null },
        version: pluginVersion, runId: data.runId, id,
      }), null, 2)}\n`;
      const published = await publishPack({ parent, packId, indexText, summaryText, signal });
      entry.durationMs = Date.now() - begin;
      return published;
    };
    // 索引这一步不走 timed：它自己会先把自己写进步骤表，timed 再补一条就重复了。
    let packed;
    try { packed = await packStep(); }
    catch (error) {
      signal?.throwIfAborted();
      const wrapped = invalid(`复刻包在第 ${steps.length} 步「pack」停下：${String(error?.message ?? error)}`);
      wrapped.cause = error;
      wrapped.stage = 'pack';
      throw wrapped;
    }

    return {
      id, runId: data.runId, generatedAt: createdAt, durationMs: Date.now() - startedAt,
      steps,
      totals: data.totals,
      types,
      spec: { obligations: specResult.obligations, counts: specResult.counts, conflicts: specResult.conflicts, unknowns: specResult.unknowns },
      tokens: { total: tokensResult.total, occurrences: tokensResult.occurrences, conflicts: tokensResult.conflicts },
      exported: { count: exportResult.count },
      scaffold: scaffoldResult ? { directory: scaffoldResult.directory, counts: scaffoldResult.counts, web: scaffoldResult.web, budget: scaffoldResult.budget, skippedCount: scaffoldResult.skippedCount, warningCount: scaffoldResult.warningCount, coverage: scaffoldResult.coverage, start: scaffoldResult.start } : null,
      check: { verdict: checkResult.verdict, orphans: checkResult.orphans, dangling: checkResult.dangling, stale: checkResult.stale, conflicts: checkResult.conflicts, candidate: checkResult.candidate ? { verdict: checkResult.candidate.verdict, report: checkResult.candidate.report ?? null } : null },
      directory: packDirectory,
      files: { index: `${packDirectory}/INDEX.md`, summary: `${packDirectory}/pack.json` },
      next: [
        `读 ${packDirectory}/INDEX.md 按顺序展开`,
        ...(scaffoldResult ? [`起本地服务：${scaffoldResult.start}`] : []),
        '改完自己的工程后放进素材根，用 guoluo_check 带 candidate.directory 回核',
      ],
    };
  }
  return { probe, add, dissect, status, list, dossier, spec, brief, tokens, export: exportRows, mock, scaffold, check, run };
}

function checkPage(offset, limit, upper) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > upper) throw new Error(`分页每次 1–${upper} 条，偏移须为非负整数。`);
}
