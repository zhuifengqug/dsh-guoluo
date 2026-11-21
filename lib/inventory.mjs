import { createHash } from 'node:crypto';
import { lstat, open, opendir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parse } from 'parse5';
import postcss from 'postcss';
import { manifestFacts, readEntry, readZip } from './apk.mjs';
import { readBounded } from './paths.mjs';
import { readPck } from './pck.mjs';
import { parsePe } from './pe.mjs';
import { inspectUnityHeader, unityCandidate } from './unity.mjs';

const types = new Map(Object.entries({ html: 'page', htm: 'page', css: 'style', svg: 'image', png: 'image', jpeg: 'image', jpg: 'image', webp: 'image', gif: 'image', avif: 'image', ico: 'image', woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', mp3: 'audio', ogg: 'audio', wav: 'audio', mp4: 'video', webm: 'video', exe: 'executable', dll: 'library' }));
const binaryTypes = new Set(['executable', 'library']);
const limits = { entries: 12000, rows: 4000, textPerFile: 512 * 1024, textTotal: 16 * 1024 * 1024, depth: 32, asarHeader: 8 * 1024 * 1024, apkManifest: 16 * 1024 * 1024, apkPermissions: 512, apkActivities: 512, apkManifestBytes: 256 * 1024, peFiles: 16, peSections: 24, peDlls: 24, peSymbols: 12, peExports: 24, unityFiles: 16 };
const excluded = new Set(['.git', 'node_modules', '.svn']);
const decoder = new TextDecoder('utf-8', { fatal: true });
const ext = path => extname(path).slice(1).toLowerCase();
const peExtensions = new Set(['exe', 'dll']);
const cleanLabel = name => !!name && name.length <= 255 && !/[\\/:\x00-\x1f]/u.test(name) && name !== '.' && name !== '..';
const publicRef = value => {
  const raw = value.trim();
  if (!raw || raw.length > 1000 || /[\\\x00-\x1f]/u.test(raw) || raw.startsWith('#')) return null;
  if (/^(?:https?:)?\/\//iu.test(raw)) {
    try { const url = new URL(raw, 'https://offline.invalid'); return url.username || url.password ? null : `${url.origin}${url.pathname}`; } catch { return null; }
  }
  if (/^[a-z][a-z0-9+.-]*:/iu.test(raw)) return null;
  const ref = raw.split(/[?#]/u, 1)[0];
  return ref || null;
};

export async function inventory(source, signal) {
  const rows = [];
  const peFiles = [];
  const unityFiles = [];
  const notes = new Set(['只记录本地静态素材；未验证脚本生成的页面、用户流程或服务器行为。']);
  const counts = { visited: 0, textBytes: 0, skippedText: 0, skippedLinks: 0, skippedUnityHeaders: 0 };
  let clipped = false;
  const add = row => {
    if (rows.length >= limits.rows) { clipped = true; return; }
    rows.push(row);
  };
  function visit() {
    signal?.throwIfAborted();
    if (counts.visited >= limits.entries || rows.length >= limits.rows) { clipped = true; return false; }
    counts.visited++;
    return true;
  }
  function html(data, path) {
    const document = parse(data, { sourceCodeLocationInfo: true });
    const stack = [document];
    while (stack.length && rows.length < limits.rows) {
      signal?.throwIfAborted();
      const node = stack.pop();
      const attrs = Object.fromEntries((node.attrs ?? []).map(attr => [attr.name, attr.value]));
      const line = node.sourceCodeLocation?.startLine ?? null;
      const key = ['a', 'link'].includes(node.tagName) ? 'href' : ['img', 'source', 'audio', 'video'].includes(node.tagName) ? 'src' : null;
      if (key && attrs[key]) {
        const value = publicRef(attrs[key]);
        if (value) add({ kind: node.tagName === 'a' ? 'navigation' : 'reference', path, line, value });
      }
      if (node.tagName === 'style') css((node.childNodes ?? []).map(n => n.value ?? '').join(''), path, line ?? 1);
      for (let i = (node.childNodes?.length ?? 0) - 1; i >= 0; i--) stack.push(node.childNodes[i]);
    }
    if (stack.length) clipped = true;
  }
  function css(data, path, firstLine = 1) {
    const sheet = postcss.parse(data, { from: undefined });
    sheet.walkDecls(decl => {
      if (rows.length >= limits.rows) { clipped = true; return false; }
      const line = firstLine + (decl.source?.start?.line ?? 1) - 1;
      if (/^--[\w-]{1,120}$/u.test(decl.prop)) {
        const value = decl.value.trim();
        if (value.length <= 300 && !/url\s*\(|image-set\s*\(|@|[\x00-\x1f]/iu.test(value)) add({ kind: 'token', path, line, name: decl.prop, value });
      }
      for (const m of decl.value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^\s)'"\\]+))\s*\)/giu)) {
        const value = publicRef(m[1] ?? m[2] ?? m[3]);
        if (value) add({ kind: 'reference', path, line, value });
        if (rows.length >= limits.rows) { clipped = true; return false; }
      }
    });
  }
  async function binary(path, rel, stat) {
    notes.add('PE 只解析 DOS/COFF/可选头、节表、导入与导出表及 CLR 目录标记；未反编译、未解析资源与证书、未运行二进制。');
    // 名额在解析前扣除：解析失败也占用预算，避免一批里反复尝试上千个二进制。
    if (peFiles.length >= limits.peFiles) { clipped = true; return; }
    peFiles.push(null);
    try {
      const facts = await parsePe(path, signal);
      const entry = {
        path: rel,
        status: 'parsed',
        format: facts.format,
        machine: facts.machine,
        subsystem: facts.subsystem,
        bytes: facts.bytes ?? stat.size,
        imageBase: facts.imageBase,
        entryPointRva: facts.entryPointRva,
        timestamp: facts.timestamp,
        sectionCount: facts.sections.length,
        sections: facts.sections.slice(0, limits.peSections).map(section => ({ name: section.name, rva: section.rva, virtualSize: section.virtualSize, rawSize: section.rawSize })),
        imports: {
          status: facts.imports.status,
          ...(facts.imports.reason ? { reason: facts.imports.reason } : {}),
          items: facts.imports.items.slice(0, limits.peDlls).map(item => ({ dll: item.dll, symbols: item.symbols.slice(0, limits.peSymbols).map(symbol => symbol.name ?? `#${symbol.ordinal}`) })),
        },
        exports: {
          status: facts.exports.status,
          ...(facts.exports.reason ? { reason: facts.exports.reason } : {}),
          namedCount: facts.exports.namedCount ?? 0,
          aliasSlots: facts.exports.aliasSlots ?? null,
          items: (facts.exports.items ?? []).slice(0, limits.peExports).map(item => item.name ?? `#${item.ordinal}`),
        },
        clr: facts.clr.declared,
      };
      peFiles[peFiles.length - 1] = entry;
    } catch (error) {
      signal?.throwIfAborted();
      notes.add('部分 PE 文件因头、节表或数据目录不完整未纳入静态解析。');
      peFiles[peFiles.length - 1] = { path: rel, status: 'unreadable', reason: String(error?.message ?? error).slice(0, 200) };
    }
  }
  async function file(path, rel, stat) {
    const unity = unityCandidate(rel);
    const type = unity ?? types.get(ext(rel));
    if (!type) return;
    const row = { kind: 'asset', path: rel, type, bytes: stat.size };
    if (binaryTypes.has(type)) row.binary = 'pe';
    add(row);
    if (unity) {
      notes.add('Unity 静态证据覆盖 UnityFS 头部、块信息段（未压缩或 LZ4/LZ4HC 压缩）与节点表，以及 IL2CPP 元数据头。LZMA/LZHAM 压缩的块信息段、节点内容未观测。');
      if (unityFiles.length >= limits.unityFiles) { counts.skippedUnityHeaders++; clipped = true; return; }
      try {
        const facts = await inspectUnityHeader(path, stat.size, unity, signal);
        unityFiles.push({ path: rel, kind: unity, status: 'header-read', ...facts });
        if (facts.nodes?.truncated || facts.blocks?.truncated) {
          clipped = true;
          notes.add('UnityFS 大表已完整校验，dossier 受字节预算限制只列出前缀明细。');
        }
      } catch (error) {
        signal?.throwIfAborted();
        unityFiles.push({ path: rel, kind: unity, status: 'unreadable', reason: String(error?.message ?? error).slice(0, 200) });
      }
      return;
    }
    if (binaryTypes.has(type)) { await binary(path, rel, stat); return; }
    const text = type === 'page' || type === 'style';
    if (!text) return;
    try {
      const bytes = await readBounded(path, Math.min(limits.textPerFile, limits.textTotal - counts.textBytes), signal);
      counts.textBytes += bytes.length;
      row.sha256 = createHash('sha256').update(bytes).digest('hex');
      const data = decoder.decode(bytes);
      if (type === 'page') html(data, rel);
      else css(data, rel);
    } catch {
      signal?.throwIfAborted();
      counts.skippedText++;
      notes.add('部分 HTML/CSS 因大小、编码、读取或解析问题未纳入文本观察。');
    }
  }
  async function walk(path, base, depth) {
    if (depth > limits.depth) { clipped = true; return; }
    for await (const entry of await opendir(path)) {
      if (!visit()) return;
      if (!cleanLabel(entry.name) || excluded.has(entry.name.toLowerCase())) continue;
      const child = join(path, entry.name);
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (rel.length > 500) { clipped = true; continue; }
      let stat;
      try { stat = await lstat(child); } catch { notes.add('部分条目在扫描时消失或无法读取。'); continue; }
      if (stat.isSymbolicLink()) { counts.skippedLinks++; continue; }
      if (stat.isDirectory()) await walk(child, rel, depth + 1);
      else if (stat.isFile()) await file(child, rel, stat);
    }
  }
  async function asar(path) {
    notes.add('ASAR 仅盘点头部资产目录；未解包、未读取归档成员内容。');
    const fd = await open(path, 'r');
    try {
      const stat = await fd.stat();
      if (!stat.isFile()) throw new Error('ASAR 输入不是普通文件。');
      const pre = Buffer.alloc(8);
      if ((await fd.read(pre, 0, 8, 0)).bytesRead !== 8 || pre.readUInt32LE(0) !== 4) throw new Error('ASAR 头无效。');
      const size = pre.readUInt32LE(4);
      if (size < 8 || size > limits.asarHeader || size > stat.size - 8) throw new Error('ASAR 头长度无效或超限。');
      const header = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        signal?.throwIfAborted();
        const { bytesRead } = await fd.read(header, read, size - read, 8 + read);
        if (!bytesRead) throw new Error('ASAR 头读取不完整。');
        read += bytesRead;
      }
      const payload = header.readUInt32LE(0);
      const len = header.readUInt32LE(4);
      if (payload !== size - 4 || len > payload - 4) throw new Error('ASAR 目录长度无效。');
      const tree = JSON.parse(decoder.decode(header.subarray(8, 8 + len)));
      const branch = (node, base, depth) => {
        if (depth > limits.depth) { clipped = true; return; }
        if (!node.files || typeof node.files !== 'object' || Array.isArray(node.files)) throw new Error('ASAR 目录格式无效。');
        for (const [name, meta] of Object.entries(node.files)) {
          if (!visit()) return;
          if (!cleanLabel(name) || excluded.has(name.toLowerCase()) || !meta || typeof meta !== 'object') continue;
          if (typeof meta.link === 'string') { counts.skippedLinks++; continue; }
          const rel = base ? `${base}/${name}` : name;
          if (rel.length > 500) { clipped = true; continue; }
          if (meta.files) branch(meta, rel, depth + 1);
          else if (types.has(ext(rel)) && Number.isSafeInteger(meta.size) && meta.size >= 0) add({ kind: 'asset', path: rel, type: types.get(ext(rel)), bytes: meta.size });
        }
      };
      branch(tree, '', 0);
    } finally { await fd.close(); }
  }
  async function apk(path, stat) {
    notes.add('APK 只按 ZIP 中央目录与二进制清单静态解析；未解压资源内容、未校验签名、未运行应用。');
    const fd = await open(path, 'r');
    try {
      if (!stat.isFile()) throw new Error('APK 输入不是普通文件。');
      const entries = await readZip(fd, stat.size, { maxEntries: limits.entries, maxDirectory: 16 * 1024 * 1024, signal });
      const counts = { entries: entries.length, dex: 0, libs: 0, signatures: 0, resources: 0, manifest: 0, dirs: 0, assets: 0, scanned: 0 };
      const abis = new Set();
      let manifestBytes = null;
      let manifestStatus = 'absent';
      // 元数据扫描与素材行输出分开计预算：行数上限不阻断清单、dex/so 与 ABI 的统计。
      for (const entry of entries) {
        signal?.throwIfAborted();
        if (counts.scanned >= limits.entries) { clipped = true; break; }
        counts.scanned++;
        const name = entry.name;
        if (name.endsWith('/')) { counts.dirs++; continue; }
        if (/\\/u.test(name)) { notes.add('部分 APK 成员名含反斜杠，已跳过登记。'); continue; }
        if (/^classes\d*\.dex$/iu.test(name)) counts.dex++;
        else if (/^lib\/[^/]+\/[^/]+\.so$/iu.test(name)) { counts.libs++; abis.add(name.split('/')[1]); }
        else if (/^META-INF\/[^/]+\.(?:rsa|dsa|ec)$/iu.test(name)) counts.signatures++;
        else if (name === 'resources.arsc') counts.resources++;
        if (name === 'AndroidManifest.xml') {
          try { manifestBytes = await readEntry(fd, entry, limits.apkManifest, signal, stat.size); counts.manifest = 1; manifestStatus = 'read'; }
          catch { manifestStatus = 'unreadable'; notes.add('AndroidManifest.xml 未能解压，清单事实缺失。'); }
          continue;
        }
        if (name.length > 500) { clipped = true; continue; }
        const type = types.get(ext(name));
        if (type) { counts.assets++; add({ kind: 'asset', path: name, type, bytes: entry.uncompressed, archive: 'apk' }); }
      }
      let manifest = null;
      if (manifestBytes) {
        try {
          // 整批保留（条数与字节双预算）：落盘后由 guoluo_dossier 按 offset/limit 续页，不再从首页重解。
          manifest = manifestFacts(manifestBytes, signal, {
            permissions: { limit: limits.apkPermissions, bytes: limits.apkManifestBytes },
            activities: { limit: limits.apkActivities, bytes: limits.apkManifestBytes },
          });
          manifestStatus = manifest ? 'parsed' : 'no-manifest';
          if (manifest?.permissionsNote) notes.add(manifest.permissionsNote);
          if (manifest?.activitiesNote) notes.add(manifest.activitiesNote);
        } catch { signal?.throwIfAborted(); manifestStatus = 'parse-failed'; notes.add('二进制 AndroidManifest.xml 解析失败，清单事实缺失。'); }
      }
      if (!manifest && manifestStatus !== 'parse-failed') notes.add('未取到可解析的清单，应用标识与入口缺失。');
      return { counts, abis: [...abis].sort(), manifest, manifestStatus, scanned: counts.scanned, scanTruncated: counts.scanned < entries.length };
    } finally { await fd.close(); }
  }
  async function pck(path, stat) {
    notes.add('PCK 只读包头与文件表；未解压条目内容、未解密加密条目、未运行游戏。');
    const facts = await readPck(path, stat.size, { maxFiles: limits.entries, signal });
    for (const entry of facts.files) {
      if (!visit()) break;
      if (entry.path.length > 500) { clipped = true; continue; }
      const type = types.get(entry.ext);
      if (!type) continue;
      add({ kind: 'asset', path: entry.path, type, bytes: entry.bytes, archive: 'pck', ...(entry.encrypted ? { encrypted: true } : {}) });
    }
    if (facts.directoryStatus === 'budget-exceeded') clipped = true;
    if (facts.directoryStatus !== 'parsed') notes.add(`PCK 文件目录状态为 ${facts.directoryStatus}，仅记录文件头和声明条目数。`);
    if (facts.counts.encrypted) notes.add('PCK 加密条目只核对起点和声明大小，实际存储区间未核验。');
    return { engine: facts.engine, packFormat: facts.packFormat, directoryStatus: facts.directoryStatus, counts: facts.counts, declaredBytes: facts.declaredBytes };
  }
  let apkFacts = null;
  let pckFacts = null;
  if (source.stat?.isDirectory()) await walk(source.path, '', 0);
  else if (source.stat?.isFile() && ext(source.path) === 'asar') await asar(source.path);
  else if (source.stat?.isFile() && ext(source.path) === 'apk') apkFacts = await apk(source.path, source.stat);
  else if (source.stat?.isFile() && ext(source.path) === 'pck') pckFacts = await pck(source.path, source.stat);
  else if (source.stat?.isFile() && (peExtensions.has(ext(source.path)) || unityCandidate(source.path) || ['html', 'htm', 'css'].includes(ext(source.path)))) {
    visit(); await file(source.path, source.label, source.stat);
  } else throw new Error('请使用本地素材目录、HTML/CSS 文件、ASAR、APK、PCK、PE 或 Unity 素材文件。');
  if (clipped) notes.add('命中目录深度、条目数或输出行数上限；本批证据截断。');
  if (counts.skippedLinks) notes.add('不跟随符号链接、目录联接或 ASAR 链接。');
  if (counts.skippedUnityHeaders) notes.add(`Unity 头部预算为 ${limits.unityFiles} 份，另有 ${counts.skippedUnityHeaders} 份候选素材未读头。`);
  rows.sort((a, b) => a.path.localeCompare(b.path, 'en') || (a.line ?? 0) - (b.line ?? 0) || a.kind.localeCompare(b.kind, 'en'));
  const totals = { asset: 0, token: 0, navigation: 0, reference: 0 };
  for (const row of rows) totals[row.kind]++;
  return {
    rows, totals, coverage: { ...counts, clipped, limits }, notes: [...notes],
    ...(apkFacts ? { apk: apkFacts } : {}), ...(pckFacts ? { pck: pckFacts } : {}), ...(peFiles.length ? { pe: peFiles } : {}),
    ...(unityFiles.length ? { unity: unityFiles } : {}),
  };
}
