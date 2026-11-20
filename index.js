import Schema from '@deepseek-ai/schemastery';
import { readFileSync } from 'node:fs';
import { projectService } from './lib/projects.mjs';

export const name = 'guoluo';
export const inject = ['tools', 'commands', 'skills', 'settings'];
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

export function apply(ctx, config = {}) {
  const projects = projectService(config);
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
  add('dissect', '盘点本地静态素材，并自动调用 REA 做 JavaScript 应用分析，把摘要绑定到本次素材的路径与根哈希；不运行目标应用。', { id, rea: { type: 'boolean' }, reaTimeoutMs: { type: 'integer', minimum: 10000, maximum: 1800000 } }, ['id'], projects.dissect, 1800000);
  add('dossier', '分页查看已落盘的证据行，可固定 runId 并筛选种类。', { id, runId: string(50), kind: enumeration('asset', 'token', 'navigation', 'reference'), offset, limit }, ['id'], projects.dossier);
  add('spec', '把一批证据转成复刻义务账本：每条带证据位置，缺口单列。写到档案的 spec/ 目录。', { id, runId: string(50) }, ['id'], projects.spec);
  add('tokens', '导出设计令牌：tokens.css、Tailwind v4 主题片段和机器可读清单。写到档案的 tokens/ 目录。', { id, runId: string(50) }, ['id'], projects.tokens);
  add('export', '导出资产清单到档案的 export/ 目录，可选 json、markdown、csv。', { id, runId: string(50), format: { type: 'string', enum: ['json', 'markdown', 'csv'] }, kind: enumeration('asset', 'token', 'navigation', 'reference') }, ['id'], projects.export);
  add('mock', '按本批证据生成零依赖 mock 服务：静态链接回占位页，素材按素材根回放。只生成，不代为启动。', { id, runId: string(50), port: { type: 'integer', minimum: 1024, maximum: 65535 } }, ['id'], projects.mock);
  add('check', '核对复刻义务与证据的自洽性；显式给出 visual 时，再用 REA 比较两份本地静态页面的三档视口，结果独立呈报。', {
    id, runId: string(50), visual: { type: 'object', properties: {
      candidateDirectory: string(500), baselineEntry: string(500), candidateEntry: string(500),
      channelThreshold: { type: 'integer', minimum: 0, maximum: 255 },
    }, required: ['candidateDirectory'], additionalProperties: false },
  }, ['id'], projects.check, 210000);
  add('list', '列出已登记的蜾蠃档案。', { offset, limit }, [], projects.list);
  add('status', '查看某个档案最近的盘点和批次数。', { id }, ['id'], projects.status);
  const skill = readFileSync(new URL('./skills/guoluo-rebuild/SKILL.md', import.meta.url), 'utf8');
  const body = skill.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '');
  ctx.effect(() => ctx.skills.register({ name: 'guoluo-rebuild', description: summary, content: body, source: 'runtime', provider: name }));
  ctx.effect(() => ctx.commands.register({
    name, description: '蜾蠃：检查配置、列档案、派生规格与令牌、生成 mock、核对覆盖度', input: { hint: 'probe | list | status <id> | spec <id> | tokens <id> | export <id> [json|markdown|csv] | mock <id> | check <id>' }, recordInput: false,
    async handler({ rawInput, signal }) {
      const [verb, target, format, ...rest] = (rawInput ?? '').trim().split(/\s+/u);
      try {
        let result;
        if (verb === 'probe' && !target) result = await projects.probe(signal);
        else if (verb === 'list' && !target) result = await projects.list({}, signal);
        else if (verb === 'status' && target && !format && !rest.length) result = await projects.status({ id: target }, signal);
        else if (verb === 'spec' && target && !format && !rest.length) result = await projects.spec({ id: target }, signal);
        else if (verb === 'tokens' && target && !format && !rest.length) result = await projects.tokens({ id: target }, signal);
        else if (verb === 'export' && target && !rest.length) result = await projects.export({ id: target, ...(format ? { format } : {}) }, signal);
        else if (verb === 'mock' && target && !rest.length) result = await projects.mock({ id: target, ...(format ? { port: Number(format) } : {}) }, signal);
        else if (verb === 'check' && target && !format && !rest.length) result = await projects.check({ id: target }, signal);
        else return { kind: verb ? 'error' : 'success', text: '蜾蠃 · /guoluo probe | list | status <id> | spec <id> | tokens <id> | export <id> [json|markdown|csv] | mock <id> [port] | check <id>。登记和盘点请用 guoluo_target_add、guoluo_dissect。' };
        return { kind: 'success', text: JSON.stringify(result, null, 2) };
      } catch (error) {
        signal?.throwIfAborted();
        return { kind: 'error', text: error.message };
      }
    },
  }));
}
