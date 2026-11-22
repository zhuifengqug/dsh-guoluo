# v0.22.0 · guoluo_scaffold：从证据生成最小静态工程骨架

## 这一版做了什么

新增第 13 个工具 `guoluo_scaffold`：从固定 `runId` 的 `spec` + `tokens` + 静态盘点证据，在档案根 `scaffold/<name>/` 下生成一份可直接打开、也可 `python -m http.server` 起来的最小静态工程。

- 已盘点的 `page`/`style`/`image`/`font`/`audio`/`video` 素材按**素材根内相对路径**逐字节复制，复制前后比 `sha256`：不一致（盘点后源文件变过）就跳过并写进 `skipped`，不把未核对字节当证据。
- 生成 `_scaffold/index.html`（观测到的页面与导航目标索引）、`_scaffold/tokens.css`、`_scaffold/tokens.tailwind.css`、`_scaffold/scaffold.json`（逐文件清单、指纹、跳过项、证据位置）与根 `README.md`。
- 生成后立刻用同一批 `spec` 在内存里跑一次 `checkCandidate`，回执 `coverage`（素材/结构/令牌的 present/missing/changed 与逐字符令牌值比对）。
- 只写档案根、只生成不启动、不执行素材脚本；不含脚手架、路由框架、状态管理或构建配置。档案里已有同名目录时拒绝覆盖。

## 边界（明确不做）

- 不接入 craft-anything 执行后端、不生成业务代码或框架工程。
- 归档成员（ASAR/APK/PCK）、PE/Unity/IL2CPP 条目、可执行文件与非静态条目不复刻；它们会作为 `assets.missing` 计入 `coverage`，不影响「文件层面对上了」的诚实反馈。
- 素材里出现 `README.md` 或 `_scaffold/` 同名路径时直接拒绝（`invalid-input`），不写半截工程。
- 单文件素材（单个 HTML/CSS）不能生成骨架：它的相邻素材不在登记范围内，按猜的路径读素材根不做。

## 关键实现

- `lib/scaffold.mjs`：纯规划层。`planScaffold({ id, runId, run, spec, collected, source, read, signal })` 返回内存文件列表 + `manifest`；`sealManifest(manifest, files)` 先算清单再回填每文件 `sha256`（清单本身不列自己）。`scaffoldLimits = { files: 512, fileBytes: 8 MiB, totalBytes: 64 MiB, listedSkipped: 20, listedRoutes: 200 }`。
- `lib/projects.mjs`：`scaffold()` 负责路径安全（`ensureDir(record,'scaffold')` + `within`）、原子写入（`.new-<uuid>` 临时目录 → `rename`）、失败清理与 `EEXIST` 转 `invalid-input`；目录名 `/^[0-9A-Za-z._-]{1,80}$/u` 且非纯点。
- `index.js`：注册 `guoluo_scaffold`（timeout 120000 ms），`/guoluo` 命令加 `scaffold` verb。
- `dsh-plugin.naming.json` 工具列表、`tests/host-smoke.mjs` 工具名数组同步为 13 项。

## 回归

- 新增 `tests/scaffold.test.mjs`（10 条）：逐字节复制 + 覆盖 complete、令牌表照抄、同名目录拒绝、两次生成互不串味、盘点后改动源文件跳过并降为 partial、单文件素材拒绝、`_scaffold/` 冲突拒绝且不留半截、非法目录名拒绝、无指纹素材复制但标 `unrecorded` 并记 warning、清单先算后回填不漏自己。
- `tests/dossier.test.mjs` 工具计数从 12 改 13 并补 `scaffold`。
- `tests/host-smoke.mjs`：隔离 DSH 内用 `site` 目标实跑 `scaffold`，断言 `counts.copied === 2`、`coverage.verdict === 'complete'`、清单 6 个文件（2 copied + 4 generated）、`app.css` 副本与源字节一致。
- `tests/visual.test.mjs:502` 的「非 8 位 PNG」用例加有界重试：整轮回归并发大量假 REA 子进程时偶发 `environment`，这条用例测的是位深判定而非进程稳定性，重试只吸收瞬时 spawn 失败，断言口径不变。

## 验收记录

- `npm run check`（带 `GUOLUO_TEST_UNITY_V9` / `GUOLUO_TEST_IL2CPP` / `GUOLUO_TEST_REA`）→ **143 tests，143 pass / 0 fail / 0 skipped**；打包 27 文件，package size **87.5 kB**，unpacked **279.1 kB**，shasum `211cf4f27bbcac61926be747be410f172a498d41`。
- 其中 `tests/scaffold.test.mjs` 10 条全过；`tests/host-smoke.mjs` 断言（copied 2 / complete / 清单 6 文件 / app.css 字节一致）随隔离宿主 smoke 一起过。
- 隔离 DSH smoke：`npm pack` → `tar -xzf --strip-components=1` → `node tests/host-smoke.mjs 'D:\deepseek HARNESS\resources\app\dsh\node_modules' docs/aegis/work/2026-11-22-samples/tmp/v9/package-0.22.0`，退出码 0，回执：
  `{"result":"passed","version":"0.22.0","visual":null,"tools":13,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,"rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified","derived":{"spec":2,"brief":true,"tokens":1,"exported":2,"mock":0,"check":"complete","candidate":"partial","scaffold":2},"pck":2,"unity":"lz4","unityV9":{"blocks":11,"nodes":4},"il2cpp":1}`
- 打包产物：`docs/aegis/work/2026-11-22-samples/tmp/v9/zhuifengqug-dsh-guoluo-0.22.0.tgz`，87492 B，SHA-256 `EC2D8CCC65D1A0764A2ABD31655862178622F50FCFE40BAA238449AA44AE884E`（在 `.gitignore` 覆盖的 tmp 区，不入库）。

