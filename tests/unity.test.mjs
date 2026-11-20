import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { inspectUnityHeader, unityCandidate } from '../lib/unity.mjs';
import { projectService } from '../lib/projects.mjs';

const workspaces = [];
after(async () => { await Promise.all(workspaces.map(dir => rm(dir, { recursive: true, force: true }))); });

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-unity-'));
  workspaces.push(dir);
  return dir;
}

const fixture = name => new URL(`./fixtures/${name}`, import.meta.url);
const stock = name => readFile(fixture(name));
const IL2CPP_METADATA_VERSION = 29;

function il2cpp(size = 4096) {
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32LE(0xfab11baf, 0);
  buffer.writeInt32LE(IL2CPP_METADATA_VERSION, 4);
  return buffer;
}

test('识别 Unity 素材文件而不抢走其它扩展名', () => {
  assert.equal(unityCandidate('Global-Metadata.dat'), 'il2cpp-metadata');
  assert.equal(unityCandidate('game/global-metadata.dat'), 'il2cpp-metadata');
  assert.equal(unityCandidate('assets/desktop.bundle'), 'unity-bundle');
  assert.equal(unityCandidate('level.UNITY3D'), 'unity-bundle');
  for (const path of ['app.exe', 'data.pck', 'index.html', 'global-metadata.dat.bak', 'metadata.dat']) {
    assert.equal(unityCandidate(path), null, path);
  }
});

test('UnityPy 写下并由 UnityPy 回读的 UnityFS 头被一致读出', async () => {
  const bytes = await stock('unityfs-none.bundle');
  const facts = await inspectUnityHeader(fileURLToPath(fixture('unityfs-none.bundle')), bytes.length, 'unity-bundle');
  assert.deepEqual(facts, {
    format: 'unityfs',
    formatVersion: 6,
    unityVersion: '2021.3.16f1',
    unityRevision: '2021.3.16f1 (0e1a5c4a6b2f)',
    declaredSize: String(bytes.length),
    flags: 64,
    blocksInfo: { compressedBytes: 71, uncompressedBytes: 71, compressionCode: 0, compression: 'none', atEnd: false },
  });
});

test('IL2CPP 元数据只取头标识与声明版本', async () => {
  const dir = await scratch();
  const path = join(dir, 'global-metadata.dat');
  const bytes = il2cpp();
  await writeFile(path, bytes);
  assert.deepEqual(await inspectUnityHeader(path, bytes.length, 'il2cpp-metadata'), { format: 'il2cpp-metadata', metadataVersion: IL2CPP_METADATA_VERSION });
});

test('坏头、越界声明与读取期变化都被拒绝', async () => {
  const dir = await scratch();
  const wrongMagic = Buffer.from('UnityRaw\0', 'latin1');
  await writeFile(join(dir, 'wrong.bundle'), wrongMagic);
  await assert.rejects(inspectUnityHeader(join(dir, 'wrong.bundle'), wrongMagic.length, 'unity-bundle'), /UnityFS 头/u);

  const old = Buffer.alloc(64);
  old.write('UnityFS\0', 0, 'latin1');
  old.writeUInt32BE(5, 8);
  await writeFile(join(dir, 'old.bundle'), old);
  await assert.rejects(inspectUnityHeader(join(dir, 'old.bundle'), old.length, 'unity-bundle'), /格式版本/u);

  // 头声明 6、但没有版本字符串终止符：既不能猜也不能越界读
  const truncated = Buffer.alloc(64);
  truncated.fill(0x41, 0);
  truncated.write('UnityFS\0', 0, 'latin1');
  truncated.writeUInt32BE(6, 8);
  await writeFile(join(dir, 'truncated.bundle'), truncated);
  await assert.rejects(inspectUnityHeader(join(dir, 'truncated.bundle'), truncated.length, 'unity-bundle'), /终止符|控制字符|不完整|越界/u);

  const notIl2cpp = Buffer.from('notil2cpp', 'latin1');
  await writeFile(join(dir, 'global-metadata.dat'), notIl2cpp);
  await assert.rejects(inspectUnityHeader(join(dir, 'global-metadata.dat'), notIl2cpp.length, 'il2cpp-metadata'), /头标识无效/u);

  const shortMetadata = Buffer.from([0xaf, 0x1b]);
  await writeFile(join(dir, 'short.dat'), shortMetadata);
  await assert.rejects(inspectUnityHeader(join(dir, 'short.dat'), shortMetadata.length, 'il2cpp-metadata'), /头标识无效或不完整/u);

  const stale = join(dir, 'stale.bundle');
  await writeFile(stale, await stock('unityfs-none.bundle'));
  await assert.rejects(inspectUnityHeader(stale, 999, 'unity-bundle'), /大小无效或已改变/u);
});

test('目录盘点登记 Unity 素材行、头部证据、规格与不回放说明', async () => {
  const root = await scratch();
  const source = join(root, 'source');
  const archive = join(root, 'archive');
  await mkdir(join(source, 'build', 'assets'), { recursive: true });
  await mkdir(archive, { recursive: true });
  await writeFile(join(source, 'build', 'assets', 'desktop.bundle'), await stock('unityfs-none.bundle'));
  const metadata = il2cpp();
  await writeFile(join(source, 'build', 'global-metadata.dat'), metadata);

  const service = projectService({
    sourceRoot: { get: () => source },
    archiveRoot: { get: () => archive },
    reaPath: { get: () => '' },
    chromiumPath: { get: () => '' },
    reaTimeoutMs: { get: () => 180000 },
  });
  const added = await service.add({ kind: 'local', location: 'build', label: 'unity' });
  const run = await service.dissect({ id: added.id, rea: false });

  assert.equal(run.rea.status, 'off');
  const rows = (await service.dossier({ id: added.id, runId: run.runId, kind: 'asset', limit: 50 })).rows;
  assert.deepEqual(rows.find(row => row.path === 'assets/desktop.bundle'), { kind: 'asset', path: 'assets/desktop.bundle', type: 'unity-bundle', bytes: 156 });
  assert.deepEqual(rows.find(row => row.path === 'global-metadata.dat'), { kind: 'asset', path: 'global-metadata.dat', type: 'il2cpp-metadata', bytes: metadata.length });
  assert.deepEqual(run.unity, { files: 2, headersRead: 2, detail: '逐文件头部证据见 guoluo_dossier kind=binary。' });

  const binary = await service.dossier({ id: added.id, runId: run.runId, kind: 'binary', limit: 50 });
  assert.deepEqual(binary.rows.map(item => item.path).sort(), ['assets/desktop.bundle', 'global-metadata.dat']);

  const spec = await service.spec({ id: added.id, runId: run.runId });
  const markdown = await readFile(spec.files.markdown, 'utf8');
  assert.match(markdown, /Unity assets\/desktop\.bundle \| UnityFS 6 \/ 2021\.3\.16f1/u);
  assert.match(markdown, /Unity global-metadata\.dat \| IL2CPP 声明版本 29/u);
  const json = JSON.parse(await readFile(spec.files.json, 'utf8'));
  assert.equal(json.evidence.unity.length, 2);
  assert.ok(json.unknowns.some(text => text.includes('Unity 当前只取得头部证据')));

  const mock = await service.mock({ id: added.id, runId: run.runId, port: 5199 });
  const config = JSON.parse(await readFile(mock.files.config, 'utf8'));
  assert.deepEqual(config.unreplayed.map(item => item.value).sort(), ['assets/desktop.bundle', 'global-metadata.dat']);
  assert.ok(config.unreplayed.every(item => item.reason.includes('Unity 素材仅有头部证据')));
});