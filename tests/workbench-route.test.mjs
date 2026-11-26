import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { apply } from '../index.js';

// 假的宿主上下文：只实现本项目真正用到的几个面（工具注册、槽位以外什么也不做）。
// 这样测的是 index.js 里那条真实路由与真实工具，不是另写一份桩。
function fakeHost() {
  const tools = new Map();
  const routes = [];
  const disposers = [];
  const ctx = {
    effect: (fn) => { disposers.push(fn()); return () => {}; },
    tools: { register: (tool) => { tools.set(tool.name, tool); return () => tools.delete(tool.name); } },
    commands: { register: () => () => {} },
    skills: { register: () => () => {} },
    get: (key) => {
      if (key === 'webServer') {
        return { getOrigin: () => 'http://127.0.0.1:1', register: (route) => { routes.push(route); return () => {}; } };
      }
      return undefined;
    },
  };
  return { ctx, tools, routes };
}

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'guoluo-route-'));
  const source = join(dir, 'source');
  const archive = join(dir, 'archive');
  for (const path of [join(source, 'site'), archive]) await mkdir(path, { recursive: true });
  await writeFile(join(source, 'site', 'index.html'), '<h1 id="hero">蜾蠃</h1>');
  await writeFile(join(source, 'site', 'app.css'), ':root{--accent:#112233}');
  const host = fakeHost();
  apply(host.ctx, { sourceRoot: source, archiveRoot: archive });
  return { dir, host, source, archive };
}

function call(route, url, { method = 'GET', headers = {}, body = null, contentType = 'application/json' } = {}) {
  const res = {
    statusCode: 0, headers: null, text: null,
    writeHead(code, head) { this.statusCode = code; this.headers = head; },
    end(text) { this.text = text ?? null; },
  };
  // 请求体用真的流事件驱动 readJsonBody，而不是直接塞一个对象：
  // 这样测的是「读体 + 判 content-type + 判大小」的那段真实代码。
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { host: '127.0.0.1:1', ...(body === null ? {} : { 'content-type': contentType }), ...headers };
  req.destroy = () => {};
  const done = route.handler(req, res)
    .then(() => ({ status: res.statusCode, headers: res.headers, json: res.text ? JSON.parse(res.text) : null }));
  setImmediate(() => {
    if (body !== null) req.emit('data', Buffer.from(body));
    req.emit('end');
  });
  return done;
}

