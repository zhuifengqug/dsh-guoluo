// Run against the installed DSH packages and an unpacked npm tarball, never the desktop profile.
import assert from 'node:assert/strict';
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [modules, packageDir] = process.argv.slice(2).map(value => resolve(value));
if (!modules || !packageDir) throw new Error('用法：node tests/host-smoke.mjs <DSH node_modules> <拆包后的 package 目录>');
const FAKE_REA = String.raw`import { createHash } from 'node:crypto';
import { readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log('9.9.9'); process.exit(0); }
const target = argv[argv.indexOf('analyze-javascript-application') + 1];
const output = argv[argv.indexOf('--evidence_output') + 1];
async function walk(dir, base = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? base + '/' + entry.name : entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, rel)));
    else out.push(rel + ':' + (await stat(full)).size);
  }
  return out.sort();
}
const root = createHash('sha256').update((await walk(target)).join('\n')).digest('hex');
const statistics = { relevant_files: 2, text_bytes_read: 64, parsed_javascript_files: 0, skipped_javascript_files: 0, parse_failures: 0 };
const parentId = 'ev_' + '1'.repeat(64);
const viewId = 'ev_' + '2'.repeat(64);
const text = JSON.stringify({ records: [{ operation: 'analyze_javascript_application', evidence_id: parentId, subject: { local_path: target, digest: { sha256: root } }, normalized_result: { root_artifact_sha256: root, statistics } }] });
await writeFile(output, text);
console.log(JSON.stringify({ rea_progress: { terminal: true } }));
console.log(JSON.stringify({ summary: { evidence_id: viewId, normalized_result: { parent_evidence_id: parentId, artifact: { sha256: root }, summary: { root_artifact_sha256: root, statistics } } }, evidence_bundle: { path: output, bytes: Buffer.byteLength(text, 'utf8') } }));
`;
const req = createRequire(join(modules, '..', 'package.json'));
const { runProfile } = await import(pathToFileURL(join(modules, '@deepseek-ai/dsh/lib/profile-boot.js')));
const { createLaunchEnvironmentSnapshot } = await import(pathToFileURL(req.resolve('@deepseek-ai/dsh-launch-environment')));
const root = await mkdtemp(join(tmpdir(), 'guoluo-dsh-smoke-'));
const profile = 'guoluo-smoke';
const dir = join(root, 'profiles', profile);
const packageName = '@zhuifengqug/dsh-guoluo';
const scope = join(dir, 'node_modules', '@zhuifengqug');
const sourceRoot = join(root, 'source');
const archiveRoot = join(root, 'archive');
process.env.DSH_HOME = root;
delete process.env.DSH_PROFILE_DIR;
process.env.DSH_TELEMETRY_DISABLED = '1';
let ctx;
try {
  await mkdir(scope, { recursive: true });
  await mkdir(sourceRoot);
  await mkdir(archiveRoot);
  await symlink(packageDir, join(scope, 'dsh-guoluo'), process.platform === 'win32' ? 'junction' : 'dir');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: profile, private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', packageName] } } }));
  await writeFile(join(dir, 'cordis.patch.yml'), '[]\n');
  await writeFile(join(sourceRoot, 'design.css'), ':root{--accent:#112233}');
  const fakeRea = join(root, 'fake-rea.mjs');
  await writeFile(fakeRea, FAKE_REA);
  ({ ctx } = await runProfile({ environment: createLaunchEnvironmentSnapshot([]), profile, patchFiles: [], args: [] }));
  const settings = ctx.get('settings');
  const desc = settings.describe().find(row => row.ns === 'guoluo');
  assert.equal(desc?.autoGenerate, true);
  const tools = ctx.get('tools');
  assert.deepEqual(tools.schemas().map(tool => tool.name).filter(name => name.startsWith('guoluo_')).sort(), ['guoluo_brief', 'guoluo_check', 'guoluo_dissect', 'guoluo_dossier', 'guoluo_export', 'guoluo_list', 'guoluo_mock', 'guoluo_probe', 'guoluo_scaffold', 'guoluo_spec', 'guoluo_status', 'guoluo_target_add', 'guoluo_tokens']);
  const call = (suffix, args) => tools.get(`guoluo_${suffix}`).execute(args, { signal: AbortSignal.timeout(15000) });
  assert.equal((await call('probe', {})).directories.ready, false);
  await settings.update('guoluo', { sourceRoot, archiveRoot }, desc.revision);
  const probe = await call('probe', {});
  assert.equal(probe.directories.ready, true);
  const skill = await ctx.get('skills').get('guoluo-rebuild', { cwd: root });
  assert.equal(skill?.provider, 'guoluo');
  const command = ctx.get('commands').find({}, 'guoluo');
  assert.equal((await command.handler({ rawInput: 'list', signal: AbortSignal.timeout(15000) })).kind, 'success');
  const { id } = await call('target_add', { kind: 'local', location: 'design.css' });
  const { runId } = await call('dissect', { id });
  const { rows } = await call('dossier', { id, runId, kind: 'token' });
  assert.deepEqual(rows, [{ kind: 'token', path: 'design.css', line: 1, name: '--accent', value: '#112233' }]);
  const spec = await call('spec', { id });
  assert.equal(spec.obligations, 2);
  const brief = await call('brief', { id, runId });
  assert.equal(brief.runId, runId);
  const tokens = await call('tokens', { id });
  assert.equal(tokens.total, 1);
  const exported = await call('export', { id, format: 'csv' });
  assert.equal(exported.count, 2);
  const mocked = await call('mock', { id, port: 8877 });
  assert.equal(mocked.assets, 0);
  const checked = await call('check', { id });
  assert.equal(checked.verdict, 'complete');
  const rebuild = join(sourceRoot, 'rebuild');
  await mkdir(rebuild);
  await writeFile(join(rebuild, 'index.html'), '<h1>rebuild</h1>');
  const covered = await call('check', { id, candidate: { directory: 'rebuild' } });
  assert.equal(covered.candidate.scope, 'candidate-coverage');
  assert.equal(covered.candidate.verdict, 'partial');
  const site = join(sourceRoot, 'site');
  await mkdir(site);
  await writeFile(join(site, 'index.html'), '<a href="/docs">docs</a><img src="hero.png">');
  await writeFile(join(site, 'app.css'), ':root{--accent:#112233}');
  const desc2 = settings.describe().find(row => row.ns === 'guoluo');
  await settings.update('guoluo', { reaPath: fakeRea }, desc2.revision);
  const { id: siteId } = await call('target_add', { kind: 'local', location: 'site' });
  const siteRun = await call('dissect', { id: siteId });
  assert.equal(siteRun.rea.status, 'analyzed');
  assert.equal(siteRun.rea.binding.status, 'verified');
  const scaffolded = await call('scaffold', { id: siteId, runId: siteRun.runId, name: 'site-copy' });
  assert.equal(scaffolded.counts.copied, 2);
  assert.equal(scaffolded.coverage.verdict, 'complete');
  assert.equal(scaffolded.coverage.structure.comparedPages, 1);
  assert.equal(scaffolded.coverage.structure.diverged, false);
  assert.equal(scaffolded.coverage.structure.navigation.present, 1);
  // 闭环：把档案里的生成目录放回素材根，再用公开的 check 走一遍，结构维度要认得出复制页。
  await cp(join(archiveRoot, scaffolded.directory), join(sourceRoot, 'site-copy'), { recursive: true });
  const closed = await call('check', { id: siteId, runId: siteRun.runId, candidate: { directory: 'site-copy' } });
  assert.equal(closed.candidate.verdict, 'complete');
  assert.equal(closed.candidate.structure.comparedPages, 1);
  assert.equal(closed.candidate.structure.diverged, false);
  assert.equal(closed.candidate.structure.pages.extra.count, 1);
  const scaffoldManifest = JSON.parse(await readFile(join(archiveRoot, scaffolded.directory, '_scaffold', 'scaffold.json'), 'utf8'));
  assert.equal(scaffoldManifest.runId, siteRun.runId);
  assert.deepEqual(scaffoldManifest.files.map(file => file.origin).sort(), ['copied', 'copied', 'generated', 'generated', 'generated', 'generated']);
  assert.equal(scaffoldManifest.files.find(file => file.path === 'app.css').integrity, 'match');
  assert.equal(await readFile(join(archiveRoot, scaffolded.directory, 'app.css'), 'utf8'), ':root{--accent:#112233}');
  await copyFile(new URL('./fixtures/godot-4.7.2-empty.pck', import.meta.url), join(sourceRoot, 'sample.pck'));
  const { id: pckId } = await call('target_add', { kind: 'local', location: 'sample.pck' });
  const pck = await call('dissect', { id: pckId });
  assert.equal(pck.pck.directoryStatus, 'parsed');
  assert.equal(pck.pck.counts.entries, 2);
  await copyFile(new URL('./fixtures/unityfs-lz4-tail.bundle', import.meta.url), join(sourceRoot, 'sample.bundle'));
  const { id: unityId } = await call('target_add', { kind: 'local', location: 'sample.bundle' });
  const unity = await call('dissect', { id: unityId });
  const unityDetails = await call('dossier', { id: unityId, runId: unity.runId, kind: 'binary' });
  assert.equal(unity.unity.headersRead, 1);
  assert.equal(unityDetails.rows[0].blocksInfo.compressedBytes, 41);
  assert.equal(unityDetails.rows[0].blocksInfo.atEnd, true);
  assert.equal(unityDetails.rows[0].blocksInfo.status, 'parsed');
  assert.equal(unityDetails.rows[0].blocksInfo.compression, 'lz4');
  assert.deepEqual(unityDetails.rows[0].nodes.items, [{ index: 0, path: 'assets/demo/data', offset: 0, size: 14, flags: 4 }]);
  assert.equal(unityDetails.rows[0].payload.status, 'parsed');
  assert.equal(unityDetails.rows[0].payload.bytes, 14);
  assert.equal(unityDetails.rows[0].payload.nodes[0].sha256, 'e5de319f964572a88cc57c63161098d5a0afcaf62866fe1b467e9ee16914d062');
  const unityV9 = process.env.GUOLUO_TEST_UNITY_V9 ? await (async () => {
    await copyFile(process.env.GUOLUO_TEST_UNITY_V9, join(sourceRoot, 'official-v9.bundle'));
    const { id } = await call('target_add', { kind: 'local', location: 'official-v9.bundle' });
    const { runId } = await call('dissect', { id });
    const { rows: [row] } = await call('dossier', { id, runId, kind: 'binary' });
    assert.equal(row.formatVersion, 9);
    assert.equal(row.dataStart, 288);
    assert.equal(row.blocksInfo.status, 'parsed');
    assert.equal(row.blocks.count, 11);
    assert.deepEqual(row.blocks.items.map(({ offset }) => offset), [0, 6352, 136624, 221360, 264880, 296080, 312048, 348976, 349312, 355344, 356032]);
    assert.equal(row.payload.status, 'parsed');
    assert.deepEqual(row.payload.nodes.map(({ path, sha256 }) => ({ path, sha256 })), [
      { path: 'BuildPlayer-Scene1.sharedAssets', sha256: '903228b4c44c540c9480d871223edde4049957390532eb39c8f0b2b6058dfa72' },
      { path: 'BuildPlayer-Scene1', sha256: '6cb03b57ba3f6667c18eca8625d227d7a376c38d26cb135055dd1abc0f7512ba' },
      { path: 'BuildPlayer-Scene2.sharedAssets', sha256: '5b8c30385c93aeaf34107ba5f223727b1bb168af4bd40b344da29a323e202c13' },
      { path: 'BuildPlayer-Scene2', sha256: '5229c0310ec19ef66b1e192003fb5dbe28bd1ca7d4680b058a2e6bfcd586f24e' },
    ]);
    return { blocks: row.blocks.count, nodes: row.payload.nodes.length };
  })() : null;
  await copyFile(new URL('./fixtures/unityfs-none.bundle', import.meta.url), join(sourceRoot, 'uncompressed.bundle'));
  const { id: uncompressedId } = await call('target_add', { kind: 'local', location: 'uncompressed.bundle' });
  const { runId: uncompressedRunId } = await call('dissect', { id: uncompressedId });
  const { rows: [uncompressed] } = await call('dossier', { id: uncompressedId, runId: uncompressedRunId, kind: 'binary' });
  assert.equal(uncompressed.blocksInfo.status, 'parsed');
  assert.equal(uncompressed.blocks.count, 1);
  assert.deepEqual(uncompressed.nodes.items, [{ index: 0, path: 'assets/demo/data', offset: 0, size: 14, flags: 4 }]);
  assert.equal(uncompressed.payload.status, 'parsed');
  assert.equal(uncompressed.payload.nodes[0].magic, 'binary');
  // PE32+ 夹具：一个节里带导入（DEMO.dll / CreateThing / 序号 3）和一个命名导出（DoThing），
  // 让符号分页的断言落在非空结果上，而不是「空页也算通过」。
  const RVA = 0x1000, RAW = 0x200, SECTION = 0x400;
  const off = rva => RAW + (rva - RVA);
  const peFixture = Buffer.alloc(RAW + SECTION);
  peFixture.write('MZ', 0, 'latin1');
  peFixture.writeUInt32LE(0x80, 0x3c);
  peFixture.writeUInt32LE(0x4550, 0x80);
  peFixture.writeUInt16LE(0x8664, 0x84);
  peFixture.writeUInt16LE(1, 0x86);
  peFixture.writeUInt16LE(240, 0x94);
  peFixture.writeUInt16LE(0x20b, 0x98);
  peFixture.writeUInt32LE(RVA, 0x98 + 16);
  peFixture.writeBigUInt64LE(0x140000000n, 0x98 + 24);
  peFixture.writeUInt32LE(0x200, 0x98 + 60);
  peFixture.writeUInt16LE(3, 0x98 + 68);
  peFixture.writeUInt32LE(16, 0x98 + 108);
  const peDir = (index, rva, bytes) => {
    peFixture.writeUInt32LE(rva, 0x98 + 112 + index * 8);
    peFixture.writeUInt32LE(bytes, 0x98 + 112 + index * 8 + 4);
  };
  peDir(0, 0x10c0, 40);
  peDir(1, RVA, 40);
  const peTable = 0x98 + 240;
  peFixture.write('.text', peTable, 'latin1');
  peFixture.writeUInt32LE(SECTION, peTable + 8);
  peFixture.writeUInt32LE(RVA, peTable + 12);
  peFixture.writeUInt32LE(SECTION, peTable + 16);
  peFixture.writeUInt32LE(RAW, peTable + 20);
  peFixture.writeUInt32LE(0x60000020, peTable + 36);
  // 导入描述符与 thunk：一条按名字（CreateThing），一条按序号（3）。
  peFixture.writeUInt32LE(0x1040, off(RVA));
  peFixture.writeUInt32LE(0x1060, off(RVA) + 12);
  peFixture.writeUInt32LE(0x1040, off(RVA) + 16);
  peFixture.writeBigUInt64LE(0x1080n, off(0x1040));
  peFixture.writeBigUInt64LE(0x8000000000000003n, off(0x1040) + 8);
  peFixture.write('DEMO.dll', off(0x1060), 'latin1');
  peFixture.writeUInt16LE(0, off(0x1080));
  peFixture.write('CreateThing', off(0x1080) + 2, 'latin1');
  // 导出目录：一个函数槽位、一个名字、序号 0。
  const peExp = off(0x10c0);
  peFixture.writeUInt32LE(1, peExp + 16);
  peFixture.writeUInt32LE(1, peExp + 20);
  peFixture.writeUInt32LE(1, peExp + 24);
  peFixture.writeUInt32LE(0x10e8, peExp + 28);
  peFixture.writeUInt32LE(0x10f0, peExp + 32);
  peFixture.writeUInt32LE(0x10f4, peExp + 36);
  peFixture.writeUInt32LE(RVA, off(0x10e8));
  peFixture.writeUInt32LE(0x10f8, off(0x10f0));
  peFixture.writeUInt16LE(0, off(0x10f4));
  peFixture.write('DoThing', off(0x10f8), 'latin1');
  await writeFile(join(sourceRoot, 'demo.dll'), peFixture);
  const { id: peId } = await call('target_add', { kind: 'local', location: 'demo.dll' });
  const peRun = await call('dissect', { id: peId });
  const { rows: [pe] } = await call('dossier', { id: peId, runId: peRun.runId, kind: 'binary' });
  assert.equal(pe.format, 'pe32+');
  assert.equal(pe.machine, 'x64');
  assert.equal(pe.imports.status, 'parsed');
  assert.equal(pe.exports.status, 'parsed');
  // 单文件档案不必写 path；符号必须真的读出来，不是空页。
  const peImports = await call('dossier', { id: peId, runId: peRun.runId, kind: 'pe-imports', limit: 5 });
  assert.equal(peImports.path, 'demo.dll');
  assert.equal(peImports.source, 'current-file');
  assert.equal(peImports.total, 2);
  assert.deepEqual(peImports.rows.map(row => row.symbol), ['CreateThing', '#3']);
  const peExports = await call('dossier', { id: peId, runId: peRun.runId, kind: 'pe-exports', limit: 5 });
  assert.equal(peExports.total, 1);
  assert.deepEqual(peExports.rows.map(row => row.name), ['DoThing']);
  assert.equal(peExports.nextOffset, null);
  const peSpec = await call('spec', { id: peId, runId: peRun.runId });
  const peEvidence = JSON.parse(await readFile(peSpec.files.json, 'utf8')).evidence.pe.files;
  assert.equal(peEvidence[0].path, 'demo.dll');
  assert.equal(peEvidence[0].format, 'pe32+');
  // 合成的 v24 IL2CPP 元数据：264 字节头 + 名字池 + 一条类型定义，验类型名确实读得出来。
  const il2cppNames = Buffer.from('\0Demo.Type\0', 'latin1');
  const il2cppTypes = Buffer.alloc(92);
  il2cppTypes.writeInt32LE(1, 0);
  const il2cppHeader = Buffer.alloc(8 + 32 * 8);
  il2cppHeader.writeUInt32LE(0xfab11baf, 0);
  il2cppHeader.writeInt32LE(24, 4);
  let il2cppAt = il2cppHeader.length;
  const placeIl2cpp = (index, bytes) => {
    il2cppHeader.writeUInt32LE(il2cppAt, 8 + index * 8);
    il2cppHeader.writeUInt32LE(bytes.length, 8 + index * 8 + 4);
    il2cppAt += bytes.length;
    return bytes;
  };
  const il2cppStrings = placeIl2cpp(2, il2cppNames);
  const il2cppTypeTable = placeIl2cpp(19, il2cppTypes);
  await writeFile(join(sourceRoot, 'global-metadata.dat'), Buffer.concat([il2cppHeader, il2cppStrings, il2cppTypeTable]));
  const { id: il2cppId } = await call('target_add', { kind: 'local', location: 'global-metadata.dat' });
  const il2cppRun = await call('dissect', { id: il2cppId });
  const { rows: [il2cppRow] } = await call('dossier', { id: il2cppId, runId: il2cppRun.runId, kind: 'binary' });
  assert.equal(il2cppRow.status, 'parsed');
  assert.equal(il2cppRow.layout, 'verified');
  assert.equal(il2cppRow.counts.types, 1);
  const il2cppTypes_page = await call('dossier', { id: il2cppId, runId: il2cppRun.runId, kind: 'il2cpp-types', limit: 1 });
  assert.equal(il2cppTypes_page.source, 'current-file');
  assert.equal(il2cppTypes_page.total, 1);
  assert.deepEqual(il2cppTypes_page.rows.map(row => row.name), ['Demo.Type']);
  assert.equal(il2cppTypes_page.nextOffset, null);

  // apk-pagination.apk 由 aapt2 link 生成，清单里各有 70 条 uses-permission 与 activity。
  await copyFile(new URL('./fixtures/apk-pagination.apk', import.meta.url), join(sourceRoot, 'pagination.apk'));
  const { id: apkId } = await call('target_add', { kind: 'local', location: 'pagination.apk' });
  const apkRun = await call('dissect', { id: apkId });
  assert.equal(apkRun.apk.manifest.permissions.total, 70);
  assert.equal(apkRun.apk.manifest.permissions.retained, 70);
  assert.equal(apkRun.apk.manifest.activities.total, 70);
  const firstPage = await call('dossier', { id: apkId, runId: apkRun.runId, kind: 'apk-permission', limit: 50 });
  assert.equal(firstPage.returned, 50);
  assert.equal(firstPage.total, 70);
  assert.equal(firstPage.nextOffset, 50);
  assert.equal(firstPage.rows[0].name, 'com.example.guoluo.permission.P00');
  const secondPage = await call('dossier', { id: apkId, runId: apkRun.runId, kind: 'apk-permission', offset: 50, limit: 50 });
  assert.equal(secondPage.returned, 20);
  assert.equal(secondPage.nextOffset, null);
  assert.equal(secondPage.rows[0].name, 'com.example.guoluo.permission.P50');
  const apkSpec = await call('spec', { id: apkId, runId: apkRun.runId });
  const apkEvidence = JSON.parse(await readFile(apkSpec.files.json, 'utf8')).evidence.apk;
  assert.equal(apkEvidence.permissions.total, 70);
  assert.equal(apkEvidence.permissions.retained, 70);
  const visual = process.env.GUOLUO_TEST_REA ? await (async () => {
    const desc3 = settings.describe().find(row => row.ns === 'guoluo');
    await settings.update('guoluo', { reaPath: process.env.GUOLUO_TEST_REA }, desc3.revision);
    const pages = join(sourceRoot, 'pages');
    await mkdir(pages);
    await writeFile(join(pages, 'index.html'), '<style>body{background:#fff}</style><h1>one</h1>');
    await writeFile(join(pages, 'docs.html'), '<style>body{background:#fff}</style><h1>two</h1>');
    const { id: pagesId } = await call('target_add', { kind: 'local', location: 'pages' });
    const pagesRun = await call('dissect', { id: pagesId });
    const rebuilt = join(sourceRoot, 'pages-rebuilt');
    await mkdir(rebuilt);
    await writeFile(join(rebuilt, 'index.html'), '<style>body{background:#fff}</style><h1>one</h1>');
    await writeFile(join(rebuilt, 'docs.html'), '<style>body{background:#fff}</style><h1>two</h1>');
    const measured = await tools.get('guoluo_check').execute({ id: pagesId, runId: pagesRun.runId, visual: {
      candidateDirectory: 'pages-rebuilt',
      routes: [{ baselineEntry: 'index.html' }, { baselineEntry: 'docs.html', candidateEntry: 'docs.html' }],
    } }, { signal: AbortSignal.timeout(400000) });
    assert.equal(measured.visual.status, 'measured');
    assert.equal(measured.visual.routeCount, 2);
    const summary = JSON.parse(await readFile(join(measured.visual.directory, 'summary.json'), 'utf8'));
    assert.equal(summary.thresholdNote, '本分数按逐通道 0 阈值计算，含抗锯齿差异');
    assert.equal(summary.routes.length, 2);
    for (const [index, route] of summary.routes.entries()) {
      assert.equal(route.status, 'verified');
      assert.equal(route.score, 1);
      assert.equal(route.score, measured.visual.routes[index].score);
      assert.deepEqual(route.rounds.map(round => round.width), [390, 768, 1440]);
      for (const round of route.rounds) {
        assert.equal(round.status, 'verified');
        assert.equal(round.rea.changedPixels, 0);
        assert.equal(round.computed.changedPixels, round.rea.changedPixels);
      }
    }
    return { status: measured.visual.status, routes: measured.visual.routeCount, scores: summary.routes.map(route => route.score) };
  })() : null;
  console.log(JSON.stringify({ result: 'passed', version: probe.pluginVersion, visual, tools: 13, skill: skill.name, command: command.name, liveSettings: true, rea: probe.rea, linkedRea: siteRun.rea.binding.status, derived: { spec: spec.obligations, brief: brief.bytes > 0, tokens: tokens.total, exported: exported.count, mock: mocked.routes, check: checked.verdict, candidate: covered.candidate.verdict, scaffold: scaffolded.counts.copied, structure: closed.candidate.structure.comparedPages }, pck: pck.pck.counts.entries, unity: unityDetails.rows[0].blocksInfo.compression, unityV9, il2cpp: il2cppRow.counts.types }));
} finally {
  await ctx?.fiber.dispose();
  await rm(root, { recursive: true, force: true });
}
