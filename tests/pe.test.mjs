import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Config } from '../index.js';
import { parsePe } from '../lib/pe.mjs';
import { projectService } from '../lib/projects.mjs';

const RVA = 0x1000;
const RAW = 0x200;
const SECTION_SIZE = 0x400;
const off = rva => RAW + (rva - RVA);

function buildPe({
  wide = true,
  importRva = RVA,
  exportRva = 0x10c0,
  exportNames = ['DoThing'],
  exportOrdinals = [0],
  exportFunctions = 1,
  exportAddressRva = 0x10e8,
  exportNamesRva = 0x10f0,
  exportOrdinalsRva = 0x10f4,
  exportStringsRva = 0x10f8,
} = {}) {
  const optionalSize = wide ? 240 : 224;
  const directoryStart = wide ? 112 : 96;
  const directoryCountAt = directoryStart - 4;
  const sectionTable = 0x98 + optionalSize;
  const size = RAW + SECTION_SIZE;
  const buffer = Buffer.alloc(size);
  buffer.write('MZ', 0, 'latin1');
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x4550, 0x80);
  buffer.writeUInt16LE(wide ? 0x8664 : 0x14c, 0x84);
  buffer.writeUInt16LE(1, 0x86);
  buffer.writeUInt32LE(0x5f000000, 0x88);
  buffer.writeUInt16LE(optionalSize, 0x94);
  const opt = 0x98;
  buffer.writeUInt16LE(wide ? 0x20b : 0x10b, opt);
  buffer.writeUInt32LE(RVA, opt + 16);
  if (wide) buffer.writeBigUInt64LE(0x140000000n, opt + 24);
  else buffer.writeUInt32LE(0x400000, opt + 28);
  buffer.writeUInt32LE(0x200, opt + 60);
  buffer.writeUInt16LE(3, opt + 68);
  buffer.writeUInt32LE(16, opt + directoryCountAt);
  const writeDir = (index, rva, bytes) => {
    buffer.writeUInt32LE(rva, opt + directoryStart + index * 8);
    buffer.writeUInt32LE(bytes, opt + directoryStart + index * 8 + 4);
  };
  writeDir(0, exportRva, 40);
  writeDir(1, importRva, 40);
  writeDir(14, 0x1130, 72);
  const inside = rva => rva >= RVA && rva + 64 < RVA + SECTION_SIZE;
  buffer.write('.text', sectionTable, 'latin1');
  buffer.writeUInt32LE(SECTION_SIZE, sectionTable + 8);
  buffer.writeUInt32LE(RVA, sectionTable + 12);
  buffer.writeUInt32LE(SECTION_SIZE, sectionTable + 16);
  buffer.writeUInt32LE(RAW, sectionTable + 20);
  buffer.writeUInt32LE(0x60000020, sectionTable + 36);
  if (inside(RVA)) {
    buffer.writeUInt32LE(0x1040, off(RVA));
    buffer.writeUInt32LE(0x1060, off(RVA) + 12);
    buffer.writeUInt32LE(0x1040, off(RVA) + 16);
    const wideThunk = wide;
    const thunk = off(0x1040);
    if (wideThunk) {
      buffer.writeBigUInt64LE(0x1080n, thunk);
      buffer.writeBigUInt64LE(0x8000000000000003n, thunk + 8);
    } else {
      buffer.writeUInt32LE(0x1080, thunk);
      buffer.writeUInt32LE(0x80000003, thunk + 4);
    }
    buffer.write('DEMO.dll', off(0x1060), 'latin1');
    buffer.writeUInt16LE(0, off(0x1080));
    buffer.write('CreateThing', off(0x1080) + 2, 'latin1');
  }
  if (inside(exportRva)) {
    const exp = off(exportRva);
    buffer.writeUInt32LE(1, exp + 16);
    buffer.writeUInt32LE(exportFunctions, exp + 20);
    buffer.writeUInt32LE(exportNames.length, exp + 24);
    buffer.writeUInt32LE(exportAddressRva, exp + 28);
    buffer.writeUInt32LE(exportNamesRva, exp + 32);
    buffer.writeUInt32LE(exportOrdinalsRva, exp + 36);
    if (off(exportAddressRva) + exportFunctions * 4 <= size) {
      for (let i = 0; i < Math.min(exportFunctions, 4); i++) buffer.writeUInt32LE(RVA, off(exportAddressRva) + i * 4);
    }
    exportNames.forEach((name, index) => {
      buffer.writeUInt32LE(exportStringsRva + index * 16, off(exportNamesRva) + index * 4);
      buffer.write(name, off(exportStringsRva + index * 16), 'latin1');
    });
    exportOrdinals.forEach((ordinal, index) => buffer.writeUInt16LE(ordinal, off(exportOrdinalsRva) + index * 2));
  }
  return buffer;
}

