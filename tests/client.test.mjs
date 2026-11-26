import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

// client.js 不是 ESM：宿主用 __ModuleLoader__ 收它。这里复刻那一层，
// 用假 React 的 createElement/hooks 把组件函数真跑一遍——验的是注册面与渲染结果，
// 不是「文件里有没有这段文本」。
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');

function fakeReact(seed = []) {
  const pending = [...seed];
  const createElement = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() });
  return {
    Fragment: Symbol('Fragment'),
    createElement,
    // 组件是按顺序调 hook 的：seed 里的值依次交给 useState，其余给初值。
    useState: (initial) => [pending.length ? pending.shift() : (typeof initial === 'function' ? initial() : initial), () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
  };
}

function load(React = fakeReact()) {
  let captured = null;
  const sandbox = {
    window: { __ModuleLoader__: { load: (mod) => { captured = mod; } } },
    console, URLSearchParams, JSON, String, Object, Array, Math, Error, Number,
  };
  sandbox.fetch = async () => { throw new Error('测试不该发请求'); };
  vm.runInNewContext(source, sandbox, { filename: 'client.js' });
  assert.ok(captured, 'client.js 没有调用 __ModuleLoader__.load');
  const caught = [];
  const api = captured.factory((name) => {
    caught.push(name);
    if (name !== 'react') throw new Error(`client bundle 只该从宿主拿 react，实际取了 ${name}`);
    return React;
  });
  return { mod: captured, api, caught, React };
}

function slots() {
  const injected = [];
  const registered = [];
  return {
    injected, registered,
    inject: (key, make) => { injected.push(key); make(); },
    register: (descriptor, component) => { registered.push({ descriptor, component }); return () => {}; },
  };
}

const byName = (target, name) => target.registered.find((entry) => entry.descriptor?.name === name);

function textOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { for (const child of node) textOf(child, out); return out; }
  for (const child of node.children ?? []) textOf(child, out);
  return out;
}

test('client 半端：只从宿主取 react，注册 main 与侧栏两处入口', () => {
  const { mod, api, caught } = load();
  assert.equal(mod.id, '@zhuifengqug/dsh-guoluo');
  // inject 是 vm 里那个 realm 的数组，展开到本 realm 再比，避免原型不同导致的假失败。
  assert.deepEqual([...api.inject], ['slots']);

  const target = slots();
  api.apply({ get: (key) => (key === 'slots' ? target : undefined), slots: target, effect: () => {} });

  assert.deepEqual(caught, ['react']);
  assert.deepEqual(target.injected, ['main', 'sidebar.panellist']);

  const main = byName(target, 'main');
  assert.equal(main.descriptor.key, 'guoluo');
  assert.equal(main.descriptor.label, '复刻工作台');
  assert.equal(typeof main.component, 'function');

  const side = byName(target, 'sidebar.panellist');
  assert.equal(side.descriptor.id, 'guoluo');
  assert.equal(side.descriptor.order, 90);
  assert.equal(side.descriptor.label, '复刻工作台');
});

test('client 半端：主区渲染出标题与只读口径，空档案给的是下一步', () => {
  const React = fakeReact([{ status: 'ready', version: 'test', total: 0, projects: [], counts: { registered: 0 } }]);
  const { api } = load(React);
  const target = slots();
  api.apply({ get: () => target, slots: target, effect: () => {} });

  const panel = byName(target, 'main').component({});
  const text = textOf(panel).join(' ');
  assert.match(text, /复刻工作台/u);
  assert.match(text, /vtest/u);
  assert.match(text, /还没有档案/u);
  assert.match(text, /guoluo_target_add/u);
  assert.match(text, /只读投影/u);
});

test('client 半端：未配置目录时把原因原样显示，不假装空列表', () => {
  const React = fakeReact([{ status: 'unconfigured', reason: '素材根不可用。', note: '先在蜾蠃设置里填。', projects: [] }]);
  const { api } = load(React);
  const target = slots();
  api.apply({ get: () => target, slots: target, effect: () => {} });
  const text = textOf(byName(target, 'main').component({})).join(' ');
  assert.match(text, /素材根不可用/u);
  assert.match(text, /先在蜾蠃设置里填/u);
  assert.doesNotMatch(text, /还没有档案/u);
});

test('client 半端：侧栏入口是一枚 svg 图标，带可读名字', () => {
  const { api } = load();
  const target = slots();
  api.apply({ get: () => target, slots: target, effect: () => {} });
  const icon = byName(target, 'sidebar.panellist').component({});
  assert.equal(icon.props['aria-label'], '复刻工作台');
  assert.equal(icon.children[0].type, 'svg');
  assert.equal(icon.children[0].props['aria-hidden'], 'true');
});

test('client 半端：effect 清理按逆序撤掉两处注册', () => {
  const { api } = load();
  const disposed = [];
  let counter = 0;
  const target = { inject: (_key, make) => { make(); }, register: () => { const n = ++counter; return () => disposed.push(n); } };
  let cleanup = null;
  api.apply({ get: () => target, slots: target, effect: (fn) => { cleanup = fn(); } });
  assert.equal(typeof cleanup, 'function');
  cleanup();
  assert.deepEqual(disposed, [2, 1]);
});

test('client 半端：拿不到 slots 就安静退出，不抛', () => {
  const { api } = load();
  assert.doesNotThrow(() => api.apply({ get: () => undefined, effect: () => {} }));
});

test('client 半端：样式只用宿主主题变量，不带字面色值', () => {
  const allowed = new Set(['--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2', '--dsw-alias-bg-overlay',
    '--dsw-alias-border-l1', '--dsw-alias-border-l2', '--dsw-alias-brand-primary', '--dsw-alias-label-primary',
    '--dsw-alias-label-secondary', '--dsw-alias-state-error-primary', '--dsw-alias-state-idle-primary',
    '--dsw-alias-state-success-primary', '--dsw-alias-state-warn-primary', '--dsw-specific-sidebar-fill']);
  const used = [...source.matchAll(/var\((--[a-z0-9-]+)\)/gu)].map((match) => match[1]);
  assert.ok(used.length > 10, '样式里应当大量使用主题变量');
  assert.deepEqual(used.filter((token) => !allowed.has(token)), []);
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/u, '样式里不该出现字面色值');
  assert.doesNotMatch(source, /rgba?\(/u, '样式里不该出现 rgb()/rgba()');
});

test('client 半端：不越界——不引宿主客户端包、不写 document.body、不塞 iframe、无 import', () => {
  assert.doesNotMatch(source, /@deepseek-ai\//u);
  assert.doesNotMatch(source, /document\.body/u);
  assert.doesNotMatch(source, /createElement\(\s*['"]iframe['"]/u);
  assert.doesNotMatch(source, /^\s*import\s/mu, 'client bundle 不是 ESM，不该有 import');
});