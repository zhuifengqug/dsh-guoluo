# AGENTS.md

给在本仓库工作的 Agent 的入口说明。

## 提交与远程

- 每完成一个可验收的切片，在本地提交一次，信息遵循 Conventional Commits（`feat(guoluo): …`、`fix(guoluo): …`、`docs(guoluo): …`）。提交后立即 `git push origin main`。
- 禁止 force-push，禁止改写已推送的历史。远程冲突时先 `git pull --rebase`，冲突未解决不上推。
- 不改 Desktop profile。插件装载验证一律用隔离的 `DSH_HOME`（见 `tests/host-smoke.mjs`）。

## 代码约定

- 不得裸 import `@deepseek-ai/*`：桌面版 profile 不装 optional peer，裸 import 会让整条插件不激活。宿主依赖只能通过 `dshTarget` 声明的 peer 与 `@deepseek-ai/schemastery` 访问。
- `Config` 每个叶子字段都要 `.extra('volatile', true)`，嵌套对象外层不能标 volatile；范围校验放 `lib/` 里做，不放 schema（schema 不过会让 cordis 拒收、整插件不激活）。
- 工具返回值必须是 lossless JSON（`JSON.parse(JSON.stringify(x))` 等价），大结果一律分页，不整包回灌。
- 只写档案根。读素材根时按 `lib/paths.mjs` 的边界与预算走，不跟随链接，不执行目标代码。

## 验证

- `npm run check`：单元回归 + 打包清单核对。
- `node tests/host-smoke.mjs <DSH node_modules> <包目录>`：在隔离 profile 中真实加载，验证注册、设置热更新与整条链路。