// 两节在文件里 raw 区间重叠：.text 的 raw 0x200–0xa00 盖住 .data 的 0x600–0x800。
function buildOverlapPe({ importRva = 0x1000 } = {}) {
  const optionalSize = 240;
  const directoryStart = 112;
  const sectionTable = 0x98 + optionalSize; // 0x188
  const headersSize = 0x200;
  const size = headersSize + 0x800;
  const buffer = Buffer.alloc(size);
  buffer.write('MZ', 0, 'latin1');
  buffer.writeUInt32LE(0x80, 0x3c);
  buffer.writeUInt32LE(0x4550, 0x80);
  buffer.writeUInt16LE(0x8664, 0x84);
  buffer.writeUInt16LE(2, 0x86);
  buffer.writeUInt32LE(0x5f000000, 0x88);
  buffer.writeUInt16LE(optionalSize, 0x94);
  const opt = 0x98;
  buffer.writeUInt16LE(0x20b, opt);
  buffer.writeUInt32LE(0x1000, opt + 16);
  buffer.writeBigUInt64LE(0x140000000n, opt + 24);
  buffer.writeUInt32LE(headersSize, opt + 60);
  buffer.writeUInt16LE(3, opt + 68);
  buffer.writeUInt32LE(16, opt + directoryStart - 4);
  const writeDir = (index, rva, bytes) => {
    buffer.writeUInt32LE(rva, opt + directoryStart + index * 8);
    buffer.writeUInt32LE(bytes, opt + directoryStart + index * 8 + 4);
  };
  writeDir(0, 0x9000, 40);
  writeDir(1, importRva, 40);
  const section = (at, name, rva, virtualSize, rawOffset, rawSize) => {
    buffer.write(name, sectionTable + at, 'latin1');
    buffer.writeUInt32LE(virtualSize, sectionTable + at + 8);
    buffer.writeUInt32LE(rva, sectionTable + at + 12);
    buffer.writeUInt32LE(rawSize, sectionTable + at + 16);
    buffer.writeUInt32LE(rawOffset, sectionTable + at + 20);
    buffer.writeUInt32LE(0x60000020, sectionTable + at + 36);
  };
  section(0, '.text', 0x1000, 0x800, 0x200, 0x800);
  section(40, '.data', 0x2000, 0x200, 0x600, 0x200);
  if (importRva === 0x1000) {
    buffer.writeUInt32LE(0x1100, 0x200);
    buffer.writeUInt32LE(0x1300, 0x20c);
    buffer.writeUInt32LE(0x1100, 0x210);
    buffer.writeBigUInt64LE(0x8000000000000003n, 0x300);
  }
  // 名字从 raw 0x500 起一直是可打印字符，终止符只落在 0x600（下一节 raw 起点）之外。
  buffer.fill(0x58, 0x500, 0x600);
  return buffer;
}

async function temp(t, bytes) {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-pe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'app.exe');
  await writeFile(file, bytes);
  return { root, file };
}

test('PE32+ 解析出头部、节表、导入与导出', async t => {
  const { file } = await temp(t, buildPe());
  const facts = await parsePe(file, new AbortController().signal);
  assert.equal(facts.format, 'pe32+');
  assert.equal(facts.machine, 'x64');
  assert.equal(facts.subsystem, 'windows-cui');
  assert.equal(facts.entryPointRva, RVA);
  assert.equal(facts.sections.length, 1);
  assert.equal(facts.sections[0].name, '.text');
  assert.equal(facts.imports.status, 'parsed');
  assert.deepEqual(facts.imports.items[0].dll, 'DEMO.dll');
  assert.deepEqual(facts.imports.items[0].symbols, [{ name: 'CreateThing' }, { ordinal: 3 }]);
  assert.equal(facts.exports.status, 'parsed');
  assert.deepEqual(facts.exports.items, [{ name: 'DoThing', ordinal: 1 }]);
  assert.equal(facts.clr.declared, true);
});

