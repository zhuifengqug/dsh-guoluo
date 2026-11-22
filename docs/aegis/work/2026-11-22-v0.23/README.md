# v0.23.0 — guoluo_check 的结构层核对

切片来源：m05922（G 直接批准方向，要求把 `candidate` 核对从「文件在、指纹对」扩到「结构像」，并让 v0.22.0 的 `scaffold` 产物走完闭环）。

## 为什么做这一版

v0.22.0 的 `scaffold` 能出一份可打开的静态工程，但回核只有文件层：`present/missing/changed` 只回答「路径在不在、字节一不一样」。一个把 `id` 改掉、把导航改指向别处、把 `<div>` 换成 `<section>` 的候选工程，在文件层仍可能判 `complete`——因为素材本来就没变。结构维度补的就是这段：**静态解析两侧 HTML，比页面清单、关键选择器、链接目标与标签层级**。

## 实现要点

- 新增 `lib/structure.mjs`：`profileHtml()` 用 parse5 把一份 HTML 读成结构事实（标签计数、id/class 选择器、`a[href]` 原文目标、`parent>child` 边集合、「深度:标签」分布、节点数、是否被预算截断）；`compareStructure()` 做页面配对与四维比对，输出 `pages`/`selectors`/`navigation`/`hierarchy`/`unverified`/`missingCount`/`diverged`/`method`/`limits`。
- 预算：页面 24 个、单页 512 KiB、合计 8 MiB、每页 4000 节点、每页 400 个选择器、200 条链接、清单类结果每项只列 20 条并带总数。超预算的页面进 `unverified`，不硬造失败。
- 比较口径（都写进回执 `method` 与 `unchecked`）：
  - 页面配对先按相对路径精确匹配，再退化为同名文件匹配；证据页没有对应候选页 → `pages.missing`。
  - 候选多出来的页面只进 `pages.extra`，`_scaffold/` 前缀标 `generated: true`，**不计失败**（scaffold 生成的索引页因此天然无害）。
  - 链接只比 `a[href]` 原文（去首尾空白）；`#` 锚点、空目标与 `javascript:`/`mailto:`/`tel:`/`data:` 不进比较，计入 `navigation.skipped`；同一目标出现在别的候选页记 `navigation.elsewhere`（跨页可达但不是同页一致）。
  - 层级比标签计数占位、父子边存在性与「深度:标签」计数，只报「证据有、候选少」，不比顺序、属性值与文本。
- `lib/check.mjs`：`checkCandidate({ ... files, css, html, evidencePages })` 新增两个入参并输出 `structure`；`verdict` 从 `missing === 0` 改为 `missing === 0 && structure.missingCount === 0`；`complete` 的措辞改成「文件层与结构层都对得上，不说明样式、布局、脚本行为或业务逻辑等价，更不说明目标已被复刻」；`unchecked` 从 4 条补到 6 条（结构与结构未核）。
- `lib/projects.mjs`：`scanCandidate()` 增加 `.html`/`.htm` 文本收集（64 个文件 / 单页 512 KiB / 合计 8 MiB，UTF-8 严格解码失败就带 `reason`）；新增 `readEvidencePages()` 从素材根按盘点行重读证据页，走 `localPath` + `readBounded` 同一套边界与预算；`checkCandidateRun()` 两侧都喂进去；`scaffold()` 生成时就把「复制页 + `_scaffold/index.html`」与证据页送进同一个 `checkCandidate`，`coverage.structure` 一并回执。
- 边界未动：`candidate.directory` 仍然只能是素材根内的目录；要回核档案里的生成目录，把它放回素材根再跑 `check`（host-smoke 就是这么闭环验证的），路径规则没有为它开口子。

## 文档同步

- `README.md`：`guoluo_check` 步骤、候选覆盖度两段、派生产物表、`scaffold` 段与「当前不做」都补了结构维度的口径与残留未核区。
- `skills/guoluo-rebuild/SKILL.md`：第 9 步写清 `structure` 字段、`pages.extra`/`unverified` 不判失败；第 8 步写清 scaffold 的回核方式。
- `lib/inventory.mjs`：解析 HTML 时记一条说明——盘点只抽导航与引用行，DOM 层级与选择器要到 `check` 的候选核对阶段才比。
- `lib/spec.mjs`：`gaps` 加一条「页面结构不固化进规格」。

## 回归与验收

- 新增 `tests/structure.test.mjs` 10 条：同一页面判一致、缺 `id`/`class` 逐条点名、导航目标改动点名、标签层级差异点名、证据页读不到记 `unverified`、超节点预算记 `truncated`+`unverified`、候选多出 `_scaffold/index.html` 只进 `extra`、候选核对结构一致时 `complete` 且令牌层结果不变、选择器缺失把 `verdict` 拉成 `partial`（文件层结论不动）、`scaffold` 生成时闭环 `comparedPages: 1 / diverged: false`。
- `tests/candidate.test.mjs`：`unchecked` 4 → 6，并断言 `structure.scope` 与 `pages.matched`。
- `tests/host-smoke.mjs`：断言 scaffold 的 `coverage.structure`，并把生成目录 `cp` 回素材根用公开 `check` 再核一次（`candidate.verdict === 'complete'`、`structure.comparedPages === 1`、`pages.extra.count === 1`），回执加 `derived.structure`。
- 全套：`GUOLUO_TEST_UNITY_V9` + `GUOLUO_TEST_IL2CPP` + `GUOLUO_TEST_REA` 同时开启跑 `npm run test:serial` → **153 tests，153 pass / 0 fail / 0 skipped**（含真实 v9、真实 IL2CPP 与两条真实 REA 用例）。
- 打包：28 文件，package size **92.8 kB**，unpacked **296.2 kB**，shasum `ad26498582a71816ee5ad4537f88b620861ae7d3`。
- 隔离 DSH smoke（`node tests/host-smoke.mjs 'D:\deepseek HARNESS\resources\app\dsh\node_modules' <解包目录>`）退出码 0：
  `{"result":"passed","version":"0.23.0","visual":null,"tools":13,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,"rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified","derived":{"spec":2,"brief":true,"tokens":1,"exported":2,"mock":0,"check":"complete","candidate":"partial","scaffold":2,"structure":1},"pck":2,"unity":"lz4","unityV9":null,"il2cpp":1}`
  （该次未设 `GUOLUO_TEST_UNITY_V9`，故 `unityV9: null`；`structure: 1` 是闭环回核里结构比对的页面数。）
- 打包产物：`docs/aegis/work/2026-11-22-samples/tmp/v9/zhuifengqug-dsh-guoluo-0.23.0.tgz`，92774 B，SHA-256 `9564119C7584400FD973D977E5F6A45596EE6505AB72AA5D5EC1B5829E1FA0F1`（`.gitignore` 覆盖的 tmp 区，不入库）。

## 残留

- 结构维度不解析 CSS 选择器作用域，不判断选择器是否命中任何元素，只比声明集合是否存在。
- 不做 DOM 快照与顺序比对；同名标签数量一致但顺序调换不会被发现。
- 模板（`<template>`）内容与前端框架运行时生成的节点不在静态解析结果里。
- 未覆盖样式、布局与脚本行为；视觉与交互仍需 `visual` 与人工验收。
