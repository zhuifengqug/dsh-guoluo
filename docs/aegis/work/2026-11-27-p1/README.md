# P1：复刻工作台半端

日期：2026-11-27
版本：1.1.0

## 目标

P1 把既有 `guoluo_*` 证据服务接到一个真正的 DSH client 半端：主区工作台、侧栏入口、同源只读 HTTP 投影，以及与面板共用同一份读模型的 `guoluo_workbench` 工具。

本期不生成业务工程、不写素材根、不执行目标脚本、不抓运行时 DOM；`scaffold` 仍是证据素材底座。P2 再做 preset、集中提问和报告。

## 落点

- `lib/projects.mjs`：增加档案概要 `describe()`，按产物目录返回项目阶段、最近批次、运行摘要与有限条数的产物统计；列表页不读取证据 rows。
- `lib/workbench.mjs`：提供 `overview`、`project`、`evidence` 三个只读读模型；项目最多 50 个，证据每页最多 50 行，档案最近批次最多 10 个；HTTP 入参错误统一标记 `invalid-input`。
- `index.js`：声明 `webServer` 注入面，注册 `/api/guoluo` prefix 路由；GET/HEAD 只读，非同源拒绝，非 GET 返回 405；新增第 15 个工具 `guoluo_workbench`。
- `client.js`：按 DSH 的 `__ModuleLoader__` 自注册格式加载；通过 `main` 与 `sidebar.panellist` 两个 slot 提供「复刻工作台」；样式只使用宿主 alias token，不引 Harness client 包，不写 iframe 或 `document.body`。
- `package.json`：增加 `exports["./client"]`、`files: ["client.js"]` 和 `dsh.client`；本期版本 `1.1.0`。

## 验收

- 单元与集成：`node --test tests/workbench.test.mjs tests/workbench-route.test.mjs`，8/8 pass。
- client 半端：`node --test tests/client.test.mjs`，8/8 pass；覆盖自注册、React 组件渲染、侧栏 SVG、逆序清理、主题变量与越界约束。
- 全量真实环境：三环境 `npm run test:serial`（UnityFS v9、IL2CPP v24、REA 6.8.0）= 188 tests / 188 pass / 0 fail / 0 skipped。
- 打包：`zhuifengqug-dsh-guoluo-1.1.0.tgz`，31 files，116,267 B，SHA-256 `2C571B99C27786DBF192B97EE9A06674813ED9CA32F5EDA9967322A3DF458427`。
- 隔离真实 DSH host smoke：15 个工具、真实 `@deepseek-ai/dsh-host-webserver`、`/api/guoluo/overview` 200、POST 405、client export 清单通过；最终回执 `workbench.status=ready`、`workbench.stage=packed`、`derived.run=8`。

## 当前边界

工作台是只读投影，面板显示的阶段来自已落盘的 `spec`、`scaffold`、`checks`、`pack` 目录，不等价于目标应用已复刻。P2 需要补 preset roster、集中问题清单和逆向报告；P3 才实现 Web/Electron 生成适配器与预览闭环。
