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

function il2cpp(version = IL2CPP_METADATA_VERSION, headerBytes = 256, size = 4096) {
  const buffer = Buffer.alloc(size);
  buffer.writeUInt32LE(0xfab11baf, 0);
  buffer.writeInt32LE(version, 4);
  buffer.writeUInt32LE(headerBytes, 8);
  return buffer;
}

function unityfs({ blocks = [[4, 4, 0]], nodes = [], blockCount = blocks.length, nodeCount = nodes.length,
  codec = 0, data = Buffer.alloc(4), atEnd = false, padStart = false, version = 7, declaredSize,
} = {}) {
  const head = Buffer.concat([Buffer.from('UnityFS\0'), Buffer.alloc(4), Buffer.from('5.x.x\0' + '2021.3.16f1\0'), Buffer.alloc(20)]);
  head.writeUInt32BE(version, 8);
  const align = position => (16 - position % 16) % 16;
  const blocksStart = version >= 7 ? Buffer.concat([head, Buffer.alloc(align(head.length))]) : head;
  const counts = Buffer.alloc(8);
  counts.writeInt32BE(blockCount, 0);
  counts.writeInt32BE(nodeCount, 4);
  const table = Buffer.concat([
    Buffer.alloc(16, 0xab), counts.subarray(0, 4),
    ...blocks.map(([uncompressed, compressed, flags]) => {
      const entry = Buffer.alloc(10);
      entry.writeUInt32BE(uncompressed, 0);
      entry.writeUInt32BE(compressed, 4);
      entry.writeUInt16BE(flags, 8);
      return entry;
    }),
    counts.subarray(4),
    ...nodes.flatMap(([path, offset, size, flags = 4]) => {
      const entry = Buffer.alloc(20);
      entry.writeBigInt64BE(BigInt(offset), 0);
      entry.writeBigInt64BE(BigInt(size), 8);
      entry.writeUInt32BE(flags, 16);
      return [entry, Buffer.from(path + '\0')];
    }),
  ]);
  const padding = Buffer.alloc(padStart ? align(blocksStart.length + (atEnd ? 0 : table.length)) : 0);
  const result = Buffer.concat(atEnd ? [blocksStart, padding, data, table] : [blocksStart, table, padding, data]);
  result.writeBigInt64BE(BigInt(declaredSize ?? result.length), head.length - 20);
  result.writeUInt32BE(table.length, head.length - 12);
  result.writeUInt32BE(table.length, head.length - 8);
  result.writeUInt32BE(0x40 | (atEnd ? 0x80 : 0) | (padStart ? 0x200 : 0) | codec, head.length - 4);
  return result;
}