test('工作台接口：只读索引页说清有哪些端点', async () => {
  const { dir, host } = await scratch();
  try {
    assert.equal(host.routes.length, 1);
    const route = host.routes[0];
    assert.equal(route.kind, 'prefix');
    assert.equal(route.path, '/api/guoluo');
    const res = await call(route, '/api/guoluo');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.service, 'guoluo');
    assert.deepEqual(res.json.endpoints, ['overview', 'project?id=', 'evidence?id=&runId=&kind=&offset=&limit=', 'verdict（POST：id, decision, note?）']);
    assert.match(res.json.note, /只读投影/u);
    assert.match(res.json.note, /POST \/verdict/u);
    assert.equal(res.headers['cache-control'], 'no-store');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('工作台接口：overview 与工具同源，登记盘点后 project 报 dissected', async () => {
  const { dir, host } = await scratch();
  try {
    const route = host.routes[0];
    const empty = await call(route, '/api/guoluo/overview');
    assert.equal(empty.status, 200);
    assert.equal(empty.json.status, 'ready');
    assert.equal(empty.json.total, 0);

    const tool = (name, args) => host.tools.get(`guoluo_${name}`).execute(args, { signal: AbortSignal.timeout(15000) });
    const toolOverview = await tool('workbench', { view: 'overview' });
    assert.equal(toolOverview.ok, true);
    assert.equal(toolOverview.service, 'guoluo');

    const { id } = await tool('target_add', { kind: 'local', location: 'site' });
    await tool('dissect', { id, rea: false });

    const overview = await call(route, '/api/guoluo/overview');
    assert.equal(overview.json.total, 1);
    assert.equal(overview.json.projects[0].stage, 'dissected');
    assert.equal(overview.json.counts.dissected, 1);

    const detail = await call(route, `/api/guoluo/project?id=${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.json.project.stage, 'dissected');
    assert.equal(detail.json.latestRun.totals.asset, 2);
    assert.ok(detail.json.next.length > 0);

    const rows = await call(route, `/api/guoluo/evidence?id=${id}&kind=asset&limit=1`);
    assert.equal(rows.status, 200);
    assert.equal(rows.json.returned, 1);
    assert.equal(rows.json.total, 2);
    assert.equal(rows.json.nextOffset, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('工作台接口：非 GET 给 405 并带 Allow，跨来源给 403，入参错给 400', async () => {
  const { dir, host } = await scratch();
  try {
    const route = host.routes[0];
    const refused = await call(route, '/api/guoluo/overview', { method: 'POST' });
    assert.equal(refused.status, 405);
    assert.equal(refused.headers.allow, 'GET, HEAD');
    assert.equal(refused.json.ok, false);

    const foreign = await call(route, '/api/guoluo/overview', { headers: { origin: 'http://evil.test' } });
    assert.equal(foreign.status, 403);

    const missing = await call(route, '/api/guoluo/project');
    assert.equal(missing.status, 400);
    assert.match(missing.json.text, /请给出档案 ID/u);

    const malformed = await call(route, '/api/guoluo/project?id=nope');
    assert.equal(malformed.status, 400);
    assert.match(malformed.json.text, /档案 ID 格式错误/u);

    const unknown = await call(route, '/api/guoluo/nothing');
    assert.equal(unknown.status, 404);
    assert.match(unknown.json.text, /没有这个接口/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('工作台接口：POST /verdict 与 guoluo_verdict 同一条服务方法，接受后 stage 变 accepted', async t => {
  const { dir, host, source } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const route = host.routes[0];
  const tool = (name, args) => host.tools.get(`guoluo_${name}`).execute(args, { signal: AbortSignal.timeout(15000) });

  const { id } = await tool('target_add', { kind: 'local', location: 'site' });
  const run = await tool('dissect', { id, rea: false });
  await mkdir(join(source, 'site-copy'));
  await writeFile(join(source, 'site-copy', 'index.html'), '<h1 id="hero">蜾蠃</h1>');
  await writeFile(join(source, 'site-copy', 'app.css'), ':root{--accent:#112233}');
  await tool('check', { id, runId: run.runId, candidate: { directory: 'site-copy' } });

  const accepted = await call(route, '/api/guoluo/verdict', {
    method: 'POST',
    body: JSON.stringify({ id, decision: 'accepted', note: '' }),
  });
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.decision, 'accepted');
  assert.equal(accepted.json.project.stage, 'accepted');
  assert.equal(accepted.json.check.verdict, 'complete');

  const detail = await call(route, `/api/guoluo/project?id=${id}`);
  assert.equal(detail.json.project.verdict.decision, 'accepted');
  const overview = await call(route, '/api/guoluo/overview');
  assert.equal(overview.json.counts.accepted, 1);

  // 工具与按钮读的是同一份落盘结果。
  const viaTool = await tool('verdict', { id, decision: 'rejected', note: '再改一版' });
  assert.equal(viaTool.history, 2);
  const after = await call(route, `/api/guoluo/project?id=${id}`);
  assert.equal(after.json.project.verdict.decision, 'rejected');
  assert.equal(after.json.project.stage, 'checked');
});

test('工作台接口：POST /verdict 的入参错误分成 415、400，GET 给 405', async t => {
  const { dir, host } = await scratch();
  t.after(() => rm(dir, { recursive: true, force: true }));
  const route = host.routes[0];
  const wrongMethod = await call(route, '/api/guoluo/verdict');
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'POST');

  const wrongType = await call(route, '/api/guoluo/verdict', { method: 'POST', body: '{}', contentType: 'text/plain' });
  assert.equal(wrongType.status, 415);
  assert.match(wrongType.json.text, /application\/json/u);

  const broken = await call(route, '/api/guoluo/verdict', { method: 'POST', body: '{' });
  assert.equal(broken.status, 400);
  assert.match(broken.json.text, /合法 JSON/u);

  const noId = await call(route, '/api/guoluo/verdict', { method: 'POST', body: JSON.stringify({ decision: 'accepted' }) });
  assert.equal(noId.status, 400);
  assert.match(noId.json.text, /请给出档案 ID/u);
});