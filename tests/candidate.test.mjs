import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { projectService } from '../lib/projects.mjs';
import { checkCandidate } from '../lib/check.mjs';

const html = `<!doctype html><html><head><link rel="stylesheet" href="app.css"></head><body><img src="hero.png"><a href="/docs">docs</a></body></html>`;
const css = `:root{--accent:#112233;--gap:8px}\nbody{color:var(--accent)}`;

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-candidate-'));
  const source = join(dir, 'source');
  const archive = join(dir, 'archive');
  for (const path of [join(source, 'site'), join(source, 'copy'), join(source, 'empty'), archive]) await mkdir(path, { recursive: true });
  await writeFile(join(source, 'site', 'index.html'), html);
  await writeFile(join(source, 'site', 'app.css'), css);
  await writeFile(join(source, 'site', 'hero.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  // 候选：落了一个页面、一个样式（只有一个令牌）、漏了图片，还多出一个没被声明的文件。
  await writeFile(join(source, 'copy', 'index.html'), html);
  await writeFile(join(source, 'copy', 'app.css'), ':root{--accent:#112233}\n');
  await writeFile(join(source, 'copy', 'extra.txt'), 'not declared\n');
  const service = projectService({ sourceRoot: source, archiveRoot: archive });
  const { id } = await service.add({ kind: 'local', location: 'site' });
  const { runId } = await service.dissect({ id, rea: false });
  return { dir, id, runId, service, source };
}

test('候选覆盖度：找到素材、页面与已声明令牌，缺的逐项列出', async () => {
  const { dir, id, runId, service } = await scratch();
  try {
    const result = await service.check({ id, runId, candidate: { directory: 'copy' } });
    const coverage = result.candidate;
    assert.equal(coverage.scope, 'candidate-coverage');
    assert.equal(coverage.verdict, 'partial');
    assert.equal(coverage.directory, 'copy');
    assert.equal(coverage.clipped, false);
    assert.deepEqual(coverage.assets.present.map(item => item.target), ['app.css', 'index.html']);
    assert.deepEqual(coverage.assets.missing.map(item => item.target), ['hero.png']);
    assert.deepEqual(coverage.structures.missing, []);
    assert.deepEqual(coverage.tokens.declared.map(item => item.target), ['--accent']);
    assert.deepEqual(coverage.tokens.missing.map(item => item.target), ['--gap']);
    assert.match(coverage.note, /没有找到对应物/u);
    // 多出来的文件不制造虚假通过，也不进缺口清单。
    assert.equal(coverage.files.total, 3);
    assert.equal(coverage.unchecked.length, 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('候选覆盖度：空目录全缺，verdict 仍是 partial 而不是报错', async () => {
  const { dir, id, runId, service } = await scratch();
  try {
    const result = await service.check({ id, runId, candidate: { directory: 'empty' } });
    assert.equal(result.candidate.verdict, 'partial');
    assert.deepEqual(result.candidate.assets.present, []);
    assert.deepEqual(result.candidate.tokens.declared, []);
    assert.equal(result.candidate.assets.missing.length + result.candidate.structures.missing.length + result.candidate.tokens.missing.length > 0, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('候选覆盖度：越出素材根或指向文件时判为输入错误，不落到环境失败', async () => {
  const { dir, id, runId, service } = await scratch();
  try {
    for (const directory of ['../escape', 'copy/index.html']) {
      const result = await service.check({ id, runId, candidate: { directory } });
      assert.equal(result.candidate.verdict, 'blocked');
      assert.equal(result.candidate.kind, 'invalid-input');
      assert.equal(result.candidate.scope, 'candidate-coverage');
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('候选覆盖度：归档成员不算缺失，标成归档来源', async () => {
  const run = {
    rows: [
      { kind: 'asset', path: 'res/icon.png', type: 'image', bytes: 4, archive: 'apk' },
      { kind: 'asset', path: 'hero.png', type: 'image', bytes: 8 },
    ],
  };
  const spec = { obligations: [
    { id: 'A-01', kind: 'asset', target: 'res/icon.png', requires: '', status: 'declared', evidence: [{ path: 'res/icon.png' }] },
    { id: 'A-02', kind: 'asset', target: 'hero.png', requires: '', status: 'declared', evidence: [{ path: 'hero.png' }] },
  ] };
  const result = checkCandidate({ spec, run, files: [{ path: 'hero.png', size: 8 }], css: [] });
  assert.deepEqual(result.assets.archived, [{ id: 'A-01', target: 'res/icon.png', archive: 'apk' }]);
  assert.deepEqual(result.assets.present.map(item => item.id), ['A-02']);
  assert.deepEqual(result.assets.missing, []);
});