test('PE32 读取 32 位导入表与序号位', async t => {
  const { file } = await temp(t, buildPe({ wide: false }));
  const facts = await parsePe(file, new AbortController().signal);
  assert.equal(facts.format, 'pe32');
  assert.equal(facts.machine, 'x86');
  assert.equal(facts.imageBase, '0x400000');
  assert.deepEqual(facts.imports.items[0].symbols, [{ name: 'CreateThing' }, { ordinal: 3 }]);
});

test('数据目录越界时标为不可读而不抛出', async t => {
  const { file } = await temp(t, buildPe({ importRva: 0x9000, exportRva: 0x9000 }));
  const facts = await parsePe(file, new AbortController().signal);
  assert.equal(facts.imports.status, 'unreadable');
  assert.match(facts.imports.reason, /PE/u);
  assert.equal(facts.exports.status, 'unreadable');
});

test('非 PE 与截断输入被拒绝', async t => {
  const bad = (await temp(t, Buffer.from('MZ but no NT header at all', 'latin1'))).file;
  await assert.rejects(parsePe(bad, new AbortController().signal), /PE 文件范围越界/u);
  const fake = (await temp(t, Buffer.concat([Buffer.alloc(64, 0x41), Buffer.from('tail', 'latin1')]))).file;
  await assert.rejects(parsePe(fake, new AbortController().signal), /PE DOS 头无效/u);
});

test('目录盘点把 PE 登记为二进制资产并写入规格与 mock 说明', async t => {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-pe-dir-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [sourceRoot, archiveRoot] = ['source', 'archive'].map(name => join(root, name));
  await Promise.all([mkdir(sourceRoot), mkdir(archiveRoot)]);
  await mkdir(join(sourceRoot, 'app'));
  await writeFile(join(sourceRoot, 'app/index.html'), '<!doctype html>\n<h1>Demo</h1>');
  await writeFile(join(sourceRoot, 'app/app.exe'), buildPe());
  const service = projectService(Config({ sourceRoot, archiveRoot, reaPath: join(root, 'missing.mjs') }));
  const target = await service.add({ kind: 'local', location: 'app' });
  const run = await service.dissect({ id: target.id, rea: false });
  const assets = await service.dossier({ id: target.id, kind: 'asset' });
  const exe = assets.rows.find(row => row.path === 'app.exe');
  assert.deepEqual(exe, { kind: 'asset', path: 'app.exe', type: 'executable', bytes: RAW + SECTION_SIZE, binary: 'pe' });
  const spec = await service.spec({ id: target.id, runId: run.runId });
  const specJson = JSON.parse(await readFile(spec.files.json, 'utf8'));
  const specMarkdown = await readFile(spec.files.markdown, 'utf8');
  assert.equal(specJson.evidence.pe.files[0].path, 'app.exe');
  assert.deepEqual(specJson.evidence.pe.files[0].dlls, ['DEMO.dll']);
  assert.ok(specJson.unknowns.some(line => /PE 只解析/u.test(line)));
  assert.match(specMarkdown, /原生二进制（PE，1）/u);
  assert.match(specMarkdown, /DEMO\.dll/u);
  const mock = await service.mock({ id: target.id, runId: run.runId });
  const mockConfig = JSON.parse(await readFile(mock.files.config, 'utf8'));
  assert.ok(mockConfig.unreplayed.some(item => item.value === 'app.exe' && /原生二进制/u.test(item.reason)));
  // 工具头部不夹带逐文件明细，明细走 dossier kind=binary 分页。
  assert.equal(run.pe.files, 1);
  assert.equal(run.pe.parsed, 1);
  assert.equal(run.pe.unreadable, 0);
  assert.equal(Array.isArray(run.pe), false);
  const binaryRows = await service.dossier({ id: target.id, kind: 'binary', limit: 10 });
  assert.equal(binaryRows.total, 1);
  assert.equal(binaryRows.rows[0].path, 'app.exe');
  assert.equal(binaryRows.rows[0].imports.items[0].dll, 'DEMO.dll');
});

