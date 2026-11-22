# v0.24.0 — 结构缺口的可读核对报告

切片来源：G 指令「把 structure 的缺口渲染成一份可读的核对报告（markdown，按页面分组列缺的选择器/链接/标签），随 check 一起落盘」。

## 为什么做这一版

v0.23.0 把结构维度塞进 JSON 回执，但回执是给机器看的：每节只留前 20 条摘要，缺口散落在 `selectors.missing` / `navigation.missing` / `hierarchy.tags` / `hierarchy.edges` / `hierarchy.depths` 五个数组里，读的人得自己在脑子里按 `path` 聚合。这一版把同一批事实渲染成一份按页面分组的 Markdown，与 JSON 回执同目录落盘。

## 实现要点

- `lib/structure.mjs` 拆成三层：
  - `analyzeStructure()`：返回**不截断**的完整清单，并额外给出 `pairs`（证据页 → 候选页、是否参与比对、未核原因）。
  - `summarizeStructure()`：压成回执里的 `structure` 摘要，形状与 v0.23.0 完全一致（`take()` 每节前 20 条），对外契约不变。
  - `compareStructure()` 保留为 `summarizeStructure(analyzeStructure(...))` 的薄包装，既有调用与测试无需改动。
- 新增 `renderStructureReport({ id, label, runId, directory, detail, createdAt })`：
  - 头部表格：目标、批次、候选目录、生成时间、`结构结论`（有 N 项对不上 / 四项均对得上）、比较页数与未核页数，再加口径与全部预算上限。
  - 总览表：页面、选择器、链接目标、标签计数、父子关系、深度分布六行，各列「证据 / 命中 / 缺失」；链接命中数旁注跨页命中条数。
  - `## 对不上的页面（N）`：每个证据页一个 `### n. 证据页 → 候选页` 小节，按「缺失选择器 / 缺失链接目标 / 标签数量不足 / 缺失父子关系 / 深度分布不足」五类逐条列出，数量不足的写「证据 X / 候选 Y」。
  - `## 对得上的页面（N）`：只有路径对，不铺细节。
  - `## 未核页面（N）`：带原因原文（例如超预算、解析失败）。
  - `## 候选里找不到的证据页（N）` 与 `## 候选多出的页面（N）`：后者对 `_scaffold/` 下的条目标「生成物」。
  - 末段 `## 这份报告不回答什么`：复述静态边界与「多出来的不判失败」「未核不计失败也不代表一致」。
  - 单节超过 `reportLimits.perSection`（100 条）只列前 100 条并写「…另有 N 项未列出」，页面类清单上限 200。旧实现在 `sectionLines` 里把余量写成了一句含糊的「见分页字段」，这一版改成明确数字。
- `lib/check.mjs`：`checkCandidate()` 增加 `structureDetail` 入参（避免重复解析），返回体带 `structureDetail`；`verdict` 口径未变。
- `lib/projects.mjs` 的 `check()`：拿到候选结果后把 `structureDetail` 摘出来只用于渲染，**不写进 JSON 回执**；报告写到 `checks/check-<ts>-<uuid>.md`（与 JSON 同名不同后缀），路径挂在回执 `candidate.report`。候选核对本身 `blocked` 时没有报告——那时结构比对根本没跑。

## 边界没动

- 报告只是同一批静态事实的排版：不新增推断、不重算、不承诺样式/布局/脚本行为等价。
- 报告落在档案根的 `checks/` 下，与既有派生文件同一套 `writeDerived`（`.new-<name>` 临时文件 + rename）；没有为它放宽任何路径规则。
- JSON 回执里 `structureDetail` 一定不存在（回归用例直接断言 `'structureDetail' in stored.candidate === false`）。

## 文档同步

- `README.md`：第 7 步加一句「同时把结构缺口写成同目录的 `check-<ts>-<uuid>.md` 核对报告」；派生产物表新增「`guoluo_check`（结构报告）」一行；结构维度那段后补一段讲报告的分组方式、每节 100 条上限、`candidate.report` 与唯一不生成报告的情形。
- `skills/guoluo-rebuild/SKILL.md` 第 9 步补「JSON 每节只留前 20 条摘要，给人看的在同目录 `<checkId>.md`」。

## 回归与验收

- 新增 `tests/structure-report.test.mjs` 5 条：按页面分组且五类缺口逐条列出（含总览表数字）、四项一致时明说「四项均对得上」、未核页/缺失证据页/候选多出生成页各成一段、单节超上限写「…另有 7 项未列出」、`check` 落盘 md 与 JSON 同名且回执带 `candidate.report`、JSON 不含 `structureDetail`。
- `tests/host-smoke.mjs`：闭环 `check` 后断言 `candidate.report` 匹配 `checks/check-<ts>-<uuid>.md`、等于 `file` 换后缀、文件含 `# 结构核对报告` 与 `| 结构结论 | 四项均对得上 |`；回执 `derived` 加 `report`。
- 全套（`GUOLUO_TEST_UNITY_V9` + `GUOLUO_TEST_IL2CPP` + `GUOLUO_TEST_REA` 全开）`npm run test:serial` → **158 tests / 158 pass / 0 fail / 0 skipped**。
- 打包：28 文件，package size **95.4 kB**，unpacked **306.1 kB**，shasum `d42105d05429d750ac692bc2a072ed4e14e15186`。
- 隔离 DSH smoke 退出码 0：
  `{"result":"passed","version":"0.24.0","visual":null,"tools":13,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,"rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified","derived":{"spec":2,"brief":true,"tokens":1,"exported":2,"mock":0,"check":"complete","candidate":"partial","scaffold":2,"structure":1,"report":1},"pck":2,"unity":"lz4","unityV9":{"blocks":11,"nodes":4},"il2cpp":1}`
- tgz：`docs/aegis/work/2026-11-22-samples/tmp/v9/zhuifengqug-dsh-guoluo-0.24.0.tgz`，95437 B，SHA-256 `0E4032F0C69C561E5B3422F74C6DE403A261F0CD2BEDFE02EF89073B8BA4E577`（tmp 忽略区，不入库）。

## 渲染样例（真实跑一份候选，直接把报告打出来）

```
### 1. `index.html` → `index.html`

- 缺失选择器（3）：`#hero`、`.title`、`.wrap`
- 缺失链接目标（1）：`/pricing`
- 标签数量不足（2）：`img` 证据 1 / 候选 0、`h2` 证据 1 / 候选 0
- 缺失父子关系（2）：`div>img`、`section>h2`
- 深度分布不足（2）：`3:img` 证据 1 / 候选 0、`3:h2` 证据 1 / 候选 0
```

同一份报告头部给 `结构结论 | 有 10 项对不上`、总览表六行数字，末尾独立写出「多出来的选择器、链接与标签不判失败；只报证据有、候选少」。

## 残留

- 报告只覆盖预算内读到并参与比对的页面；未核页面单独列原因，不替它们下结论。
- 报告不含样式、布局、交互与脚本行为，也不含令牌与文件层的明细（那两层在 JSON 回执里）。
