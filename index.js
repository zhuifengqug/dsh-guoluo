import Schema from '@deepseek-ai/schemastery';
import { readFileSync } from 'node:fs';
import { projectService } from './lib/projects.mjs';
import { createWorkbench } from './lib/workbench.mjs';
import { checkTimeoutMs } from './lib/visual.mjs';

const { version: pluginVersion } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));

export const name = 'guoluo';
export const inject = ['tools', 'commands', 'skills', 'settings', 'webServer'];
const pathSetting = description => Schema.string().default('').description(description).extra('volatile', true);
export const Config = Schema.object({
  sourceRoot: pathSetting('素材根：已存在的本地素材目录（绝对路径）'),
  archiveRoot: pathSetting('档案根：单独的已存在输出目录（绝对路径）'),
  reaPath: pathSetting('REA 启动器绝对路径；留空则从 PATH 查找'),
  chromiumPath: pathSetting('视觉核对用 Chromium 可执行文件绝对路径；留空使用已安装的 Chrome'),
  reaTimeoutMs: Schema.number().default(180000).description('REA 自动分析超时（毫秒，10000–1800000）').extra('volatile', true),
}).description('虫珀·蜾蠃');

const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
const enumeration = (...values) => ({ type: 'string', enum: values });
const offset = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER };
const limit = { type: 'integer', minimum: 1, maximum: 50 };
const id = string(36);
const output = {
  schema: { type: 'object', properties: {}, additionalProperties: true },
  render: (_args, data) => [{ type: 'text', text: JSON.stringify(data) }],
};
const summary = '把本地 HTML/CSS、素材目录或 Electron ASAR 盘点成可追溯档案；按类别查看资产、CSS 变量和静态导航证据。';

// 工作台走浏览器里的同一条 HTTP 载体，所以响应必须是自带的 JSON：
// 状态码要说实话（400 是输入错、500 是环境错），否则面板会把故障当成功渲染。
const jsonHeaders = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function sendJson(res, status, body, extra = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...jsonHeaders, 'content-length': Buffer.byteLength(text), ...extra });
  res.end(text);
}

function queryNumber(url, key, fallback) {
  const raw = url.searchParams.get(key);
  if (raw === null || raw === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function isSameOrigin(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers?.host; } catch { return false; }
}

async function handleWorkbenchRequest({ req, res, workbench, ctx }) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendJson(res, 405, { ok: false, text: '工作台接口只读：只接受 GET。' }, { allow: 'GET, HEAD' });
    return;
  }
  if (!isSameOrigin(req)) { sendJson(res, 403, { ok: false, text: '不允许的来路。' }); return; }
  try {
    const rejected = typeof ctx.get === 'function' ? ctx.get('connection')?.requestRejection?.({ headers: req.headers }) : undefined;
    if (rejected) { sendJson(res, typeof rejected === 'number' ? rejected : 403, { ok: false, text: '不允许的来路。' }); return; }
  } catch { /* 没有 connection 服务就只靠同源判断 */ }

  const url = new URL(req.url ?? '/', 'http://localhost');
  const tail = url.pathname.replace(/^\/api\/guoluo/u, '').replace(/\/+$/u, '');
  try {
    if (!tail) {
      sendJson(res, 200, {
        ok: true, service: 'guoluo', version: pluginVersion,
        endpoints: ['overview', 'project?id=', 'evidence?id=&runId=&kind=&offset=&limit='],
        note: '只读投影：数据与 guoluo_* 工具同源，不写档案、不执行素材。',
      });
      return;
    }
    if (tail === '/overview') {
      sendJson(res, 200, await workbench.overview({ offset: queryNumber(url, 'offset', 0), limit: queryNumber(url, 'limit', 20) }));
      return;
    }
    if (tail === '/project') {
      sendJson(res, 200, await workbench.project({ id: url.searchParams.get('id') ?? undefined }));
      return;
    }
    if (tail === '/evidence') {
      sendJson(res, 200, await workbench.evidence({
        id: url.searchParams.get('id') ?? undefined,
        runId: url.searchParams.get('runId') ?? undefined,
        kind: url.searchParams.get('kind') ?? undefined,
        offset: queryNumber(url, 'offset', 0),
        limit: queryNumber(url, 'limit', 20),
      }));
      return;
    }
    sendJson(res, 404, { ok: false, text: '没有这个接口。可用的有 overview、project、evidence。' });
  } catch (error) {
    sendJson(res, error?.kind === 'invalid-input' ? 400 : 500, { ok: false, text: String(error?.message ?? error).slice(0, 2000) });
  }
}

