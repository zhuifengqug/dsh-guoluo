// Run against the installed DSH packages and an unpacked npm tarball, never the desktop profile.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
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
  assert.deepEqual(tools.schemas().map(tool => tool.name).filter(name => name.startsWith('guoluo_')).sort(), ['guoluo_check', 'guoluo_dissect', 'guoluo_dossier', 'guoluo_export', 'guoluo_list', 'guoluo_mock', 'guoluo_probe', 'guoluo_spec', 'guoluo_status', 'guoluo_target_add', 'guoluo_tokens']);
  const exec = { signal: AbortSignal.timeout(15000) };
  const call = (suffix, args) => tools.get(`guoluo_${suffix}`).execute(args, exec);
  assert.equal((await call('probe', {})).directories.ready, false);
  await settings.update('guoluo', { sourceRoot, archiveRoot }, desc.revision);
  const probe = await call('probe', {});
  assert.equal(probe.directories.ready, true);
  const skill = await ctx.get('skills').get('guoluo-rebuild', { cwd: root });
  assert.equal(skill?.provider, 'guoluo');
  const command = ctx.get('commands').find({}, 'guoluo');
  assert.equal((await command.handler({ rawInput: 'list', ...exec })).kind, 'success');
  const { id } = await call('target_add', { kind: 'local', location: 'design.css' });
  const { runId } = await call('dissect', { id });
  const { rows } = await call('dossier', { id, runId, kind: 'token' });
  assert.deepEqual(rows, [{ kind: 'token', path: 'design.css', line: 1, name: '--accent', value: '#112233' }]);
  const spec = await call('spec', { id });
  assert.equal(spec.obligations, 2);
  const tokens = await call('tokens', { id });
  assert.equal(tokens.total, 1);
  const exported = await call('export', { id, format: 'csv' });
  assert.equal(exported.count, 2);
  const mocked = await call('mock', { id, port: 8877 });
  assert.equal(mocked.assets, 0);
  const checked = await call('check', { id });
  assert.equal(checked.verdict, 'complete');
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
  console.log(JSON.stringify({ result: 'passed', tools: 11, skill: skill.name, command: command.name, liveSettings: true, rea: probe.rea, linkedRea: siteRun.rea.binding.status, derived: { spec: spec.obligations, tokens: tokens.total, exported: exported.count, mock: mocked.routes, check: checked.verdict } }));
} finally {
  await ctx?.fiber.dispose();
  await rm(root, { recursive: true, force: true });
}