test('PE 解析失败的尝试同样消耗名额并记录不可读条目', async t => {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-pe-budget-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [sourceRoot, archiveRoot] = ['source', 'archive'].map(name => join(root, name));
  await Promise.all([mkdir(sourceRoot), mkdir(archiveRoot)]);
  await mkdir(join(sourceRoot, 'bin'));
  for (let i = 0; i < 18; i += 1) {
    await writeFile(join(sourceRoot, `bin/bad${String(i).padStart(2, '0')}.dll`), Buffer.from('MZ broken header', 'latin1'));
  }
  const service = projectService(Config({ sourceRoot, archiveRoot, reaPath: join(root, 'missing.mjs') }));
  const target = await service.add({ kind: 'local', location: 'bin' });
  const run = await service.dissect({ id: target.id, rea: false });
  assert.equal(run.pe.files, 16);
  assert.equal(run.pe.parsed, 0);
  assert.equal(run.pe.unreadable, 16);
  assert.equal(run.coverage.clipped, true);
  const binaryRows = await service.dossier({ id: target.id, kind: 'binary', limit: 5 });
  assert.equal(binaryRows.total, 16);
  assert.ok(binaryRows.rows.every(row => row.status === 'unreadable' && typeof row.reason === 'string'));
});

test('变长扫描只在本节 raw 范围内找终止符，跨节重叠即报错', async t => {
  const signal = new AbortController().signal;
  const overlapped = await temp(t, buildOverlapPe());
  const facts = await parsePe(overlapped.file, signal);
  assert.equal(facts.sections.length, 2);
  assert.equal(facts.sections[1].name, '.data');
  assert.equal(facts.imports.status, 'unreadable');
  assert.match(facts.imports.reason, /唯一节范围内终止/u);

  // 目录起点本身落在另一节 raw 区间内：字节归属不唯一，同样拒绝。
  const mixed = await temp(t, buildOverlapPe({ importRva: 0x1500 }));
  const mixedFacts = await parsePe(mixed.file, signal);
  assert.equal(mixedFacts.imports.status, 'unreadable');
  assert.match(mixedFacts.imports.reason, /节数据在文件中重叠/u);
});

test('两个不同序号共用同一函数地址槽位是合法别名导出，仍按 parsed 返回', async t => {
  const file = await temp(t, buildPe({
    exportNames: ['AliasA', 'AliasB'],
    exportOrdinals: [0, 1],
    exportFunctions: 2,
    exportNamesRva: 0x10f0,
    exportOrdinalsRva: 0x10f8,
    exportStringsRva: 0x1100,
  }));
  const facts = await parsePe(file.file, new AbortController().signal);
  assert.equal(facts.exports.status, 'parsed');
  // 两个名字各占一个序号、指向同一槽位（buildPe 把两个槽位都写成同一 RVA）。
  assert.deepEqual(facts.exports.items.map(item => item.ordinal), [1, 2]);
  assert.equal(facts.exports.aliasSlots, 1);
});

test('导出函数地址槽位越界或序号表重复序号时标记 unreadable', async t => {
  const signal = new AbortController().signal;
  // 损坏的证据必须是序号表里重复的序号值本身，而不是“两个名字共用同一地址”。
  const duplicate = await temp(t, buildPe({
    exportNames: ['A', 'B'],
    exportOrdinals: [0, 0],
    exportFunctions: 1,
    exportNamesRva: 0x10f0,
    exportOrdinalsRva: 0x10f8,
    exportStringsRva: 0x1100,
  }));
  const duplicateFacts = await parsePe(duplicate.file, signal);
  assert.equal(duplicateFacts.exports.status, 'unreadable');
  assert.match(duplicateFacts.exports.reason, /序号表出现重复序号/u);
  assert.equal(duplicateFacts.imports.status, 'parsed');

  const oversized = await temp(t, buildPe({ exportFunctions: 0x200 }));
  const oversizedFacts = await parsePe(oversized.file, signal);
  assert.equal(oversizedFacts.exports.status, 'unreadable');
  assert.match(oversizedFacts.exports.reason, /范围越界/u);

  const missing = await temp(t, buildPe({ exportAddressRva: 0x9000 }));
  const missingFacts = await parsePe(missing.file, signal);
  assert.equal(missingFacts.exports.status, 'unreadable');
  assert.match(missingFacts.exports.reason, /唯一的文件字节范围|范围越界/u);
});

test('导出序号超出函数槽位数量时标记 unreadable', async t => {
  const file = await temp(t, buildPe({ exportNames: ['A'], exportOrdinals: [1], exportFunctions: 1 }));
  const facts = await parsePe(file.file, new AbortController().signal);
  assert.equal(facts.exports.status, 'unreadable');
  assert.match(facts.exports.reason, /导出序号越界/u);
});