export function apply(ctx, config = {}) {
  const projects = projectService(config);
  const workbench = createWorkbench({ projects, version: pluginVersion });
  const add = (suffix, description, properties, required, execute, timeoutMs = 10000) => {
    ctx.effect(() => ctx.tools.register({
      name: `guoluo_${suffix}`, description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output, timeoutMs,
      execute: (args, exec) => execute(args, exec.signal),
    }));
  };
  add('probe', '检查蜾蠃目录配置和 REA CLI 版本。', {}, [], (_args, signal) => projects.probe(signal));
  add('target_add', '登记素材根内的相对路径或 URL。URL 只登记；不会联网。', { kind: enumeration('local', 'url'), location: string(1000), label: string(80) }, ['kind', 'location'], projects.add);
  add('dissect', '盘点本地静态素材（目录、HTML/CSS、ASAR、APK、Godot PCK、EXE/DLL、Unity 素材），目录型素材会调用 REA 分析 JavaScript 应用；APK、PCK、PE 与 Unity 只做静态解析；不运行目标应用。', { id, rea: { type: 'boolean' }, reaTimeoutMs: { type: 'integer', minimum: 10000, maximum: 1800000 } }, ['id'], projects.dissect, 1800000);
  add('dossier', '分页查看已落盘的证据行，可固定 runId 并筛选种类；kind=binary 分页读 PE 与 Unity 逐文件明细；kind=apk-permission / kind=apk-activity 按本批落盘的 APK 清单证据分页读权限与活动，旧批次只保留首页时会标记需重新盘点。kind=pe-imports / kind=pe-exports 回到登记的 PE 源文件现解析，按 offset/limit 分页读完整导入符号与命名导出（多个 PE 时用 path 指明）。kind=il2cpp-types / kind=il2cpp-fields 回到登记的 global-metadata.dat 现解析，按 offset/limit 分页读类型与字段名（仅已核对版本的布局；多个元数据文件时用 path 指明）。', { id, runId: string(50), kind: enumeration('asset', 'token', 'navigation', 'reference', 'binary', 'apk-permission', 'apk-activity', 'pe-imports', 'pe-exports', 'il2cpp-types', 'il2cpp-fields'), offset, limit, path: string(500) }, ['id'], projects.dossier);
  add('spec', '把一批证据转成复刻义务账本：每条带证据位置，缺口单列。写到档案的 spec/ 目录。', { id, runId: string(50) }, ['id'], projects.spec);
  add('brief', '从指定 runId 的归档证据导出复刻交接单，包含入口、素材、待确认事项和验收步骤；仅写档案，不启动代理或生成工程。', { id, runId: string(50) }, ['id', 'runId'], projects.brief);
  add('questions', '把证据里必须由人拍板的事整理成一份问题清单，写到档案根的 questions.json：技术栈、缺口文件怎么处置、令牌冲突以哪份为准、素材是否原样沿用、原生部分是否纳入首版、工程叫什么名字。每条都带推断依据与建议答案；能由证据自己决定的事不会出现在里面。重新生成时同一批次沿用已有答案，换批次不沿用。', { id, runId: string(50) }, ['id'], projects.questions);
  add('answer', '回答 questions.json 里的一个问题，按 questionId 落盘；返回还剩哪些问题没答。答案只记录不改证据。', { id, questionId: string(48), answer: string(2000) }, ['id', 'questionId', 'answer'], projects.answer);
  add('report', '把一个档案已经掌握的事实写成逆向报告到档案根的 report.md：结论、目标与素材、技术栈判断（含依据）、证据规模与类型分布、结构与页面、边界与缺口、访谈答案与待确认项、复刻路线与当前阶段。报告不产生新证据，也不运行目标程序。', { id, runId: string(50) }, ['id'], projects.report);
  add('tokens', '导出设计令牌：tokens.css、Tailwind v4 主题片段和机器可读清单。写到档案的 tokens/ 目录。', { id, runId: string(50) }, ['id'], projects.tokens);
  add('export', '导出资产清单到档案的 export/ 目录，可选 json、markdown、csv。', { id, runId: string(50), format: { type: 'string', enum: ['json', 'markdown', 'csv'] }, kind: enumeration('asset', 'token', 'navigation', 'reference') }, ['id'], projects.export);
  add('mock', '按本批证据生成零依赖 mock 服务：静态链接回占位页，素材按素材根回放。只生成，不代为启动。', { id, runId: string(50), port: { type: 'integer', minimum: 1024, maximum: 65535 } }, ['id'], projects.mock);
  add('scaffold', '从固定 runId 的证据生成最小可运行静态工程到档案的 scaffold/ 目录：页面、样式与媒体按素材根内相对路径逐字节复制并核对指纹，另生成路由索引、令牌表与逐文件清单；只写档案根、只生成不启动、不执行素材脚本，并在生成后按规格做一次文件层覆盖核对。文件数、单文件与总量三档预算可用 files/fileBytes/totalBytes 调高（默认 512 / 8 MiB / 64 MiB），被预算挡下的素材在 warnings 与 budget 里计数，不再静默截断。', {
    id, runId: string(50), name: string(80),
    files: { type: 'integer', minimum: 1, maximum: 4096 },
    fileBytes: { type: 'integer', minimum: 1, maximum: 32 * 1024 * 1024 },
    totalBytes: { type: 'integer', minimum: 1, maximum: 256 * 1024 * 1024 },
  }, ['id'], projects.scaffold, 180000);
  add('check', '核对复刻义务与证据的自洽性；给出 candidate 时再按规格核对候选工程目录里的素材、页面与令牌；显式给出 visual 时，再用 REA 比较两份本地静态页面（可按 routes 指定多条入口，各按 390/768/1440 三档视口测量），并用插件自身的 PNG 解码复算差异像素交叉核对，结果按路由独立呈报。', {
    id, runId: string(50), visual: { type: 'object', properties: {
      candidateDirectory: string(500), baselineEntry: string(500), candidateEntry: string(500),
      routes: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', properties: {
        baselineEntry: string(500), candidateEntry: string(500),
      }, additionalProperties: false } },
      channelThreshold: { type: 'integer', minimum: 0, maximum: 255 },
    }, required: ['candidateDirectory'], additionalProperties: false },
    candidate: { type: 'object', properties: { directory: string(500) }, required: ['directory'], additionalProperties: false },
  }, ['id'], projects.check, checkTimeoutMs);
  add('run', '一条命令跑完整链：盘点（或沿用指定 runId 的批次）→ 规格 → 交接单 → 令牌 → 导出 → 静态骨架 → 核对，最后在档案的 pack/<批次>/ 目录写 INDEX.md（人读顺序：先看什么、哪些缺口、怎么复刻）与 pack.json（步骤状态、数量、产物路径）。每趟生成一个独立批次目录，重跑不覆盖旧包；中途失败会停在出错的步骤上并报第几步、哪一步、原因，暂存目录当场删除。骨架预算可用 files/fileBytes/totalBytes 调高；给出 candidate 时同一趟把候选工程也核一遍。', {
    id, runId: string(50), rea: { type: 'boolean' }, reaTimeoutMs: { type: 'integer', minimum: 10000, maximum: 1800000 },
    name: string(80),
    files: { type: 'integer', minimum: 1, maximum: 4096 },
    fileBytes: { type: 'integer', minimum: 1, maximum: 32 * 1024 * 1024 },
    totalBytes: { type: 'integer', minimum: 1, maximum: 256 * 1024 * 1024 },
    candidate: { type: 'object', properties: { directory: string(500) }, required: ['directory'], additionalProperties: false },
    visual: { type: 'object', properties: {
      candidateDirectory: string(500), baselineEntry: string(500), candidateEntry: string(500),
      routes: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'object', properties: {
        baselineEntry: string(500), candidateEntry: string(500),
      }, additionalProperties: false } },
      channelThreshold: { type: 'integer', minimum: 0, maximum: 255 },
    }, required: ['candidateDirectory'], additionalProperties: false },
  }, ['id'], projects.run, 2400000);
  add('list', '列出已登记的蜾蠃档案。', { offset, limit }, [], projects.list);
  add('status', '查看某个档案最近的盘点和批次数。', { id }, ['id'], projects.status);
  add('workbench', '复刻工作台的只读读模型，与浏览器工作台面板同一份数据。view=overview 列档案与各产物目录条数；view=project 给单个档案的产物、最近一批证据概要与下一步；view=evidence 按 offset/limit 分页读证据行。', {
    view: enumeration('overview', 'project', 'evidence'),
    id, runId: string(50),
    kind: enumeration('asset', 'token', 'navigation', 'reference'),
    offset, limit,
  }, ['view'], (args, signal) => {
    if (args.view === 'overview') return workbench.overview({ offset: args.offset, limit: args.limit }, signal);
    if (args.view === 'project') return workbench.project({ id: args.id }, signal);
    return workbench.evidence({ id: args.id, runId: args.runId, kind: args.kind, offset: args.offset, limit: args.limit }, signal);
  });
  // G 要的入口在这里：浏览器里那一半与这边共用同一批只读方法。
  // webServer 不是硬依赖——无界面宿主（隔离 smoke、CLI）照样能用全部工具。
  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: '/api/guoluo',
      handler: (req, res) => handleWorkbenchRequest({ req, res, workbench, ctx }),
    }), 'guoluo: workbench');
  }
  const skill = readFileSync(new URL('./skills/guoluo-rebuild/SKILL.md', import.meta.url), 'utf8');
  const body = skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '');
  ctx.effect(() => ctx.skills.register({ name: 'guoluo-rebuild', description: summary, content: body, source: 'runtime', provider: name }));
  ctx.effect(() => ctx.commands.register({
    name, description: '蜾蠃：一条命令跑完整链，或单步检查配置、列档案、导出交接单、生成 mock 与工程骨架、核对覆盖度', input: { hint: 'run <id> | probe | list | status <id> | spec <id> | brief <id> <runId> | tokens <id> | export <id> [json|markdown|csv] | mock <id> | scaffold <id> [runId|目录名] | check <id>' }, recordInput: false,
    async handler({ rawInput, signal }) {
      const [verb, target, format, ...rest] = (rawInput ?? '').trim().split(/\s+/u);
      try {
        let result;
        if (verb === 'run' && target && !rest.length) result = await projects.run({ id: target, ...(format ? { name: format } : {}) }, signal);
        else if (verb === 'probe' && !target) result = await projects.probe(signal);
        else if (verb === 'list' && !target) result = await projects.list({}, signal);
        else if (verb === 'status' && target && !format && !rest.length) result = await projects.status({ id: target }, signal);
        else if (verb === 'spec' && target && !format && !rest.length) result = await projects.spec({ id: target }, signal);
        else if (verb === 'brief' && target && format && !rest.length) result = await projects.brief({ id: target, runId: format }, signal);
        else if (verb === 'tokens' && target && !format && !rest.length) result = await projects.tokens({ id: target }, signal);
        else if (verb === 'export' && target && !rest.length) result = await projects.export({ id: target, ...(format ? { format } : {}) }, signal);
        else if (verb === 'mock' && target && !rest.length) result = await projects.mock({ id: target, ...(format ? { port: Number(format) } : {}) }, signal);
        else if (verb === 'scaffold' && target && !rest.length) result = await projects.scaffold({ id: target, ...(format ? { name: format } : {}) }, signal);
        else if (verb === 'check' && target && !format && !rest.length) result = await projects.check({ id: target }, signal);
        else return { kind: verb ? 'error' : 'success', text: '蜾蠃 · /guoluo run <id> | probe | list | status <id> | spec <id> | brief <id> <runId> | tokens <id> | export <id> [json|markdown|csv] | mock <id> [port] | scaffold <id> [runId|目录名] | check <id>。登记和盘点请用 guoluo_target_add、guoluo_dissect。' };
        return { kind: 'success', text: JSON.stringify(result, null, 2) };
      } catch (error) {
        signal?.throwIfAborted();
        return { kind: 'error', text: error.message };
      }
    },
  }));
}
