import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Config } from '../index.js';
import { projectService } from '../lib/projects.mjs';
import { planScaffold } from '../lib/scaffold.mjs';
import { collectTokens } from '../lib/tokens.mjs';
import { buildSpec } from '../lib/spec.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'guoluo-scaffold-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [sourceRoot, archiveRoot] = ['source', 'archive'].map(name => join(root, name));
  await Promise.all([mkdir(sourceRoot), mkdir(archiveRoot)]);
  const service = projectService(Config({ sourceRoot, archiveRoot, reaPath: join(root, 'missing.mjs') }));
  return { root, sourceRoot, archiveRoot, service };
}

async function site(t) {
  const context = await setup(t);
  const folder = join(context.sourceRoot, 'site');
  await mkdir(folder);
  await writeFile(join(folder, 'index.html'), '<!doctype html>\n<link rel="stylesheet" href="theme.css">\n<img src="hero.png">\n<style>:root{--inline:1px}</style>');
  await writeFile(join(folder, 'theme.css'), ':root {\n  --accent: #08e;\n  --data: "a,b";\n}');
  await writeFile(join(folder, 'badge.png'), Buffer.from([1, 2, 3]));
  await writeFile(join(folder, 'hero.png'), Buffer.from([4, 5, 6, 7]));
  const target = await context.service.add({ kind: 'local', location: 'site' });
  const run = await context.service.dissect({ id: target.id });
  return { ...context, folder, id: target.id, run };
}

