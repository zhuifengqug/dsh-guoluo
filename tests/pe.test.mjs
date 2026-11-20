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

function buildPe({ wide = true, importRva = RVA, exportRva = 0x10c0 } = {}) {
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
    buffer.writeUInt32LE(1, exp + 20);
    buffer.writeUInt32LE(1, exp + 24);
    buffer.writeUInt32LE(0x10e8, exp + 28);
    buffer.writeUInt32LE(0x10f0, exp + 32);
    buffer.writeUInt32LE(0x10f4, exp + 36);
    buffer.writeUInt32LE(RVA, off(0x10e8));
    buffer.writeUInt32LE(0x10f8, off(0x10f0));
    buffer.writeUInt16LE(0, off(0x10f4));
    buffer.write('DoThing', off(0x10f8), 'latin1');
  }
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
});
