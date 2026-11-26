# 虫珀·蜾蠃

DSH 0.2.2-rc.5 的本地应用资产档案插件。把静态素材整理成可逐条回查的证据，再把证据转成带绑定的复刻义务账本。项目阶段和证据分层参考 [craft-anything](https://github.com/storytold/craft-anything)，REA 的静态摘要作为独立来源记录。

## 开始

在插件设置中填写两个**已存在、互不包含**的绝对目录：`sourceRoot`（素材根）和 `archiveRoot`（档案根）。`reaPath` 可留空从 `PATH` 找，用于探测 REA 版本并调用 `analyze-javascript-application` 与截图/比对命令；适配普通可执行文件、Node `.mjs` 和符合固定格式的 Windows Node 启动器。REA 未装也能盘点静态素材，只是没有行为侧证据。`reaTimeoutMs` 控制单次分析超时，默认 180000 毫秒。`chromiumPath` 可选，留空时使用已安装的 Google Chrome（缺失时回退到 Microsoft Edge）；视觉核对需要本机有 Chrome 或 Edge，`playwright-core` 不自带浏览器。

先 `/guoluo probe` 检查配置与 REA CLI，然后可一条命令跑完整链，或按下面分步流程执行。

想一条命令拿成品：登记之后调用 `guoluo_run`（`/guoluo run <id>`）。它按顺序跑盘点 → 规格 → 交接单 → 令牌 → 导出 → 静态骨架 → 核对，最后在档案的 `pack/<批次>/` 下写两份东西——`INDEX.md` 与 `pack.json`。每趟生成一个独立的批次目录，重跑不覆盖旧包，路径由回执的 `directory` 给出。`INDEX.md` 是给人读的入口：先说这批素材能不能开工，再按「先看什么」排好阅读顺序（规格 → 骨架说明 → 路由索引 → 交接单 → 结构缺口报告），然后是证据事实表、缺口与待确认、五步复刻路径与产物清单；`pack.json` 是同一份内容的机器读版本（每步状态、耗时、数量、产物路径）。已有批次传 `runId` 就直接沿用、不重新盘点；想同一趟把候选工程也核进去，附 `candidate: { "directory": "my-rebuild" }`。任何一步失败都会停下并报「第几步、哪一步、为什么」，暂存目录当场删掉，不会留下半截索引。单文件素材与 URL 登记不会生成骨架，`scaffold` 步骤记 `skipped` 并写明原因。下面 1–8 是同一串动作的分步执行方式。

1. `guoluo_target_add` 登记 `{ "kind": "local", "location": "my-export" }`。位置相对于素材根；目录、单个 HTML/CSS、Electron `.asar`、Android `.apk`、Godot `.pck`、Windows `.exe`/`.dll`，以及 Unity 的 `global-metadata.dat` 或 `.bundle`/`.unity3d` 都可以。
2. `guoluo_dissect` 传档案 `id`，返回批次 `runId`、证据数量、覆盖说明、耗时与 REA 绑定结果。目录型素材会自动调用 REA 分析并把摘要绑定到本次素材的路径与根哈希；传 `"rea": false` 可跳过，`reaTimeoutMs` 可覆盖超时。APK、PCK、PE 与 Unity 素材只做静态解析，不触发 REA。
3. `guoluo_dossier` 传 `id`，可选固定 `runId`、`kind`、`offset`、`limit`。通过 `nextOffset` 翻页。`kind: binary` 分页读 PE 与 Unity 逐文件明细；`kind: apk-permission` 与 `kind: apk-activity` 分页读 APK 清单里已落盘的权限与活动，旧批次只存首页时回执 `stale: true`，需要重新盘点才能看到后段。`kind: pe-imports` 与 `kind: pe-exports` 回到登记的 PE 源文件现解析，按 `offset`/`limit` 分页读完整导入符号与命名导出（几千条也可翻完；同一档案登记多个 PE 时用 `path` 指明，`path` 是相对登记位置的路径）。`kind: il2cpp-types` 与 `kind: il2cpp-fields` 回到登记的 `global-metadata.dat` 现解析，按 `offset`/`limit` 分页读类型名（含命名空间、声明类型、字段/方法计数）与字段名（含类型索引、声明类型与 token）；只对已核对布局的版本生效，未核对版本回 `status: unverified` 与原因，多个元数据文件时用 `path` 指明。这类符号页的 `total` 是本次可翻阅的条数、`nextOffset` 为 `null` 即读完、`source: current-file` 表示符号来自当前源文件而不是历史快照，`namedCount` 给出导出表声明的总数；读取预算用尽时 `status: partial` 且 `incomplete: true`，`note` 明确「翻页结束不代表读完整张表」。证据行总量 512 KiB 的 `clipped` 只作用于 `binary`/`apk-*` 这类落盘证据页；一条证据始终完整返回，单条超出预算时独占一页。所有分页每次最多 50 条。
4. `guoluo_spec`、`guoluo_tokens`、`guoluo_export` 把一批证据转成派生产物，默认取最新批次。
5. `guoluo_brief` 传 `id` 与必填的 `runId`，把这一批证据写成复刻交接单：先做哪些 HTML 入口、参考哪些素材与令牌、哪些声明有待确认、按什么顺序验收。它只写档案里的 `brief/<runId>.md`，不启动子代理、不落地工程（要静态工程骨架用 `guoluo_scaffold`）。不能省略 `runId`——派生产物按批次固定，避免交接单悄悄换了依据。
6. `guoluo_check` 核对证据自洽性。传 `candidate: { "directory": "my-rebuild" }` 按规格核对候选工程目录里的素材、页面与令牌是否对得上，并在同一回执里给出页面结构比对（选择器、链接目标、标签层级），同时把结构缺口写成同目录的 `check-<ts>-<uuid>.md` 核对报告。传 `visual: { "candidateDirectory": "my-rebuild" }` 可核对默认入口的渲染差异。多页核对通过 `visual.routes` 指定基准和候选的 HTML 文件，每页比较 390、768、1440 三档宽度，高度固定为 900。
7. `guoluo_scaffold` 传 `id`，可选 `runId`、目录名 `name` 与三档复制预算 `files`/`fileBytes`/`totalBytes`（默认 512 个文件 / 单文件 8 MiB / 合计 64 MiB，上限 4096 / 32 MiB / 256 MiB），在档案的 `scaffold/<name>/` 下生成最小可运行静态工程：已盘点的页面、样式、图片、字体与音视频按素材根内相对路径逐字节复制并核对档案指纹，另加 `_scaffold/index.html` 路由索引、`tokens.css`/`tokens.tailwind.css` 与 `_scaffold/scaffold.json` 逐文件清单；生成后立刻按同一批规格做一次文件层覆盖核对并回执 `coverage`。只写档案根、只生成不启动、不执行素材脚本；同名目录已存在时拒绝覆盖。
8. `/guoluo list` 列档案，`/guoluo status <id>` 看状态；也可用 `guoluo_list`、`guoluo_status`。

随包提供 `guoluo-rebuild` 技能。档案索引和独立批次保存在档案根的 `<id>/target.json` 与 `<id>/runs/<runId>.json`。请使用单独的归档目录；不要在盘点时改动、移动或替换素材目录与档案目录中的条目。

## 拿它复刻一个应用

1. **把样本放进素材根。** 把要复刻的对象放到 `sourceRoot` 下的一个子目录：站点导出目录、解包后的桌面应用、`.asar` 解包出来的目录都行。素材根只读，盘点期间别改它。
2. **登记，然后一条命令。** `guoluo_target_add { "kind": "local", "location": "导出目录" }` 拿 `id`，再 `guoluo_run { "id": "<id>" }`。素材超过默认复制预算时补 `files` / `fileBytes` / `totalBytes`；想同一趟把已有候选工程也核进去，附 `candidate`。回执里的 `directory` 就是这一趟的复刻包。
3. **先读 `pack/<批次>/INDEX.md`。** 它先回答「这批素材能不能开工」：证据数量、缺口与环境依赖，然后给出阅读顺序（规格 → 骨架说明 → 路由索引 → 交接单 → 结构缺口报告），最后是五步路径与产物清单。要下判断只看这一页。
4. **按 `spec.md` 逐条复刻。** 每条义务都带 `path:line`，能回查到文件与行号；`unknowns` 里的东西不要凭感觉补。`scaffold/<name>/` 是素材底座（页面、样式、图片按原相对路径逐字节复制），可以就地搭结构，也可以整份拷出去当参照。
5. **回核。** 把复刻工程放回 `sourceRoot` 内，`guoluo_check { "id": "<id>", "candidate": { "directory": "复刻工程" } }`：`coverage` 给文件层计数，`structure` 给页面结构比对，同目录的 `check-<ts>-<uuid>.md` 按证据页列出缺的选择器、链接目标与标签层级。要核渲染再传 `visual`——它只量三档静态视口，交互与功能得各自验收。

`complete` 在三层都对齐时出现，含义是「这批证据与这份候选在文件层、令牌声明、页面结构上对得上」，不是「目标已被复刻」，更不是「行为等价」。

## 证据与派生产物

盘点只读，一份证据落一个批次文件，不覆盖历史。派生产物写在档案根内，可重复生成、每次整份替换：

| 工具 | 输出 | 内容 |
| --- | --- | --- |
| `guoluo_spec` | `<id>/spec/spec.json`、`spec.md` | 复刻义务清单，每条带 `path:line` 证据与 `declared` 状态；冲突与缺口单列 |
| `guoluo_tokens` | `<id>/tokens/tokens.css`、`tokens.tailwind.css`、`tokens.json` | 原样 CSS 变量、Tailwind v4 `@theme inline` 片段、机器清单 |
| `guoluo_export` | `<id>/export/assets.{json,md,csv}` | 资产清单，可按类别过滤 |
| `guoluo_brief` | `<id>/brief/<runId>.md` | 复刻交接单：入口、素材、令牌、待确认项与验收顺序；只读同一批次证据 |
| `guoluo_mock` | `<id>/mock/mock.json`、`server.mjs` | 零依赖回放服务：静态链接回占位页，素材按素材根发原始字节，其余 404 |
| `guoluo_scaffold` | `<id>/scaffold/<name>/` 下的素材副本、`_scaffold/{index.html,tokens.css,tokens.tailwind.css,scaffold.json}`、`README.md` | 最小可运行静态工程：素材逐字节复制并核指纹，另生成路由索引、令牌表与逐文件清单；生成后即做文件层覆盖核对 |
| `guoluo_check` | `<id>/checks/check-<ts>-<uuid>.json` | 覆盖度核对：漏项、悬空证据、与已落盘规格的批次偏差；可选候选工程覆盖度（文件层 + 页面结构层）与视觉比对 |
| `guoluo_run` | `<id>/pack/<批次>/INDEX.md`、`pack.json` | 一条命令串完整链后的入口：人读索引（结论、阅读顺序、证据事实、缺口、五步复刻路径、产物清单）与机器读汇总（每步状态与产物路径）；每趟一个独立批次目录，重跑不覆盖旧包 |
| `guoluo_check`（结构报告） | `<id>/checks/check-<ts>-<uuid>.md` | 候选结构缺口报告：按证据页分组列出缺的选择器、链接目标、标签数量与深度分布，并单列未核页、缺页与候选多出的页 |
| `guoluo_check`（视觉） | `<id>/checks/check-<ts>-<uuid>/` 下的 `summary.json`、`r<n>-<w>-{before,after}.{artifact.json,png}`、`r<n>-<w>-diff.json` | 逐路由、逐视口的核对结果与截图证据 |

`run` 只是编排：它按顺序调用上面这些工具，产物位置与分步执行完全一致，`pack/<批次>/` 里没有新事实——只有索引与汇总。每趟生成一个独立批次目录：写到一半失败或取消时暂存目录当场删除，已经写好的旧包原样保留；删掉某个包目录也不会损失别的产物。它不会把候选工程塞进素材根，也不会跳过任何一步的失败：出错即停，报「第几步、哪一步、为什么」。

`spec` 不是设计文档生成器：它把已有证据翻译成"必须复刻什么"，每条都能回查到文件与行号。证据没覆盖的东西一律进 `unknowns`，不补写、不推测。

`mock` 只生成文件、不代为启动；返回的 `start` 是可直接复制执行的命令。它不伪造未观测到的页面结构，占位页会写明证据位置。

`scaffold` 不是工程生成器：它只把已盘点的静态素材按原相对路径搬成一份可直接打开或 `python -m http.server` 起来的目录，再加索引、令牌与清单。素材字节与档案指纹不一致（盘点后源文件变过）时逐项跳过并写进 `skipped`，不把未核对的字节当证据；素材里出现 `README.md` 或 `_scaffold/` 同名路径时直接拒绝，不写半截工程。归档成员、可执行文件与非静态条目不复刻，覆盖度会照实把它们记为缺口。复制预算按素材条数、单文件字节与合计字节三档计算，被挡下的素材逐条进 `skipped` 并在 `warnings` 里给出计数、在回执 `budget`（`hit`/`blocked`/三档上限）里可查，不再静默截断；要全搬就调高对应上限再生成。证据里没有 HTML 页面时，`web.applicable` 为 `false`，`warnings` 明写结构、令牌与导航是空集而不是核对通过。它返回的 `coverage` 同时含文件层计数与 `structure` 结构维度（照 scaffold 产物形状把复制页与 `_scaffold/index.html` 一起比），只说明这两层对得上，不说明样式或行为等价。

`check` 是 fail-closed 的：`verdict` 为 `complete` 只表示本批证据与义务互相对齐，**不表示目标已被复刻**。有漏项、悬空证据或规格与最新批次不一致时给 `blocked`，同名令牌多值给 `needs-decision`。

`check` 的候选工程覆盖度独立呈报。传 `candidate: { "directory": "my-rebuild" }`（素材根内的目录）后，插件逐个核对规格声明的素材文件、页面入口与同名样式令牌是否出现在候选目录里：素材按相对路径比对，页面按路径或同名文件比对，令牌在候选 CSS 文本里检索同名声明。归档成员（ASAR、APK、PCK）不回放也不判缺失，只标成归档来源。结果分 `present`、`missing`、`archived`、`changed` 四组：找得到且内容一致进 `present` 并标 `same: true`，同名但 SHA-256 不同的进 `changed` 并并列两边指纹。`verdict` 为 `partial` 说明有找不到的对象——文件层面对不上，**不说明结构与行为等价**。令牌另外逐字符比对声明值（仅去首尾空白），同名的值不同时进 `values.differs` 并并列档案值与候选值；取值差异不算缺失，`verdict` 只看有没有找到，`values.method` 与 `unchecked` 写明不展开简写、不解析 `var()`、不比较计算值与级联结果。

同一份回执里的 `structure` 是结构维度，独立于文件层计数：证据侧页面从素材根按盘点行重读（同一套路径校验与预算），候选侧页面来自候选目录里的 `.html`/`.htm`，两侧都用 parse5 静态解析成结构事实后比对四件事——页面清单（缺页进 `pages.missing`，候选多出来的页面进 `pages.extra` 并在 `_scaffold/` 下时标 `generated: true`，多出来的不算缺口）、`id`/`class` 选择器集合（进 `selectors.missing`）、`a[href]` 原文目标（进 `navigation.missing`；同一目标出现在别的候选页时记 `elsewhere`；`#` 锚点、空目标与 `javascript:`/`mailto:`/`tel:`/`data:` 不进比较，计入 `navigation.skipped`）、标签层级（标签计数、父子边与「深度:标签」分布进 `hierarchy`）。解析不出、没读到或被节点预算截断的页面进 `structure.unverified`，**不计失败也不代表一致**。结构维度有任何缺口时 `verdict` 落到 `partial`，`note` 会写明缺口数与未核数。`complete` 只说明文件层与结构层都对得上，不说明样式、布局、脚本行为或业务逻辑等价，更不说明目标已被复刻。

回执里的 JSON 清单只留每节前 20 条摘要；同目录的 `<checkId>.md` 是给人读的核对报告：按证据页分组列出缺失的 `#id`/`.class`、`a[href]` 目标、标签数量与深度分布（每节最多列 100 条并注明余量），再单列未核页面（带原因）、候选里找不到的证据页、候选多出的页面（`_scaffold/` 生成页标「生成物」）。报告只复述静态解析出的事实，路径由回执的 `candidate.report` 给出；不生成报告的场合只有一种——候选核对本身没跑起来（回执里 `candidate.verdict` 为 `blocked`）。

`check` 的视觉部分独立呈报。显式传 `visual` 后，插件会启动隔离的无头 Chromium，禁用脚本并只加载本地静态服务。`candidateDirectory` 是素材根内的候选目录。下面例子核对首页和文档页，两个 `Entry` 字段分别相对于基准和候选目录。

```json
{
  "id": "<档案 ID>",
  "runId": "<批次 ID>",
  "visual": {
    "candidateDirectory": "my-rebuild",
    "routes": [
      { "baselineEntry": "index.html", "candidateEntry": "index.html" },
      { "baselineEntry": "docs/index.html", "candidateEntry": "help/index.html" }
    ],
    "channelThreshold": 0
  }
}
```

支持 1–16 条路由。单页调用也可在 `visual` 顶层指定 `baselineEntry` 和 `candidateEntry`，与 `routes` 二选一。REA 的截图经过指纹核对，插件独立解码 PNG 并复算变化像素数、最大通道差值与平均绝对通道差值三项，与 REA 证据逐项交叉核对。任一项不一致时，该档会标为 `conflict` 并保留两组数值。路由三档全部核验通过后才出分，分数取 `1 − 三档中的最大变化像素比例`。默认结论写明「本分数按逐通道 0 阈值计算，含抗锯齿差异」。像素分数衡量本地静态视口，交互和功能需各自验收。

## 当前能看什么

- **本地目录或单个 HTML/CSS**：常见媒体和字体文件目录、HTML/CSS SHA-256、CSS 自定义属性、静态 HTML 链接和部分资产引用。引用值丢弃查询参数、片段和带登录信息的 URL；不将链接当作服务器路由。扩展名不在识别表里的文件不会消失：它们以 `type: other` 登记路径、字节数与扩展名，并在单文件 32 MiB、合计 256 MiB 的指纹预算内算 SHA-256，`coverage.untyped` 给出条数、`notes` 写明这批文件只是文件级证据。
- **ASAR**：只看包头里的目录和登记大小，不验证归档成员或解包内容。要读 HTML/CSS 的证据，请单独登记已经导出的目录。
- **APK**：只按 ZIP 中央目录和二进制 `AndroidManifest.xml` 做静态解析——包名、`versionCode`/`versionName`、min/target SDK、权限、activity 与启动入口、原生 ABI，以及 `res/`、`assets/` 里可识别的图片/字体/音视频条目与 dex/so/签名的计数。`manifestStatus` 标明清单是 `parsed`、`absent`、`unreadable` 还是 `parse-failed`。不解压资源内容、不校验签名、不运行应用；APK 内的素材条目只登记、不回放。清单里权限与活动各保留前 512 条、单类清单文本保留 256 KiB，超出部分标记截断并提示需要重新盘点。
- **EXE/DLL**：解析 DOS/COFF/可选头、节表、导入 DLL 与函数名（或序号）、导出名与序号、CLR 目录标记，进入规格的「原生二进制」表。规格保留命名导出总数，并在前 128 个命名导出引用的槽位中统计 `aliasSlots`：至少两个不同槽位记录同一非零 RVA 时计为一组。未观测时记为 `null`，实测没有符合条件的组时记为 `0`。不反编译、不解析资源与证书、不运行二进制；二进制条目只登记、不回放。
- **Godot PCK**：读取独立 PCK 的头部与文件表，支持包格式 1–4，记录引擎版本、条目大小、加密标志和场景／脚本／资源计数。加密、稀疏或超预算的目录只记录头部与声明条目数。加密条目的实际存储范围未核验。
- **Unity**：`UnityFS` 读取包头、块信息段（未压缩，或 LZ4/LZ4HC/LZMA 压缩时由插件自行解压）、节点表，并把可解压的数据区按块解压后按节点切片，登记每个节点的大小、SHA-256、类型魔数与 24 字节前缀。只记指纹，不保存节点内容。预算：数据区最多读 64 MiB、解压后最多 256 MiB、单包最多列 32 个节点（超出时 `truncated` 为真，`nodeLimit` 说明上限）；任何一块声明超出上限就整段跳过并在 `payload.reason` 写明，不会先分配内存。`payload.status` 分三态：`parsed`（已解压并切片）、`skipped`（编码暂不支持、加密或超预算）、`failed`（数据区解压失败，例如块声明与真实字节不符）。LZHAM 压缩明确不支持（封装成 LZHAM 的块与块信息段一律标 `skipped`），加密包也不解。`UnityFS` v6–v8 按压缩长度累加块位置；v9 按块表里的显式存储偏移取块，允许块间留白但拒绝重叠或越界。v9 的 `blocks.items[].offset` 相对数据区起点 `dataStart`，节点 `offset` 仍相对解压后的逻辑数据区。v10 及以上只保留头部事实（`tableLayout: unverified`、`blocksInfo.status: unsupported`、`blocks`/`nodes` 为 null）。`global-metadata.dat` 对已核对布局的版本（v24）读区段表、类型名与字段名并给出 `counts`（类型/字段/方法/程序集/字符串字面量）与前 24 个类型样例，字段按 `declaringType` 归位；未核对版本只报 `metadataVersion` 与 `declaredHeaderBytes`，标 `status: unverified`，不按猜出来的偏移切表。方法体、字段类型签名与运行时行为始终不展开。Unity 素材只登记、不回放。
- **URL**：只保存出处，不发请求、不打开页面。原 URL 的查询参数和片段不会保存。
- **REA**：探测 CLI 版本；对目录型素材自动跑 `analyze-javascript-application`，把证据包写到 `<id>/rea/<runId>/evidence.json`，并用八项检查确认摘要与本次素材绑定——证据 id 形状、证据包可读、父操作类型、父记录里的素材路径、根哈希自洽、摘要与父记录根哈希一致、证据文件字节数一致。绑定不通过时判 `mismatch`，不给行为侧结论。
- **视觉核对**：显式传 `visual` 时，用 REA 的 `list-browser-targets`、`capture-web-screenshot`、`compare-web-screenshots` 比较基准与候选的三档静态视口，产物落盘可复查。需要本机 Chrome 或 Edge（或配置 `chromiumPath`）。
- **候选工程覆盖度**：显式传 `candidate` 时，只读扫描候选目录（不跟随链接、不执行候选代码），核对规格声明的素材文件、页面入口与同名样式令牌是否存在，并对预算内的素材逐一算 SHA-256 按内容比对（同名换内容会进 `changed`）。归档成员不判缺失。同一回执的 `structure` 把候选页面与证据页做静态结构比对（页面清单、选择器、链接目标、标签层级）；它不是 DOM 快照比对，也不碰样式与脚本。文件层与结构层都对得上不等于复刻完成。
- **复刻工作台**：安装后重启 DSH，侧栏会出现「复刻工作台」入口；主区读取 `/api/guoluo` 的只读投影，列出档案、盘点批次、`spec`/`scaffold`/`check`/`pack` 等产物计数，并按 `asset`、`token`、`navigation`、`reference` 分页浏览证据。面板与 `guoluo_workbench` 工具共用同一套 Host 服务，不写档案、不执行素材脚本；没有 `webServer` 的 CLI/隔离宿主仍可加载其余工具。

## 当前不做

不接入 craft-anything 执行后端或小说流程，也不生成业务代码：P1 的工作台先提供项目、证据和派生产物的只读视图；`scaffold` 只产出逐字节复制的静态素材目录加索引、令牌与清单，不含脚手架、路由框架、状态管理与构建配置。Web/Electron 的候选工程生成适配器留在后续 P3，不把只读工作台冒充成成品生成器；Unity 只对节点做指纹登记，不保存节点内容、不读方法体、不反编译；IL2CPP 只登记类型名与字段名（未核对版本连这一步都不做）。结构维度只比页面清单、id/class 选择器、`a[href]` 原文目标与标签层级；不做 DOM 快照、不解析 CSS 选择器作用域、不算布局与样式、不展开模板与前端框架生成的节点，也不判断路由是否可达。扫描有数量、深度和大小预算，命中时在覆盖字段或局限中可见。只写档案根；**默认**不启动目标应用、目标脚本或浏览器，只有显式传 `visual` 才启动插件自己起的隔离 Chromium。REA 分析只接受目录，ASAR、APK、PCK、PE 与单文件需先解包成目录。

## 版本与能力边界

| 版本 | 这一版定下的边界 |
| --- | --- |
| 0.21.0 | UnityFS 格式版本 9 按块表里的显式存储偏移取块（`0.20` 只能读头）；v10 及以上仍只保留头部事实 |
| 0.22.0 | `guoluo_scaffold`：把已盘点的静态素材逐字节搬成可打开的目录，附索引、令牌与逐文件清单；生成即回核文件层 |
| 0.23.0 | 候选核对加结构层：页面清单、`id`/`class` 选择器、`a[href]` 原文目标、标签层级；只比静态文本，解析不出记 `unverified` |
| 0.24.0 | 结构缺口写成按页分组的 Markdown 报告（`check-<ts>-<uuid>.md`），JSON 回执仍只留摘要 |
| 0.25.0 | 未识别扩展名不再静默丢弃（`type: other`，保留路径、字节与指纹）；复制预算可调并逐条告警；没有 HTML 页面时明说结构/令牌/导航是空集；单文件指纹上限 8 → 32 MiB |
| 0.26.0 | `guoluo_run` 一条命令串完整链；复刻包落在 `pack/<批次>/`，每趟一个不可变目录，失败不留半截、旧包原样保留 |
| 1.0.0 | 交付面定型：14 个工具 + `guoluo-rebuild` 技能 + `/guoluo` 命令、一条命令出包、README 的五步复刻流程与本表；代码与 0.26.0 相同，只补文档、版本号与 tag |
| 1.1.0 | P1 工作台半端：第 15 个 `guoluo_workbench` 工具、`/api/guoluo` 同源只读路由、`client.js` 的主区/侧栏入口、档案列表与证据分页；真实 DSH webserver smoke 覆盖路由、client 清单与打包产物 |

1.1.0 之后仍然不做的事写在「当前不做」里：P1 不写档案、不执行素材脚本、不生成业务代码；不接 craft-anything 执行后端与小说流程、不解析 Dart AOT/Flutter 快照、不做 DOM 快照与样式布局换算、不反编译、不自动发 npm 包。

## 工作台入口

完成安装后重启 DSH，侧栏会出现「复刻工作台」；点开后先看档案列表，再点档案看最近批次、产物数量与分页证据。面板只读 `/api/guoluo`，所以命令行和面板不会各自维护一套状态。没有目录时先在蜾蠃设置里填 `sourceRoot`（素材根）、`archiveRoot`（档案根，必须与素材根互不包含）、`reaPath`、`chromiumPath` 和 `reaTimeoutMs`。

P2 的 preset 完成后，目标句会是「逆向复刻这个应用：素材根内的 site 目录」。当前 P1 的可执行入口是：

```text
guoluo_target_add(kind="local", location="site")
guoluo_run(id="刚返回的档案 ID")
```

工作台刷新后会显示 `registered`、`dissected`、`specified`、`scaffolded`、`checked`、`packed` 六种进度。`guoluo_workbench` 与面板读取同一份数据，`view=overview` 看项目列表，`view=project` 看档案和最近批次，`view=evidence` 分页读证据。旧会话不会热加载新 client bundle，重启后再开新会话验收。

## 开发

需要 Node.js 22 或以上。`npm ci` 后用 `npm run check` 运行回归并核对打包清单；默认回归用内置的假 REA 与假浏览器覆盖整条视觉管线，无需真实 Chrome。`GUOLUO_TEST_REA=<rea 可执行路径>` 会额外跑真实 REA 的截图与比对用例（需本机 Chrome）。`GUOLUO_TEST_UNITY_V9=<UnityDataTools 官方 v9 包路径>` 会额外核对固定 SHA 的真实 UnityFS v9 样本（来源与哈希见本次工作记录），并让隔离宿主 smoke 走 `dissect → dossier`。另有两条交叉核对会按本机条件自动启用或在缺失时跳过：`tests/apk-cross.test.mjs` 用 `aapt2` 独立解析同一份 APK，逐项比对包名、版本、SDK、标签、权限与启动活动（`GUOLUO_TEST_AAPT2` / `GUOLUO_TEST_ANDROID_JAR` 可指定路径）；`tests/pe.test.mjs` 的「系统 PE 文件」用例会读 `%SystemRoot%\System32` 下的 kernel32/ntdll/user32/notepad，检查节范围落在文件内。`npm run check` 用 `test:serial` 串行跑文件：并发跑时同时起多个 Chromium 会偶发让某一档落到环境失败，串行后稳定；日常改动用 `npm test` 并发更快。`node tests/host-smoke.mjs <DSH node_modules> <包目录>` 在隔离 profile 里真实加载。提交与验证约定见 [AGENTS.md](AGENTS.md)。此项目使用 MIT 许可。

Godot 4.7.2 的 `PCKPacker` 生成了普通条目和零字节条目两份夹具。[UnityFS v6 夹具](tests/fixtures/unityfs-none.bundle) 由仓库脚本拼装，再用 UnityPy 1.25.4 回读。[UnityFS v7 夹具](tests/fixtures/unityfs-lz4-tail.bundle) 由 UnityPy 保存并回读，使用尾置 LZ4 块信息段（该夹具的数据块本身未压缩）。数据块为 LZ4 的正例与「改一字节 / 挪一格节点位移即变指纹」的反证用例，由 [Unity 回归测试](tests/unity.test.mjs) 在测试内就地拼装 LZ4 字面量块生成。另有一份 UnityPy `BundleFile.save("none")` 独立写入的 v7 包及回读结果，内嵌在 [Unity 回归测试](tests/unity.test.mjs) 中，常规 Node 测试不依赖 Python。