test('工程骨架逐字节复制素材，并按规格给出完整覆盖', async t => {
  const { id, run, service, archiveRoot, folder } = await site(t);
  const result = await service.scaffold({ id, name: 'first' });
  assert.equal(result.runId, run.runId);
  assert.equal(result.directory, `${id}/scaffold/first`);
  assert.equal(result.counts.copied, 4);
  assert.equal(result.counts.pages, 1);
  assert.equal(result.skippedCount, 0);
  assert.equal(result.coverage.verdict, 'complete');
  assert.equal(result.coverage.assets.missing, 0);
  assert.equal(result.coverage.tokens.missing, 0);
  assert.equal(result.coverage.values.differs, 0);
  for (const name of ['index.html', 'theme.css', 'badge.png', 'hero.png']) {
    const copied = await readFile(join(archiveRoot, id, 'scaffold/first', name));
    assert.deepEqual(copied, await readFile(join(folder, name)));
  }
  const manifest = JSON.parse(await readFile(join(archiveRoot, id, 'scaffold/first/_scaffold/scaffold.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.runId, run.runId);
  assert.equal(manifest.counts.copied, 4);
  assert.equal(manifest.files.length, 8);
  assert.ok(manifest.files.every(file => /^[0-9a-f]{64}$/u.test(file.sha256)));
  assert.ok(manifest.files.every(file => file.integrity === 'match' || file.integrity === 'generated'));
  assert.ok(!manifest.files.some(file => file.path.endsWith('.exe')));
  const index = await readFile(join(archiveRoot, id, 'scaffold/first/_scaffold/index.html'), 'utf8');
  assert.match(index, /href="\.\.\/index\.html"/u);
  assert.match(index, /href="tokens\.css"/u);
});

test('令牌表照抄证据里的声明，不被骨架改写', async t => {
  const { id, service, archiveRoot } = await site(t);
  await service.scaffold({ id, name: 'tokens' });
  const css = await readFile(join(archiveRoot, id, 'scaffold/tokens/_scaffold/tokens.css'), 'utf8');
  assert.match(css, /--accent:\s*#08e/u);
  assert.match(css, /--data:\s*"a,b"/u);
});

test('同名目录已存在时拒绝覆盖', async t => {
  const { id, service } = await site(t);
  await service.scaffold({ id, name: 'twice' });
  await assert.rejects(() => service.scaffold({ id, name: 'twice' }), /已有 scaffold\/twice/u);
});

test('跑一次后再跑别的名字不串味', async t => {
  const { id, service, archiveRoot } = await site(t);
  const first = await service.scaffold({ id, name: 'a' });
  const second = await service.scaffold({ id, name: 'b' });
  assert.equal(first.directory, `${id}/scaffold/a`);
  assert.equal(second.directory, `${id}/scaffold/b`);
  const left = await readFile(join(archiveRoot, id, 'scaffold/a/theme.css'), 'utf8');
  const right = await readFile(join(archiveRoot, id, 'scaffold/b/theme.css'), 'utf8');
  assert.equal(left, right);
});

test('盘点后源文件变过就不复制，覆盖度降为 partial', async t => {
  const { id, folder, service } = await site(t);
  await writeFile(join(folder, 'skip.exe'), Buffer.from('MZ'));
  await service.dissect({ id });
  await writeFile(join(folder, 'theme.css'), ':root{--accent:#000}');
  const result = await service.scaffold({ id, name: 'drift' });
  assert.equal(result.counts.copied, 3);
  assert.equal(result.skippedCount, 1);
  assert.match(result.skipped[0].reason, /内容指纹与档案不同/u);
  assert.equal(result.coverage.verdict, 'partial');
  // theme.css 没复制；skip.exe 是已盘点但不在复制类型里的素材，同样算未覆盖。
  assert.deepEqual(result.coverage.missing.sort(), ['skip.exe', 'theme.css']);
});

test('单文件素材不能当工程骨架', async t => {
  const { sourceRoot, service } = await site(t);
  await writeFile(join(sourceRoot, 'page.html'), '<!doctype html>');
  const { id } = await service.add({ kind: 'local', location: 'page.html' });
  await service.dissect({ id });
  await assert.rejects(() => service.scaffold({ id, name: 'single' }), /目录型素材/u);
});

test('素材里占了生成路径就拒绝，不写半截工程', async t => {
  const { id, folder, service, archiveRoot } = await site(t);
  await mkdir(join(folder, '_scaffold'));
  await writeFile(join(folder, '_scaffold/extra.css'), 'body{color:red}');
  await service.dissect({ id });
  await assert.rejects(() => service.scaffold({ id, name: 'conflict' }), /与生成路径冲突/u);
  await assert.rejects(() => readFile(join(archiveRoot, id, 'scaffold/conflict/README.md')), /ENOENT/u);
});

test('目录名非法时拒绝', async t => {
  const { id, service } = await site(t);
  await assert.rejects(() => service.scaffold({ id, name: '../escape' }), /目录名/u);
  await assert.rejects(() => service.scaffold({ id, name: '..' }), /目录名/u);
});

test('盘点时没取指纹的素材照样复制，但记成未核对', async t => {
  const body = Buffer.from('<h1>a</h1>');
  const run = {
    runId: '1700000000000-00000000-0000-0000-0000-000000000000',
    rows: [
      { kind: 'asset', path: 'big.bin', type: 'image', bytes: 3 },
      { kind: 'asset', path: 'note.html', type: 'page', bytes: body.length, sha256: createHash('sha256').update(body).digest('hex') },
    ],
  };
  const spec = buildSpec({ id: 'x', runId: run.runId, run, label: 'demo', createdAt: '2026-01-01T00:00:00.000Z' });
  const planned = await planScaffold({
    id: 'x', runId: run.runId, run, spec: spec.spec,
    collected: collectTokens(run.rows),
    source: 'site',
    read: async path => (path === 'note.html' ? body : Buffer.from('abc')),
  });
  assert.equal(planned.counts.copied, 2);
  assert.equal(planned.skipped.length, 0);
  const unrecorded = planned.files.find(file => file.path === 'big.bin');
  assert.equal(unrecorded.integrity, 'unrecorded');
  assert.equal(planned.files.find(file => file.path === 'note.html').integrity, 'match');
  assert.deepEqual(planned.warnings, ['big.bin 在盘点时未取内容指纹，复制的是当前字节，无法与档案比对。']);
});

test('清单先算后回填，自己的指纹不漏', async t => {
  const { id, run, service, archiveRoot } = await site(t);
  await service.scaffold({ id, name: 'seal' });
  const manifest = JSON.parse(await readFile(join(archiveRoot, id, 'scaffold/seal/_scaffold/scaffold.json'), 'utf8'));
  assert.equal(manifest.runId, run.runId);
  assert.deepEqual(manifest.policy.generated, ['_scaffold/index.html', '_scaffold/tokens.css', '_scaffold/tokens.tailwind.css', '_scaffold/scaffold.json', 'README.md']);
  assert.ok(manifest.files.every(file => !file.path.endsWith('scaffold.json')));
});

