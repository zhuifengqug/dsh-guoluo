import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
  // v9 的块记录是 10 字节后接一个大端 u64 存储偏移；老版本只有 10 字节。偏移与填充由调用方给，
  // 数据区按给定字节原样写入，这样断言才绑在真实字节上。
  const hasOffsets = version === 9;
  const table = Buffer.concat([
    Buffer.alloc(16, 0xab), counts.subarray(0, 4),
    ...blocks.map(([uncompressed, compressed, flags, offset = 0]) => {
      const entry = Buffer.alloc(hasOffsets ? 18 : 10);
      entry.writeUInt32BE(uncompressed, 0);
      entry.writeUInt32BE(compressed, 4);
      entry.writeUInt16BE(flags, 8);
      if (hasOffsets) entry.writeBigUInt64BE(BigInt(offset), 10);
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
    format: 'unityfs', formatVersion: 6, tableLayout: 'verified', unityVersion: '2021.3.16f1',
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
  assert.equal(payload.status, 'parsed');
  assert.equal(payload.bytes, 14);
  assert.equal(payload.truncated, false);
  assert.deepEqual(payload.nodes, [{
    index: 0, path: 'assets/demo/data', size: 14,
    sha256: 'e5de319f964572a88cc57c63161098d5a0afcaf62866fe1b467e9ee16914d062',
    magic: 'binary', preview: Buffer.from('guoluo-fixture').toString('hex'),
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(facts)), facts);
});

test('UnityPy 独立写入并回读的无压缩表与插件逐项一致', async () => {
  // UnityPy 1.25.4 snapshot: regenerate with tests/fixtures/make-unityfs.py.
  const base64 = 'VW5pdHlGUwAAAAAHMjAyMS4zLjE2ZjEAMjAyMS4zLjE2ZjEgKDBlMWE1YzRhNmIyZikAAAAAAAAAAOQAAABzAAAAcwAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAAACEAAAAhAEAAAAACAAAAAAAAAAAAAAAAAAAADgAAAARhc3NldHMvZGVtby9kYXRhAAAAAAAAAAAOAAAAAAAAABMAAAAAYXNzZXRzL2RlbW8vc2Vjb25kLnJlc1MAZ3VvbHVvLWZpeHR1cmVzZWNvbmQgVW5pdHlQeSBub2Rl';
  const facts = await inspectFixture(await scratch(), 'unitypy-none.bundle', Buffer.from(base64, 'base64'));
  assert.equal(facts.blocksInfo.compressionCode, 0);
  assert.equal(facts.blocksInfo.status, 'parsed');
  assert.equal(facts.nodes.count, 2);
  assert.deepEqual(facts.nodes.items.map(({ index, ...node }) => node), [
    { offset: 0, size: 14, flags: 4, path: 'assets/demo/data' },
    { offset: 14, size: 19, flags: 0, path: 'assets/demo/second.resS' },
  ]);
  assert.equal(facts.blocks.count, 1);
  assert.deepEqual(facts.blocks.items.map(({ index, compression, ...block }) => block), [{ uncompressedSize: 33, compressedSize: 33, flags: 64 }]);
  const codecCounts = {};
  for (const { compression } of facts.blocks.items) codecCounts[compression] = (codecCounts[compression] ?? 0) + 1;
  assert.deepEqual(codecCounts, { none: 1 });
});

test('尾置 LZ4 块信息由插件自行解压，LZHAM 仍标未观测', async () => {
  const bytes = await stock('unityfs-lz4-tail.bundle');
  const facts = await inspectUnityHeader(fileURLToPath(fixture('unityfs-lz4-tail.bundle')), bytes.length, 'unity-bundle');
  assert.equal(facts.formatVersion, 7);
  assert.equal(facts.declaredSize, '135');
  assert.equal(facts.flags, 194);
  assert.equal(facts.blocksInfo.compressionCode, 2);
  assert.equal(facts.blocksInfo.compressedBytes, 41);
  assert.equal(facts.blocksInfo.uncompressedBytes, 71);
  assert.equal(facts.blocksInfo.atEnd, true);
  assert.equal(facts.blocksInfo.status, 'parsed');
  assert.deepEqual(facts.nodes.items, [{ index: 0, path: 'assets/demo/data', offset: 0, size: 14, flags: 4 }]);

  const dir = await scratch();
  for (const [codec, name] of [[4, 'lzham']]) {
    const unsupported = await inspectFixture(dir, `${name}.bundle`, unityfs({ codec, nodes: [['not-against-codec', 0, 4]] }));
    assert.equal(unsupported.blocksInfo.compression, name);
    assert.equal(unsupported.blocksInfo.status, 'unobserved');
    assert.equal(unsupported.nodes, null);
    assert.match(unsupported.reason, /暂未支持/u);
  }
});

test('UnityPy 写出的 LZMA 包由插件自行解压块信息与数据块', async () => {
  const small = await stock('unityfs-lzma.bundle');
  const infoOnly = await inspectUnityHeader(fileURLToPath(fixture('unityfs-lzma.bundle')), small.length, 'unity-bundle');
  assert.equal(infoOnly.formatVersion, 7);
  assert.equal(infoOnly.blocksInfo.compressionCode, 1);
  assert.equal(infoOnly.blocksInfo.compression, 'lzma');
  assert.equal(infoOnly.blocksInfo.status, 'parsed');
  assert.equal(infoOnly.blocksInfo.compressedBytes, 46);
  assert.equal(infoOnly.blocksInfo.uncompressedBytes, 71);
  assert.equal(infoOnly.payload.status, 'parsed');
  assert.equal(infoOnly.payload.nodes[0].sha256, 'e5de319f964572a88cc57c63161098d5a0afcaf62866fe1b467e9ee16914d062');
  assert.equal(infoOnly.payload.nodes[0].preview, '67756f6c756f2d66697874757265');

  const big = await stock('unityfs-lzma-data.bundle');
  const withData = await inspectUnityHeader(fileURLToPath(fixture('unityfs-lzma-data.bundle')), big.length, 'unity-bundle');
  assert.deepEqual(withData.blocks.items.map(({ index, ...block }) => block), [{ uncompressedSize: 4110, compressedSize: 291, flags: 1, compression: 'lzma' }]);
  assert.equal(withData.payload.status, 'parsed');
  assert.equal(withData.payload.bytes, 4110);
  assert.deepEqual(withData.payload.nodes.map(node => node.sha256), [
    'e5de319f964572a88cc57c63161098d5a0afcaf62866fe1b467e9ee16914d062',
    'c1c10a74a227a912f6ebfb36273ee6c678349f9fb9535bc60a9f2467f6e5753d',
  ]);
});

test('LZ4 块信息自称压缩却解不开时明确报错，不返回半张表', async () => {
  const dir = await scratch();
  // 压缩段里放的不是合法 LZ4 流：必须抛错，而不是把截断的表当成解析结果。
  const broken = unityfs({ codec: 2, blocks: [], data: Buffer.alloc(0), nodes: [], blockCount: 0, nodeCount: 0 });
  await assert.rejects(inspectFixture(dir, 'broken-lz4.bundle', broken), /LZ4/u);
});

test('UnityFS 在前置有填充与尾置布局按逻辑数据区校验多个节点', async () => {
  const dir = await scratch();
  for (const atEnd of [false, true]) {
    const facts = await inspectFixture(dir, `layout-${atEnd}.bundle`, unityfs({
      blocks: [[4, 4, 0], [6, 6, 0]], data: Buffer.alloc(10), atEnd, padStart: true,
      nodes: [['空目录/资源', 2, 6], ['last.resS', 8, 2, 0]],
    }));
    assert.equal(facts.blocks.count, 2);
    assert.equal(facts.blocks.uncompressedBytes, 10);
    assert.equal(facts.blocks.compressedBytes, 10);
    assert.deepEqual(facts.nodes.items, [
      { index: 0, path: '空目录/资源', offset: 2, size: 6, flags: 4 },
      { index: 1, path: 'last.resS', offset: 8, size: 2, flags: 0 },
    ]);
    assert.equal(facts.payload.status, 'parsed');
    assert.equal(facts.payload.bytes, 10);
    assert.deepEqual(facts.payload.nodes.map(({ index, path, size, magic }) => ({ index, path, size, magic })), [
      { index: 0, path: '空目录/资源', size: 6, magic: 'zero-filled' },
      { index: 1, path: 'last.resS', size: 2, magic: 'zero-filled' },
    ]);
  }
  // 数据块自称 LZ4 却不是合法流：不返回半份载荷，只记解压失败的原因。
  const broken = await inspectFixture(dir, 'broken-data.bundle', unityfs({
    blocks: [[4, 4, 0], [6, 2, 2]], data: Buffer.alloc(6), nodes: [['x.resS', 0, 4]],
  }));
  assert.equal(broken.payload.status, 'failed');
  assert.match(broken.payload.reason, /数据区解压失败/u);
});

test('UnityFS 数据块 LZ4 正例由插件自行解压并切出节点指纹', async () => {
  const dir = await scratch();
  const literal = Buffer.concat([Buffer.from([0xe0]), Buffer.from('guoluo-fixture')]);
  const facts = await inspectFixture(dir, 'lz4-data.bundle', unityfs({
    blocks: [[14, literal.length, 2]], data: literal, nodes: [['assets/demo/data', 0, 14]],
  }));
  assert.ok(facts.blocks.compression.includes('lz4'));
  assert.equal(facts.payload.status, 'parsed');
  assert.equal(facts.payload.bytes, 14);
  assert.equal(facts.payload.nodes[0].sha256, 'e5de319f964572a88cc57c63161098d5a0afcaf62866fe1b467e9ee16914d062');
  assert.equal(facts.payload.nodes[0].preview, '67756f6c756f2d66697874757265');
  // 反证：载荷里改一个字节，节点指纹必须跟着变，说明哈希绑定的确实是解压后的内容。
  const tampered = await inspectFixture(dir, 'lz4-data-tamper.bundle', unityfs({
    blocks: [[14, literal.length, 2]], data: Buffer.concat([Buffer.from([0xe0]), Buffer.from('guoluo-fixturf')]),
    nodes: [['assets/demo/data', 0, 14]],
  }));
  assert.notEqual(tampered.payload.nodes[0].sha256, facts.payload.nodes[0].sha256);
  // 反证：节点偏移挪一格，切出的字节不同，指纹同样不同。
  const shifted = await inspectFixture(dir, 'lz4-data-shift.bundle', unityfs({
    blocks: [[14, literal.length, 2]], data: literal, nodes: [['assets/demo/data', 1, 13]],
  }));
  assert.notEqual(shifted.payload.nodes[0].sha256, facts.payload.nodes[0].sha256);
});

test('UnityFS v9 按块表记录的存储偏移取块，不靠累加', async () => {
  const dir = await scratch();
  const head = Buffer.from('guoluo-v9-head!!');
  const tail = Buffer.from('zhu');
  // 第 1 块前留 5 字节填充：按压缩长度累加会把它当成块数据起点，读出来就是错的。
  const data = Buffer.concat([head, Buffer.alloc(5), tail]);
  const facts = await inspectFixture(dir, 'v9-padded.bundle', unityfs({
    version: 9, blocks: [[16, 16, 0, 0], [3, 3, 0, 21]], data,
    nodes: [['head.resS', 0, 16], ['tail.resS', 16, 3]],
  }));
  assert.equal(facts.formatVersion, 9);
  assert.deepEqual(facts.blocks.items.map(({ offset, compressedSize }) => ({ offset, compressedSize })), [
    { offset: 0, compressedSize: 16 },
    { offset: 21, compressedSize: 3 },
  ]);
  assert.equal(facts.blocks.compressedBytes, 19);
  assert.equal(facts.payload.status, 'parsed');
  assert.equal(facts.payload.bytes, 19);
  assert.deepEqual(facts.payload.nodes.map(node => node.sha256), [
    createHash('sha256').update(head).digest('hex'),
    createHash('sha256').update(tail).digest('hex'),
  ]);

  // 反证：把第 2 块的偏移压回第 1 块内部，必须判重叠而不是静默读错。
  const secondEntry = 64 + 20 + 18;
  const overlap = unityfs({ version: 9, blocks: [[16, 16, 0, 0], [3, 3, 0, 21]], data, nodes: [] });
  overlap.writeBigUInt64BE(0n, secondEntry + 10);
  await assert.rejects(inspectFixture(dir, 'v9-overlap.bundle', overlap), /重叠/u);

  // 反证：偏移落在数据区之外，以及偏移合法但块尾越过数据区，两种都拒绝。
  const beyond = unityfs({ version: 9, blocks: [[16, 16, 0, 0], [3, 3, 0, 21]], data, nodes: [] });
  beyond.writeBigUInt64BE(0xffffffffffffffffn, secondEntry + 10);
  await assert.rejects(inspectFixture(dir, 'v9-beyond.bundle', beyond), /超出数据区/u);

  const range = unityfs({ version: 9, blocks: [[16, 16, 0, 0], [3, 3, 0, 21]], data, nodes: [] });
  range.writeBigUInt64BE(22n, secondEntry + 10);
  await assert.rejects(inspectFixture(dir, 'v9-range.bundle', range), /存储范围.*超出数据区/u);
});

test('UnityFS v9 显式偏移与 LZ4 数据块、尾置表同时生效', async () => {
  const dir = await scratch();
  // LZ4 块格式：token 高 4 位是字面量长度，两块都用纯字面量，不带匹配。
  const first = Buffer.concat([Buffer.from([0xe0]), Buffer.from('guoluo-v9-lz4!')]); // 14 字节逻辑
  const second = Buffer.concat([Buffer.from([0x30]), Buffer.from('zhu')]); // 3 字节逻辑
  const data = Buffer.concat([first, Buffer.alloc(16), second]);
  const facts = await inspectFixture(dir, 'v9-lz4-end.bundle', unityfs({
    version: 9, atEnd: true,
    blocks: [[14, first.length, 2, 0], [3, second.length, 2, 31]],
    data, nodes: [['a.resS', 0, 14], ['b.resS', 14, 3]],
  }));
  assert.equal(facts.formatVersion, 9);
  // 元数据块未压缩（头部 codec=0），但数据块自身标 LZ4，两件事分开。
  assert.equal(facts.blocksInfo.atEnd, true);
  assert.equal(facts.blocksInfo.compression, 'none');
  assert.deepEqual(facts.blocks.compression, ['lz4']);
  assert.deepEqual(facts.blocks.items.map(({ offset, compressedSize }) => ({ offset, compressedSize })), [
    { offset: 0, compressedSize: first.length },
    { offset: 31, compressedSize: second.length },
  ]);
  assert.equal(facts.payload.status, 'parsed');
  // 尾置表布局下偏移仍以数据区起点为基准；第 2 块跨过 16 字节填充取到自己的 LZ4 流。
  assert.deepEqual(facts.payload.nodes.map(node => node.sha256), [
    createHash('sha256').update('guoluo-v9-lz4!').digest('hex'),
    createHash('sha256').update('zhu').digest('hex'),
  ]);
});

test('Unity 官方 v9 样本：块偏移来自块表，块间填充为零', { skip: !process.env.GUOLUO_TEST_UNITY_V9 && '设置 GUOLUO_TEST_UNITY_V9 指向 Unity 官方 v9 样本后才执行：v9「已核对」的外部锚点来自这条用例', }, async () => {
  const path = process.env.GUOLUO_TEST_UNITY_V9;
  const bytes = await readFile(path);
  assert.equal(bytes.length, 362352);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), 'fb116ff6e0e455d2d063dc6f71d05ffa3bf4b6d914c87918bfacd246d6c3b22a');
  const facts = await inspectUnityHeader(path, bytes.length, 'unity-bundle');
  assert.equal(facts.formatVersion, 9);
  assert.equal(facts.unityRevision, '6000.7.0b2');
  assert.equal(facts.blocksInfo.compression, 'lz4hc');
  assert.equal(facts.blocks.count, 11);
  const blocks = facts.blocks.items;
  assert.deepEqual(blocks.map(({ offset }) => offset), [0, 6352, 136624, 221360, 264880, 296080, 312048, 348976, 349312, 355344, 356032]);
  // 记录偏移相对数据区；将其加到 dataStart 后核对物理字节，且确实存在填充（否则累加也能过）。
  let padding = 0;
  for (let index = 1; index < blocks.length; index += 1) {
    const previousEnd = blocks[index - 1].offset + blocks[index - 1].compressedSize;
    assert.ok(blocks[index].offset >= previousEnd, `第 ${index} 块与前一块重叠`);
    const gap = bytes.subarray(facts.dataStart + previousEnd, facts.dataStart + blocks[index].offset);
    assert.ok(gap.every(byte => byte === 0), `第 ${index} 块前的填充不是零字节`);
    padding += gap.length;
  }
  assert.equal(padding, 80);
  assert.equal(facts.dataStart, 288);
  assert.deepEqual(facts.nodes.items.map(({ path: nodePath, size }) => ({ path: nodePath, size })), [
    { path: 'BuildPlayer-Scene1.sharedAssets', size: 761460 },
    { path: 'BuildPlayer-Scene1', size: 17508 },
    { path: 'BuildPlayer-Scene2.sharedAssets', size: 1413 },
    { path: 'BuildPlayer-Scene2', size: 17508 },
  ]);
  assert.equal(facts.payload.status, 'parsed');
  assert.equal(facts.payload.nodes.length, 4);
  // UnityDataTool 2.3.0 独立解出的四个节点指纹，逐项对齐。
  assert.deepEqual(facts.payload.nodes.map(({ path: nodePath, sha256 }) => ({ path: nodePath, sha256 })), [
    { path: 'BuildPlayer-Scene1.sharedAssets', sha256: '903228b4c44c540c9480d871223edde4049957390532eb39c8f0b2b6058dfa72' },
    { path: 'BuildPlayer-Scene1', sha256: '6cb03b57ba3f6667c18eca8625d227d7a376c38d26cb135055dd1abc0f7512ba' },
    { path: 'BuildPlayer-Scene2.sharedAssets', sha256: '5b8c30385c93aeaf34107ba5f223727b1bb168af4bd40b344da29a323e202c13' },
    { path: 'BuildPlayer-Scene2', sha256: '5229c0310ec19ef66b1e192003fb5dbe28bd1ca7d4680b058a2e6bfcd586f24e' },
  ]);
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

test('UnityFS 读取合法尾置表并拒绝与尾置表范围冲突的声明包长', async () => {
  const dir = await scratch();
  const options = { atEnd: true, nodes: [['tail.resS', 0, 4]] };
  const bytes = unityfs(options);
  const parsed = await inspectFixture(dir, 'tail.bundle', bytes);
  assert.equal(parsed.declaredSize, String(bytes.length));
  assert.equal(parsed.blocksInfo.atEnd, true);
  assert.deepEqual(parsed.nodes.items, [{ index: 0, path: 'tail.resS', offset: 0, size: 4, flags: 4 }]);
  await assert.rejects(
    inspectFixture(dir, 'tail-overlap.bundle', unityfs({ ...options, declaredSize: bytes.length - 5 })),
    /元数据块范围越界/u,
  );
  await assert.rejects(
    inspectFixture(dir, 'tail-past-eof.bundle', unityfs({ ...options, declaredSize: bytes.length + 1 })),
    /包长越界/u,
  );
});

test('UnityFS 在按 codec 跳过表之前拒绝对齐后的负数据区', async () => {
  const dir = await scratch();
  const options = { version: 6, atEnd: true, padStart: true, codec: 2, blocks: [], data: Buffer.alloc(0) };
  const bytes = unityfs(options);
  await assert.rejects(inspectFixture(dir, 'tail-padding.bundle', unityfs({ ...options, declaredSize: bytes.length - 1 })), /数据区长度无效/u);
});

test('IL2CPP 只对已核对布局的版本读字段表，其余版本只报头', async () => {
  const dir = await scratch();
  // v24：264 字节头 + 32 段全零区段表，各段长度 0，应当解析成空表而不是报错。
  const empty = il2cpp(24, 264);
  const parsed = await inspectFixture(dir, 'v24-empty.dat', empty, 'il2cpp-metadata');
  assert.equal(parsed.status, 'parsed');
  assert.equal(parsed.layout, 'verified');
  assert.deepEqual(parsed.counts, { types: 0, fields: 0, methods: 0, images: 0, stringLiterals: 0 });
  assert.deepEqual(parsed.types, []);

  for (const version of [16, 27, 29, 31, 32]) {
    const facts = await inspectFixture(dir, `v${version}.dat`, il2cpp(version, 256), 'il2cpp-metadata');
    assert.equal(facts.status, 'unverified');
    assert.equal(facts.layout, 'unverified');
    assert.equal(facts.metadataVersion, version);
    assert.match(facts.reason, /尚未核对/u);
  }

  await assert.rejects(inspectFixture(dir, 'short-header.dat', il2cpp(24, 264, 200), 'il2cpp-metadata'), /短于 32 段的头长|头不完整/u);
  const overrun = il2cpp(24, 264);
  overrun.writeUInt32LE(8000, 8 + 19 * 8 + 4);
  await assert.rejects(inspectFixture(dir, 'overrun.dat', overrun, 'il2cpp-metadata'), /区段 typeDefinitions 越界/u);
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

  // A v10 header with an intentionally incomplete table must not trigger table parsing.
  const futureFacts = await inspectFixture(dir, 'future.bundle', unityfs({ version: 10, blockCount: 2 }));
  assert.equal(futureFacts.format, 'unityfs');
  assert.equal(futureFacts.formatVersion, 10);
  assert.equal(futureFacts.tableLayout, 'unverified');
  assert.equal(futureFacts.blocksInfo.status, 'unsupported');
  assert.equal(futureFacts.blocks, null);
  assert.equal(futureFacts.nodes, null);
  assert.equal(futureFacts.payload.status, 'skipped');

  // 同一份内容声明为 v8 时块表照常解析，说明拒绝只针对未核对的版本。
  const supported = unityfs({ version: 8 });
  await writeFile(join(dir, 'supported.bundle'), supported);
  const supportedFacts = await inspectUnityHeader(join(dir, 'supported.bundle'), supported.length, 'unity-bundle');
  assert.equal(supportedFacts.tableLayout, 'verified');
  assert.equal(supportedFacts.blocksInfo.status, 'parsed');

  // 头声明 6、但没有版本字符串终止符：既不能猜也不能越界读
  const truncated = Buffer.alloc(64);
  truncated.fill(0x41, 0);
  truncated.write('UnityFS\0', 0, 'latin1');
  truncated.writeUInt32BE(6, 8);
  await writeFile(join(dir, 'truncated.bundle'), truncated);
  await assert.rejects(inspectUnityHeader(join(dir, 'truncated.bundle'), truncated.length, 'unity-bundle'), /版本字符串缺终止符/u);

  const notIl2cpp = Buffer.from('notil2cpp', 'latin1');
  await writeFile(join(dir, 'global-metadata.dat'), notIl2cpp);
  await assert.rejects(inspectUnityHeader(join(dir, 'global-metadata.dat'), notIl2cpp.length, 'il2cpp-metadata'), /头标识无效|头不完整/u);

  const shortMetadata = Buffer.from([0xaf, 0x1b]);
  await writeFile(join(dir, 'short.dat'), shortMetadata);
  await assert.rejects(inspectUnityHeader(join(dir, 'short.dat'), shortMetadata.length, 'il2cpp-metadata'), /头不完整|头标识无效/u);

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
  const metadata = il2cpp(29, 272);
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
  const { sha256: bundleSha, ...bundleRest } = rows.find(row => row.path === 'assets/desktop.bundle');
  assert.match(bundleSha, /^[0-9a-f]{64}$/u);
  assert.deepEqual(bundleRest, { kind: 'asset', path: 'assets/desktop.bundle', type: 'unity-bundle', bytes: 156 });
  const { sha256: metadataSha, ...metadataRest } = rows.find(row => row.path === 'global-metadata.dat');
  assert.match(metadataSha, /^[0-9a-f]{64}$/u);
  assert.deepEqual(metadataRest, { kind: 'asset', path: 'global-metadata.dat', type: 'il2cpp-metadata', bytes: metadata.length });
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
  assert.equal(second.rows[0].status, 'unverified');
  assert.equal(second.rows[0].layout, 'unverified');
  assert.equal(second.rows[0].declaredHeaderBytes, 272);
  assert.equal(second.nextOffset, null);

  const spec = await service.spec({ id: added.id, runId: run.runId });
  const markdown = await readFile(spec.files.markdown, 'utf8');
  assert.match(markdown, /Unity assets\/desktop\.bundle \| UnityFS 6 \/ 2021\.3\.16f1/u);
  assert.match(markdown, /Unity global-metadata\.dat \| IL2CPP 29 \/ IL2CPP 元数据版本 29 的类型与字段表布局尚未核对/u);
  const json = JSON.parse(await readFile(spec.files.json, 'utf8'));
  assert.equal(json.evidence.unity.length, 2);
  assert.equal(json.evidence.unity.find(file => file.path === 'global-metadata.dat').layout, 'unverified');
  assert.match(markdown, /UnityFS 节点 1 \/ 块 1/u);
  assert.ok(json.unknowns.some(text => text.includes('LZHAM 压缩与 UnityFS 格式版本 10')));
  assert.ok(json.unknowns.some(text => text.includes('只记录了头部') && text.includes('尚未核对')));

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
  assert.equal(unknown.status, 'unverified');
  assert.match(unknown.reason, /版本 32 的类型与字段表布局尚未核对/u);
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