// Run against the installed DSH packages and an unpacked npm tarball, never the desktop profile.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [modules, packageDir] = process.argv.slice(2).map(value => resolve(value));
if (!modules || !packageDir) throw new Error('用法：node tests/host-smoke.mjs <DSH node_modules> <拆包后的 package 目录>');
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
  ({ ctx } = await runProfile({ environment: createLaunchEnvironmentSnapshot([]), profile, patchFiles: [], args: [] }));
  const settings = ctx.get('settings');
  const desc = settings.describe().find(row => row.ns === 'guoluo');
  assert.equal(desc?.autoGenerate, true);
  const tools = ctx.get('tools');
  assert.deepEqual(tools.schemas().map(tool => tool.name).filter(name => name.startsWith('guoluo_')).sort(), ['guoluo_dissect', 'guoluo_dossier', 'guoluo_list', 'guoluo_probe', 'guoluo_status', 'guoluo_target_add']);
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
  console.log(JSON.stringify({ result: 'passed', tools: 6, skill: skill.name, command: command.name, liveSettings: true, rea: probe.rea, rows }));
} finally {
  await ctx?.fiber.dispose();
  await rm(root, { recursive: true, force: true });
}
