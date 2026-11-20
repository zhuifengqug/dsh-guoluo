import { createHash } from 'node:crypto';
import { lstat, open, opendir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { parse } from 'parse5';
import postcss from 'postcss';
import { manifestFacts, readEntry, readZip } from './apk.mjs';
import { readBounded } from './paths.mjs';

const types = new Map(Object.entries({ html: 'page', htm: 'page', css: 'style', svg: 'image', png: 'image', jpeg: 'image', jpg: 'image', webp: 'image', gif: 'image', avif: 'image', ico: 'image', woff: 'font', woff2: 'font', ttf: 'font', otf: 'font', mp3: 'audio', ogg: 'audio', wav: 'audio', mp4: 'video', webm: 'video' }));
const limits = { entries: 12000, rows: 4000, textPerFile: 512 * 1024, textTotal: 16 * 1024 * 1024, depth: 32, asarHeader: 8 * 1024 * 1024, apkManifest: 16 * 1024 * 1024 };
const excluded = new Set(['.git', 'node_modules', '.svn']);
const decoder = new TextDecoder('utf-8', { fatal: true });
const ext = path => extname(path).slice(1).toLowerCase();
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
  const notes = new Set(['只记录本地静态素材；未验证脚本生成的页面、用户流程或服务器行为。']);
  const counts = { visited: 0, textBytes: 0, skippedText: 0, skippedLinks: 0 };
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
  async function file(path, rel, stat) {
    const type = types.get(ext(rel));
    if (!type) return;
    const row = { kind: 'asset', path: rel, type, bytes: stat.size };
    add(row);
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
      const counts = { entries: entries.length, dex: 0, libs: 0, signatures: 0, resources: 0, manifest: 0, dirs: 0, assets: 0 };
      const abis = new Set();
      let manifestBytes = null;
      for (const entry of entries) {
        if (!visit()) break;
        const name = entry.name;
        if (name.endsWith('/')) { counts.dirs++; continue; }
        if (name.length > 500) { clipped = true; continue; }
        if (/^classes\d*\.dex$/iu.test(name)) counts.dex++;
        else if (/^lib\/[^/]+\/[^/]+\.so$/iu.test(name)) { counts.libs++; abis.add(name.split('/')[1]); }
        else if (/^META-INF\/[^/]+\.(?:rsa|dsa|ec)$/iu.test(name)) counts.signatures++;
        else if (name === 'resources.arsc') counts.resources++;
        if (name === 'AndroidManifest.xml') {
          try { manifestBytes = await readEntry(fd, entry, limits.apkManifest, signal); counts.manifest = 1; }
          catch { notes.add('AndroidManifest.xml 未能解压，清单事实缺失。'); }
          continue;
        }
        const type = types.get(ext(name));
        if (type) { counts.assets++; add({ kind: 'asset', path: name, type, bytes: entry.uncompressed, archive: 'apk' }); }
      }
      let manifest = null;
      if (manifestBytes) {
        try { manifest = manifestFacts(manifestBytes, signal); }
        catch { signal?.throwIfAborted(); notes.add('二进制 AndroidManifest.xml 解析失败，清单事实缺失。'); }
      }
      if (!manifest) notes.add('未取到可解析的清单，应用标识与入口缺失。');
      return { counts, abis: [...abis].sort(), manifest };
    } finally { await fd.close(); }
  }
  let apkFacts = null;
  if (source.stat?.isDirectory()) await walk(source.path, '', 0);
  else if (source.stat?.isFile() && ext(source.path) === 'asar') await asar(source.path);
  else if (source.stat?.isFile() && ext(source.path) === 'apk') apkFacts = await apk(source.path, source.stat);
  else if (source.stat?.isFile() && ['html', 'htm', 'css'].includes(ext(source.path))) {
    visit(); await file(source.path, source.label, source.stat);
  } else throw new Error('请使用本地素材目录、HTML/CSS 文件、ASAR 或 APK。');
  if (clipped) notes.add('命中目录深度、条目数或输出行数上限；本批证据截断。');
  if (counts.skippedLinks) notes.add('不跟随符号链接、目录联接或 ASAR 链接。');
  rows.sort((a, b) => a.path.localeCompare(b.path, 'en') || (a.line ?? 0) - (b.line ?? 0) || a.kind.localeCompare(b.kind, 'en'));
  const totals = { asset: 0, token: 0, navigation: 0, reference: 0 };
  for (const row of rows) totals[row.kind]++;
  return { rows, totals, coverage: { ...counts, clipped, limits }, notes: [...notes], ...(apkFacts ? { apk: apkFacts } : {}) };
}