async function inspectFixture(dir, filename, bytes, kind = 'unity-bundle') {
  const path = join(dir, filename);
  await writeFile(path, bytes);
  return inspectUnityHeader(path, bytes.length, kind);
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

test('仓库生成并经 UnityPy 回读的 UnityFS v6 包读出块表和节点', async () => {
  const bytes = await stock('unityfs-none.bundle');
  const facts = await inspectUnityHeader(fileURLToPath(fixture('unityfs-none.bundle')), bytes.length, 'unity-bundle');
  const { blocksInfo, blocks, nodes, payload, ...header } = facts;
  assert.deepEqual(header, {
    format: 'unityfs', formatVersion: 6, unityVersion: '2021.3.16f1',
    unityRevision: '2021.3.16f1 (0e1a5c4a6b2f)', declaredSize: String(bytes.length), flags: 64,
  });
  assert.deepEqual(blocksInfo, {
    compressedBytes: 71, uncompressedBytes: 71, compressionCode: 0, compression: 'none', atEnd: false,
    status: 'parsed', hash: '0'.repeat(32),
  });
  assert.deepEqual(blocks, {
    count: 1, returned: 1, truncated: false, uncompressedBytes: 14, compressedBytes: 14, compression: ['none'],
    items: [{ index: 0, uncompressedSize: 14, compressedSize: 14, flags: 0, compression: 'none' }],
  });
  assert.deepEqual(nodes, {
    count: 1, returned: 1, truncated: false,
    items: [{ index: 0, path: 'assets/demo/data', offset: 0, size: 14, flags: 4 }],
  });
  assert.equal(payload.status, 'unobserved');
  assert.deepEqual(JSON.parse(JSON.stringify(facts)), facts);
});

test('尾置 LZ4 块信息及压缩前后等长的非零 codec 均未解压', async () => {
  const bytes = await stock('unityfs-lz4-tail.bundle');
  const facts = await inspectUnityHeader(fileURLToPath(fixture('unityfs-lz4-tail.bundle')), bytes.length, 'unity-bundle');
  assert.equal(facts.formatVersion, 7);
  assert.equal(facts.declaredSize, '135');
  assert.equal(facts.flags, 194);
  assert.deepEqual(facts.blocksInfo, {
    compressedBytes: 41, uncompressedBytes: 71, compressionCode: 2, compression: 'lz4', atEnd: true, status: 'unobserved',
  });
  assert.equal(facts.blocks, null);
  assert.equal(facts.nodes, null);
  assert.match(facts.reason, /lz4.*未解压/u);

  const dir = await scratch();
  for (const [codec, name] of [[1, 'lzma'], [2, 'lz4'], [3, 'lz4hc'], [4, 'lzham']]) {
    const sameSize = await inspectFixture(dir, `${name}.bundle`, unityfs({ codec, nodes: [['not-against-codec', 0, 4]] }));
    assert.equal(sameSize.blocksInfo.compressedBytes, sameSize.blocksInfo.uncompressedBytes);
    assert.equal(sameSize.blocksInfo.compression, name);
    assert.equal(sameSize.nodes, null);
    assert.match(sameSize.reason, /未解压/u);
  }
});

test('UnityFS 在前置有填充与尾置布局按逻辑数据区校验多个节点', async () => {
  const dir = await scratch();
  for (const atEnd of [false, true]) {
    const facts = await inspectFixture(dir, `layout-${atEnd}.bundle`, unityfs({
      blocks: [[4, 4, 0], [6, 2, 2]], data: Buffer.alloc(6), atEnd, padStart: true,
      nodes: [['空目录/资源', 2, 6], ['last.resS', 8, 2, 0]],
    }));
    assert.equal(facts.blocks.count, 2);
    assert.equal(facts.blocks.uncompressedBytes, 10);
    assert.equal(facts.blocks.compressedBytes, 6);
    assert.deepEqual(facts.nodes.items, [
      { index: 0, path: '空目录/资源', offset: 2, size: 6, flags: 4 },
      { index: 1, path: 'last.resS', offset: 8, size: 2, flags: 0 },
    ]);
    assert.match(facts.payload.reason, /未解压，节点内容未观测/u);
  }
});

test('UnityFS 拒绝声明不一致、超出数量或路径上限及越界的节点', async () => {
  const dir = await scratch();
  const cases = [
    [{ blockCount: 2 }, /块数与声明不一致/u],
    [{ nodeCount: 1 }, /节点数与声明不一致/u],
    [{ nodeCount: 513 }, /节点数 513.*上限/u],
    [{ nodes: [['界'.repeat(1366), 0, 1]] }, /4096 字节上限/u],
    [{ nodes: [['too-far', 3, 2]] }, /越出数据区/u],
    [{ nodes: [['negative', -1, 1]] }, /越出数据区/u],
    [{ data: Buffer.alloc(3) }, /块存储长度之和 4 超出数据区 3 字节/u],
    [{ blocks: [[5, 4, 0]] }, /存储长度与逻辑长度不一致/u],
  ];
  for (const [index, [options, reason]] of cases.entries()) {
    await assert.rejects(inspectFixture(dir, `invalid-${index}.bundle`, unityfs(options)), reason);
  }
});

test('UnityFS 对前置和尾置块信息都计入头部对齐', async () => {
  const dir = await scratch();
  for (const { format, revision, flags } of [
    { format: 7, revision: '2021.3.16f1', flags: 64 },
    { format: 7, revision: '2021.3.16f1', flags: 194 },
    { format: 6, revision: '2019.4.15f1', flags: 64 },
  ]) {
    const prefix = Buffer.concat([Buffer.from('UnityFS\0'), Buffer.alloc(4), Buffer.from(`5.x.x\0${revision}\0`)]);
    prefix.writeUInt32BE(format, 8);
    const headerEnd = prefix.length + 20;
    assert.notEqual(headerEnd % 16, 0);
    const lengthWithoutPadding = headerEnd + 41;
    const bytes = Buffer.alloc(lengthWithoutPadding);
    prefix.copy(bytes);
    bytes.writeBigUInt64BE(BigInt(bytes.length), prefix.length);
    bytes.writeUInt32BE(41, prefix.length + 8);
    bytes.writeUInt32BE(71, prefix.length + 12);
    bytes.writeUInt32BE(flags, prefix.length + 16);
    const path = join(dir, `v${format}-${flags}.bundle`);
    await writeFile(path, bytes);
    await assert.rejects(inspectUnityHeader(path, bytes.length, 'unity-bundle'), /元数据块范围越界/u);
  }
});

test('IL2CPP 按白名单版本校验头长，包含共用声明版本的 v24 子版', async () => {
  const dir = await scratch();
  for (const [version, headerBytes] of [[16, 192], [24, 264], [24, 272], [27, 256], [29, 256], [31, 256]]) {
    const facts = await inspectFixture(dir, `v${version}-${headerBytes}.dat`, il2cpp(version, headerBytes, headerBytes), 'il2cpp-metadata');
    assert.deepEqual(facts, { format: 'il2cpp-metadata', metadataVersion: version, headerBytes });
  }
  for (const version of [0, 17, 18, 25, 26, 28, 30, 32]) {
    await assert.rejects(inspectFixture(dir, `v${version}.dat`, il2cpp(version), 'il2cpp-metadata'), new RegExp(`版本 ${version} 不在已知白名单`));
  }
  await assert.rejects(inspectFixture(dir, 'short-header.dat', il2cpp(24, 264, 263), 'il2cpp-metadata'), /短于版本 24/u);
  await assert.rejects(inspectFixture(dir, 'past-eof.dat', il2cpp(24, 272, 264), 'il2cpp-metadata'), /偏移 272 无效/u);
  await assert.rejects(inspectFixture(dir, 'wrong-offset.dat', il2cpp(29, 272), 'il2cpp-metadata'), /偏移 272 无效/u);
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
  await assert.rejects(inspectUnityHeader(join(dir, 'truncated.bundle'), truncated.length, 'unity-bundle'), /版本字符串缺终止符/u);

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

  const binary = await service.dossier({ id: added.id, runId: run.runId, kind: 'binary', limit: 1 });
  assert.equal(binary.total, 2);
  assert.equal(binary.nextOffset, 1);
  assert.equal(binary.rows[0].path, 'assets/desktop.bundle');
  assert.equal(binary.rows[0].blocks.count, 1);
  assert.equal(binary.rows[0].nodes.count, 1);
  assert.deepEqual(binary.rows[0].nodes.items, [{ index: 0, path: 'assets/demo/data', offset: 0, size: 14, flags: 4 }]);
  const second = await service.dossier({ id: added.id, runId: run.runId, kind: 'binary', limit: 1, offset: binary.nextOffset });
  assert.equal(second.rows[0].path, 'global-metadata.dat');
  assert.equal(second.nextOffset, null);

  const spec = await service.spec({ id: added.id, runId: run.runId });
  const markdown = await readFile(spec.files.markdown, 'utf8');
  assert.match(markdown, /Unity assets\/desktop\.bundle \| UnityFS 6 \/ 2021\.3\.16f1/u);
  assert.match(markdown, /Unity global-metadata\.dat \| IL2CPP 声明版本 29/u);
  const json = JSON.parse(await readFile(spec.files.json, 'utf8'));
  assert.equal(json.evidence.unity.length, 2);
  assert.match(markdown, /UnityFS 节点 1 \/ 块 1/u);
  assert.ok(json.unknowns.some(text => text.includes('IL2CPP 元数据表和运行时依赖未观测')));

  const mock = await service.mock({ id: added.id, runId: run.runId, port: 5199 });
  const config = JSON.parse(await readFile(mock.files.config, 'utf8'));
  assert.deepEqual(config.unreplayed.map(item => item.value).sort(), ['assets/desktop.bundle', 'global-metadata.dat']);
  assert.ok(config.unreplayed.every(item => item.reason === 'Unity 候选素材未纳入回放'));
});

test('binary dossier 限制表明细的字节数，但验证摘要之外的节点', async () => {
  const root = await scratch();
  const sourceRoot = join(root, 'source');
  const archiveRoot = join(root, 'archive');
  const build = join(sourceRoot, 'build');
  await mkdir(build, { recursive: true });
  await mkdir(archiveRoot);
  const nodes = Array.from({ length: 100 }, (_, index) => [`${index}/`.padEnd(4096, 'a'), 0, 4]);
  await writeFile(join(build, 'large.bundle'), unityfs({ nodes }));
  await writeFile(join(build, 'bad-tail.bundle'), unityfs({ nodes: [...nodes.slice(0, -1), ['bad-tail', 3, 2]] }));
  await writeFile(join(build, 'global-metadata.dat'), il2cpp(32));
  const service = projectService({ sourceRoot, archiveRoot });
  const { id } = await service.add({ kind: 'local', location: 'build' });
  const run = await service.dissect({ id, rea: false });
  const details = await service.dossier({ id, kind: 'binary' });
  const large = details.rows.find(row => row.path === 'large.bundle');
  assert.equal(run.coverage.clipped, true);
  assert.equal(large.nodes.count, 100);
  assert.equal(large.nodes.truncated, true);
  assert.equal(large.nodes.returned, large.nodes.items.length);
  assert.ok(large.nodes.returned > 0 && large.nodes.returned < 100);
  assert.deepEqual(large.nodes.items.map(node => node.path), nodes.slice(0, large.nodes.returned).map(([path]) => path));
  assert.ok(details.bytes <= 512 * 1024);
  const bad = details.rows.find(row => row.path === 'bad-tail.bundle');
  assert.equal(bad.status, 'unreadable');
  assert.match(bad.reason, /第 99 个节点.*越出数据区/u);
  const unknown = details.rows.find(row => row.path === 'global-metadata.dat');
  assert.equal(unknown.status, 'unreadable');
  assert.match(unknown.reason, /版本 32 不在已知白名单/u);
});

test('Unity 盘点分别记录读头失败和预算跳过', async () => {
  const root = await scratch();
  const sourceRoot = join(root, 'source');
  const archiveRoot = join(root, 'archive');
  const build = join(sourceRoot, 'build');
  await mkdir(build, { recursive: true });
  await mkdir(archiveRoot);
  const sample = await stock('unityfs-none.bundle');
  await Promise.all(Array.from({ length: 18 }, (_, index) =>
    writeFile(join(build, `candidate-${index}.bundle`), index < 3 ? 'invalid' : sample)));
  const service = projectService({ sourceRoot, archiveRoot });
  const { id } = await service.add({ kind: 'local', location: 'build' });
  const run = await service.dissect({ id, rea: false });
  const details = await service.dossier({ id, kind: 'binary' });
  assert.equal(run.coverage.skippedUnityHeaders, 2);
  assert.equal(run.coverage.clipped, true);
  assert.equal(run.totals.asset, 18);
  assert.equal(details.rows.length, 16);
  assert.ok(details.rows.some(row => row.status === 'unreadable'));
  const mock = await service.mock({ id });
  const config = JSON.parse(await readFile(mock.files.config, 'utf8'));
  assert.equal(config.unreplayed.length, 18);
  assert.ok(config.unreplayed.every(item => item.reason === 'Unity 候选素材未纳入回放'));
});