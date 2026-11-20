# 虫珀·蜾蠃

DSH 0.2.2-rc.5 的本地应用资产档案插件。把静态素材整理成可逐条回查的证据，再把证据转成带绑定的复刻义务账本。项目阶段和证据分层参考 [craft-anything](https://github.com/storytold/craft-anything)，REA 的静态摘要作为独立来源记录。

## 开始

在插件设置中填写两个**已存在、互不包含**的绝对目录：`sourceRoot`（素材根）和 `archiveRoot`（档案根）。`reaPath` 可留空从 `PATH` 找，用于探测 REA 版本并调用 `analyze-javascript-application` 与截图/比对命令；适配普通可执行文件、Node `.mjs` 和符合固定格式的 Windows Node 启动器。REA 未装也能盘点静态素材，只是没有行为侧证据。`reaTimeoutMs` 控制单次分析超时，默认 180000 毫秒。`chromiumPath` 可选，留空时使用已安装的 Google Chrome（缺失时回退到 Microsoft Edge）；视觉核对需要本机有 Chrome 或 Edge，`playwright-core` 不自带浏览器。

1. `/guoluo probe` 检查配置与 REA CLI。
2. `guoluo_target_add` 登记 `{ "kind": "local", "location": "my-export" }`。位置相对于素材根；目录、单个 HTML/CSS、Electron `.asar`、Android `.apk` 或 Windows `.exe`/`.dll` 都可以。
3. `guoluo_dissect` 传档案 `id`，返回批次 `runId`、证据数量、覆盖说明、耗时与 REA 绑定结果。目录型素材会自动调用 REA 分析并把摘要绑定到本次素材的路径与根哈希；传 `"rea": false` 可跳过，`reaTimeoutMs` 可覆盖超时。APK 与 PE 只做静态解析，不触发 REA。
4. `guoluo_dossier` 传 `id`，可选固定 `runId`、`kind`、`offset`、`limit`。通过 `nextOffset` 翻页。
5. `guoluo_spec`、`guoluo_tokens`、`guoluo_export` 把一批证据转成派生产物，默认取最新批次。
6. `guoluo_check` 核对证据自洽性；传 `visual: { "candidateDirectory": "my-rebuild" }` 时再用 REA 比较基准与候选的三档视口（390 / 768 / 1440 宽，900 高），把「像不像」量化成变化像素比例。
7. `/guoluo list` 列档案，`/guoluo status <id>` 看状态；也可用 `guoluo_list`、`guoluo_status`。

随包提供 `guoluo-rebuild` 技能。档案索引和独立批次保存在档案根的 `<id>/target.json` 与 `<id>/runs/<runId>.json`。请使用单独的归档目录；不要在盘点时改动、移动或替换素材目录与档案目录中的条目。

## 证据与派生产物

盘点只读，一份证据落一个批次文件，不覆盖历史。派生产物写在档案根内，可重复生成、每次整份替换：

| 工具 | 输出 | 内容 |
| --- | --- | --- |
| `guoluo_spec` | `<id>/spec/spec.json`、`spec.md` | 复刻义务清单，每条带 `path:line` 证据与 `declared` 状态；冲突与缺口单列 |
| `guoluo_tokens` | `<id>/tokens/tokens.css`、`tokens.tailwind.css`、`tokens.json` | 原样 CSS 变量、Tailwind v4 `@theme inline` 片段、机器清单 |
| `guoluo_export` | `<id>/export/assets.{json,md,csv}` | 资产清单，可按类别过滤 |
| `guoluo_mock` | `<id>/mock/mock.json`、`server.mjs` | 零依赖回放服务：静态链接回占位页，素材按素材根发原始字节，其余 404 |
| `guoluo_check` | `<id>/checks/check-<ts>-<uuid>.json` | 覆盖度核对：漏项、悬空证据、与已落盘规格的批次偏差；可选视觉比对 |
| `guoluo_check`（视觉） | 同上目录下 `<w>-{baseline,candidate}.{artifact.json,png}`、`<w>-diff.json` | 三档视口截图与 REA 差异证据，绑回本次截图指纹 |

`spec` 不是设计文档生成器：它把已有证据翻译成"必须复刻什么"，每条都能回查到文件与行号。证据没覆盖的东西一律进 `unknowns`，不补写、不推测。

`mock` 只生成文件、不代为启动；返回的 `start` 是可直接复制执行的命令。它不伪造未观测到的页面结构，占位页会写明证据位置。

`check` 是 fail-closed 的：`verdict` 为 `complete` 只表示本批证据与义务互相对齐，**不表示目标已被复刻**。有漏项、悬空证据或规格与最新批次不一致时给 `blocked`，同名令牌多值给 `needs-decision`。

`check` 的视觉部分是**可选、独立呈报**的：只有显式传 `visual` 才会启动一个隔离的本地 Chromium（无头、禁用脚本、只允许访问自己起的静态服务），分别抓 390 / 768 / 1440 宽的三档视口，再用 REA `compare-web-screenshots` 算出变化像素比例。它只衡量相同视口内的静态像素差异，差异像素数由 REA 计算，本插件只校验其与本次截图指纹、尺寸和代数关系的自洽性，未独立复算像素；不代表动态页面、交互或整体复刻质量。视觉失败不影响不依赖它的证据核对，只把 `visual.status` 记为 `blocked` 并给出 `kind` 与原因。

## 当前能看什么

- **本地目录或单个 HTML/CSS**：常见媒体和字体文件目录、HTML/CSS SHA-256、CSS 自定义属性、静态 HTML 链接和部分资产引用。引用值丢弃查询参数、片段和带登录信息的 URL；不将链接当作服务器路由。
- **ASAR**：只看包头里的目录和登记大小，不验证归档成员或解包内容。要读 HTML/CSS 的证据，请单独登记已经导出的目录。
- **APK**：只按 ZIP 中央目录和二进制 `AndroidManifest.xml` 做静态解析——包名、`versionCode`/`versionName`、min/target SDK、权限、activity 与启动入口、原生 ABI，以及 `res/`、`assets/` 里可识别的图片/字体/音视频条目与 dex/so/签名的计数。不解压资源内容、不校验签名、不运行应用；APK 内的素材条目只登记、不回放。
- **EXE/DLL**：解析 DOS/COFF/可选头、节表、导入 DLL 与函数名（或序号）、导出名与序号、CLR 目录标记，进入规格的「原生二进制」表。不反编译、不解析资源与证书、不运行二进制；二进制条目只登记、不回放。
- **URL**：只保存出处，不发请求、不打开页面。原 URL 的查询参数和片段不会保存。
- **REA**：探测 CLI 版本；对目录型素材自动跑 `analyze-javascript-application`，把证据包写到 `<id>/rea/<runId>/evidence.json`，并用八项检查确认摘要与本次素材绑定——证据 id 形状、证据包可读、父操作类型、父记录里的素材路径、根哈希自洽、摘要与父记录根哈希一致、证据文件字节数一致。绑定不通过时判 `mismatch`，不给行为侧结论。
- **视觉核对**：显式传 `visual` 时，用 REA 的 `list-browser-targets`、`capture-web-screenshot`、`compare-web-screenshots` 比较基准与候选的三档静态视口，产物落盘可复查。需要本机 Chrome 或 Edge（或配置 `chromiumPath`）。

## 当前不做

不生成复刻工程、不接入 Unity/Godot、craft-anything 执行后端或小说流程。扫描有数量、深度和大小预算，命中时在覆盖字段或局限中可见。只写档案根；**默认**不启动目标应用、目标脚本或浏览器，只有显式传 `visual` 才启动插件自己起的隔离 Chromium。REA 分析只接受目录，ASAR、APK、PE 与单文件需先解包成目录。

## 开发

需要 Node.js 22 或以上。`npm ci` 后用 `npm run check` 运行回归并核对打包清单；默认回归用内置的假 REA 与假浏览器覆盖整条视觉管线，无需真实 Chrome。`GUOLUO_TEST_REA=<rea 可执行路径>` 会额外跑真实 REA 的截图与比对用例（需本机 Chrome）。`node tests/host-smoke.mjs <DSH node_modules> <包目录>` 在隔离 profile 里真实加载。提交与验证约定见 [AGENTS.md](AGENTS.md)。此项目使用 MIT 许可。
