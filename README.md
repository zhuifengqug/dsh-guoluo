# 虫珀·蜾蠃

DSH 0.2.2-rc.5 的本地应用资产档案插件。把静态素材整理成可逐条回查的证据，再把证据转成带绑定的复刻义务账本。项目阶段和证据分层参考 [craft-anything](https://github.com/storytold/craft-anything)，REA 的静态摘要作为独立来源记录。

## 开始

在插件设置中填写两个**已存在、互不包含**的绝对目录：`sourceRoot`（素材根）和 `archiveRoot`（档案根）。`reaPath` 可留空从 `PATH` 找，用于探测 REA 版本并调用 `analyze-javascript-application` 与截图/比对命令；适配普通可执行文件、Node `.mjs` 和符合固定格式的 Windows Node 启动器。REA 未装也能盘点静态素材，只是没有行为侧证据。`reaTimeoutMs` 控制单次分析超时，默认 180000 毫秒。`chromiumPath` 可选，留空时使用已安装的 Google Chrome（缺失时回退到 Microsoft Edge）；视觉核对需要本机有 Chrome 或 Edge，`playwright-core` 不自带浏览器。

1. `/guoluo probe` 检查配置与 REA CLI。
2. `guoluo_target_add` 登记 `{ "kind": "local", "location": "my-export" }`。位置相对于素材根；目录、单个 HTML/CSS、Electron `.asar`、Android `.apk`、Godot `.pck`、Windows `.exe`/`.dll`，以及 Unity 的 `global-metadata.dat` 或 `.bundle`/`.unity3d` 都可以。
3. `guoluo_dissect` 传档案 `id`，返回批次 `runId`、证据数量、覆盖说明、耗时与 REA 绑定结果。目录型素材会自动调用 REA 分析并把摘要绑定到本次素材的路径与根哈希；传 `"rea": false` 可跳过，`reaTimeoutMs` 可覆盖超时。APK、PCK、PE 与 Unity 素材只做静态解析，不触发 REA。
4. `guoluo_dossier` 传 `id`，可选固定 `runId`、`kind`、`offset`、`limit`。通过 `nextOffset` 翻页。`kind: binary` 分页读 PE 与 Unity 逐文件明细；`kind: apk-permission` 与 `kind: apk-activity` 分页读 APK 清单里已落盘的权限与活动，旧批次只存首页时回执 `stale: true`，需要重新盘点才能看到后段。每页最多 50 条。超过 512 KiB 的证据行总量预算时，`clipped` 会说明原因，`nextOffset` 指向下一条。一条证据始终完整返回，单条超出预算时独占一页。
5. `guoluo_spec`、`guoluo_tokens`、`guoluo_export` 把一批证据转成派生产物，默认取最新批次。
6. `guoluo_check` 核对证据自洽性。传 `candidate: { "directory": "my-rebuild" }` 按规格核对候选工程目录里的素材、页面与令牌是否对得上（只看文件层，不看结构与行为）。传 `visual: { "candidateDirectory": "my-rebuild" }` 可核对默认入口的渲染差异。多页核对通过 `visual.routes` 指定基准和候选的 HTML 文件，每页比较 390、768、1440 三档宽度，高度固定为 900。
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
| `guoluo_check` | `<id>/checks/check-<ts>-<uuid>.json` | 覆盖度核对：漏项、悬空证据、与已落盘规格的批次偏差；可选候选工程覆盖度与视觉比对 |
| `guoluo_check`（视觉） | `<id>/checks/check-<ts>-<uuid>/` 下的 `summary.json`、`r<n>-<w>-{before,after}.{artifact.json,png}`、`r<n>-<w>-diff.json` | 逐路由、逐视口的核对结果与截图证据 |

`spec` 不是设计文档生成器：它把已有证据翻译成"必须复刻什么"，每条都能回查到文件与行号。证据没覆盖的东西一律进 `unknowns`，不补写、不推测。

`mock` 只生成文件、不代为启动；返回的 `start` 是可直接复制执行的命令。它不伪造未观测到的页面结构，占位页会写明证据位置。

`check` 是 fail-closed 的：`verdict` 为 `complete` 只表示本批证据与义务互相对齐，**不表示目标已被复刻**。有漏项、悬空证据或规格与最新批次不一致时给 `blocked`，同名令牌多值给 `needs-decision`。

`check` 的候选工程覆盖度独立呈报。传 `candidate: { "directory": "my-rebuild" }`（素材根内的目录）后，插件逐个核对规格声明的素材文件、页面入口与同名样式令牌是否出现在候选目录里：素材按相对路径比对，页面按路径或同名文件比对，令牌在候选 CSS 文本里检索同名声明。归档成员（ASAR、APK、PCK）不回放也不判缺失，只标成归档来源。结果分 `present`、`missing`、`archived` 三组，`verdict` 为 `partial` 说明有找不到的对象——这只说明文件层面对不上，**不说明结构与行为等价**。

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

- **本地目录或单个 HTML/CSS**：常见媒体和字体文件目录、HTML/CSS SHA-256、CSS 自定义属性、静态 HTML 链接和部分资产引用。引用值丢弃查询参数、片段和带登录信息的 URL；不将链接当作服务器路由。
- **ASAR**：只看包头里的目录和登记大小，不验证归档成员或解包内容。要读 HTML/CSS 的证据，请单独登记已经导出的目录。
- **APK**：只按 ZIP 中央目录和二进制 `AndroidManifest.xml` 做静态解析——包名、`versionCode`/`versionName`、min/target SDK、权限、activity 与启动入口、原生 ABI，以及 `res/`、`assets/` 里可识别的图片/字体/音视频条目与 dex/so/签名的计数。`manifestStatus` 标明清单是 `parsed`、`absent`、`unreadable` 还是 `parse-failed`。不解压资源内容、不校验签名、不运行应用；APK 内的素材条目只登记、不回放。清单里权限与活动各保留前 512 条、单类清单文本保留 256 KiB，超出部分标记截断并提示需要重新盘点。
- **EXE/DLL**：解析 DOS/COFF/可选头、节表、导入 DLL 与函数名（或序号）、导出名与序号、CLR 目录标记，进入规格的「原生二进制」表。规格保留命名导出总数，并在前 128 个命名导出引用的槽位中统计 `aliasSlots`：至少两个不同槽位记录同一非零 RVA 时计为一组。未观测时记为 `null`，实测没有符合条件的组时记为 `0`。不反编译、不解析资源与证书、不运行二进制；二进制条目只登记、不回放。
- **Godot PCK**：读取独立 PCK 的头部与文件表，支持包格式 1–4，记录引擎版本、条目大小、加密标志和场景／脚本／资源计数。加密、稀疏或超预算的目录只记录头部与声明条目数。加密条目的实际存储范围未核验。
- **Unity**：`UnityFS` 读取包头、块信息段（未压缩，或 LZ4/LZ4HC 压缩时由插件自行解压）、节点表，并把可解压的数据区按块解压后按节点切片，登记每个节点的大小、SHA-256、类型魔数与 24 字节前缀。只记指纹，不保存节点内容。预算：数据区最多读 64 MiB、解压后最多 256 MiB、单包最多列 32 个节点（超出时 `truncated` 为真，`nodeLimit` 说明上限）；任何一块声明超出上限就整段跳过并在 `payload.reason` 写明，不会先分配内存。`payload.status` 分三态：`parsed`（已解压并切片）、`skipped`（编码暂不支持、加密或超预算）、`failed`（数据区解压失败，例如块声明与真实字节不符）。LZMA/LZHAM 压缩的块、加密包与 IL2CPP 元数据字段表不展开。`global-metadata.dat` 记录 IL2CPP 声明版本与头长；已知版本的声明头长在文件范围内但与已知布局不符时，标为 `headerLayout: unverified`，保留头部证据，不核对字段表。Unity 素材只登记、不回放。
- **URL**：只保存出处，不发请求、不打开页面。原 URL 的查询参数和片段不会保存。
- **REA**：探测 CLI 版本；对目录型素材自动跑 `analyze-javascript-application`，把证据包写到 `<id>/rea/<runId>/evidence.json`，并用八项检查确认摘要与本次素材绑定——证据 id 形状、证据包可读、父操作类型、父记录里的素材路径、根哈希自洽、摘要与父记录根哈希一致、证据文件字节数一致。绑定不通过时判 `mismatch`，不给行为侧结论。
- **视觉核对**：显式传 `visual` 时，用 REA 的 `list-browser-targets`、`capture-web-screenshot`、`compare-web-screenshots` 比较基准与候选的三档静态视口，产物落盘可复查。需要本机 Chrome 或 Edge（或配置 `chromiumPath`）。
- **候选工程覆盖度**：显式传 `candidate` 时，只读扫描候选目录（不跟随链接、不执行候选代码），核对规格声明的素材文件、页面入口与同名样式令牌是否存在。归档成员不判缺失。文件层面对得上不等于复刻完成。

## 当前不做

不生成复刻工程、不接入 craft-anything 执行后端或小说流程；Unity 只对节点做指纹登记，不保存节点内容、不读取 IL2CPP 元数据字段表或反编译。扫描有数量、深度和大小预算，命中时在覆盖字段或局限中可见。只写档案根；**默认**不启动目标应用、目标脚本或浏览器，只有显式传 `visual` 才启动插件自己起的隔离 Chromium。REA 分析只接受目录，ASAR、APK、PCK、PE 与单文件需先解包成目录。

## 开发

需要 Node.js 22 或以上。`npm ci` 后用 `npm run check` 运行回归并核对打包清单；默认回归用内置的假 REA 与假浏览器覆盖整条视觉管线，无需真实 Chrome。`GUOLUO_TEST_REA=<rea 可执行路径>` 会额外跑真实 REA 的截图与比对用例（需本机 Chrome）。`npm run check` 用 `test:serial` 串行跑文件：并发跑时同时起多个 Chromium 会偶发让某一档落到环境失败，串行后稳定；日常改动用 `npm test` 并发更快。`node tests/host-smoke.mjs <DSH node_modules> <包目录>` 在隔离 profile 里真实加载。提交与验证约定见 [AGENTS.md](AGENTS.md)。此项目使用 MIT 许可。

Godot 4.7.2 的 `PCKPacker` 生成了普通条目和零字节条目两份夹具。[UnityFS v6 夹具](tests/fixtures/unityfs-none.bundle) 由仓库脚本拼装，再用 UnityPy 1.25.4 回读。[UnityFS v7 夹具](tests/fixtures/unityfs-lz4-tail.bundle) 由 UnityPy 保存并回读，使用尾置 LZ4 块信息段（该夹具的数据块本身未压缩）。数据块为 LZ4 的正例与「改一字节 / 挪一格节点位移即变指纹」的反证用例，由 [Unity 回归测试](tests/unity.test.mjs) 在测试内就地拼装 LZ4 字面量块生成。另有一份 UnityPy `BundleFile.save("none")` 独立写入的 v7 包及回读结果，内嵌在 [Unity 回归测试](tests/unity.test.mjs) 中，常规 Node 测试不依赖 Python。
