# v0.26.0 · 一条命令跑完整链（guoluo_run）

日期：2026-11-26
上一版：0.25.0（`7013ffb`）

## 为什么做

前面十三步工具各自都成立，但要把一份应用跑成能开工的东西，得按顺序手调七八个工具、自己记住每份产物落在哪。这一刀把这条链压成一次调用，并交出一个人读的入口文件——这是「成品」的第一件：装得上、跑得动之前，先要「一趟跑完、结果在一处」。

## 做了什么

新增 `guoluo_run`（14 个工具里的第 14 个），落在 `lib/projects.mjs` 的 `projectService` 闭包里，编排已有的内部函数，不复制它们的逻辑：

1. `dissect`（给 `runId` 则整步记 `reused`，不重新盘点）
2. `spec`
3. `brief`
4. `tokens`
5. `export`（json）
6. `scaffold`（素材是单文件或 URL 登记时记 `skipped` 并写明原因，不算失败）
7. `check`（可带 `candidate` 一并核候选工程，可带 `visual` 走视觉档）
8. `pack`（在 `<id>/pack/<批次>/` 下写 `INDEX.md` 与 `pack.json`）

其中 `dissect` 在没有 `runId` 时先在超时包装里跑完盘点，再按盘点**刚返回的** `runId` 加载批次——不按「最新」重读，否则并行或随后又盘一次就可能把索引绑到别人的证据上。显式给 `runId` 时同样在包装内加载，失败也能报出「第 1 步」。`scaffold` 在素材不是目录时记 `skipped`（单文件与 URL 各写各的原因），不是失败。

新增 `lib/pack.mjs` 负责渲染，只有汇总与排序，不新增事实：

- `renderPackIndex(...)`：结论一句话 → 步骤表 → 「先看什么」阅读顺序 → 证据事实（totals、类型分布、令牌、骨架文件数）→ 缺口与待确认（规格 unknowns、骨架 warnings、未进骨架条数、候选核对口径、盘点备注原文）→ 五步复刻路径 → 产物清单（含每份文件用途）→ 口径。
- `summarizePack(...)`：`pack.json`，`schemaVersion: 1`，含每步状态/耗时/产物、totals、coverage、spec 计数、scaffold 汇总（含 `coverageVerdict`）、check 与候选结论。
- 上限：缺口 20 条、告警 10 条、类型 24 个；超出的写明「另有 N 条」，完整清单仍在 `spec.json`。

### 包的落盘布局：每趟一个不可变批次目录

`pack/` 之下是 `<批次>/`（`<13 位毫秒时间戳>-<uuid>`），一个批次目录里只有 `INDEX.md` 与 `pack.json` 两份，写完才 `rename` 成正式目录。选择这个布局而不是固定写 `pack/INDEX.md`，理由有三条：

1. 固定路径只能覆盖写。写 `INDEX.md` 与 `pack.json` 是两次调用，中间失败或被取消就留下「新索引 + 旧汇总」的混合状态；「旧索引还在但不算这次结果」在文件系统上无法成立，读者没有依据分辨哪份是这次的。
2. 不可变目录让每份结果自证，也允许重跑留档对比；这与盘点「一份证据一个批次文件、不覆盖历史」的既有约定一致。
3. 保留 `pack/` 父目录名，引用路径只多一层，改动局限在渲染与读盘两侧。

代价是索引里的相对链接要多跳一层，因此 `renderPackIndex` 增加 `rootPrefix` 参数（run 传 `'../..'`），产物清单、缺口引用与「怎么复刻」里的路径全部由它拼，不再写死 `../`。发布走 `lib/pack.mjs` 的 `publishPack()`：建 `.new-<批次>` → 两次 `flag:'wx'` 写入 → `rename` 就位，任何一步抛错都把暂存目录整个删掉。

失败语义：任何一步抛错就停下，包成「复刻包在第 N 步「name」停下：原因」，附 `stage` 与 `cause`；`pack` 一步失败时暂存目录删除，**已经写好的旧包原样保留**。同一档案不允许两趟盘点并发（盘点锁报「这个档案已有盘点在运行。」），所以并发不会产生两个互相矛盾的包。

`spec` 回执新增 `gaps`（`built.spec.unknowns` 原样数组），索引直接引用，不再二次拼文案。

## 验收

三 env 全开（`GUOLUO_TEST_UNITY_V9`、`GUOLUO_TEST_IL2CPP`、`GUOLUO_TEST_REA`）：

- `npm run test:serial` → **172 tests / 172 pass / 0 fail / 0 skipped**（117.9 s）
- `npm run check`（不带 env，跳过 4 条真实样本用例）→ 172 tests / 168 pass / 0 fail / 4 skipped；29 文件、package 104.6 kB、unpacked 335.3 kB、shasum `110da344ba12398d04189b873fd2c2f1c24dadf3`
- 隔离 DSH smoke（`node tests/host-smoke.mjs 'D:\deepseek HARNESS\resources\app\dsh\node_modules' docs/aegis/work/2026-11-22-samples/tmp/v9/package-0.26.0`）退出 0：
  `{"result":"passed","version":"0.26.0","visual":null,"tools":14,…,"derived":{…,"run":8},"pck":2,"unity":"lz4","unityV9":{"blocks":11,"nodes":4},"il2cpp":1}`
- tgz 104,637 B，SHA-256 `A32B52E394ECB83A60CBAD55F0BBA8A1D8A0843B28B4BB1D8D2F750CF73BFE97`

新增 `tests/pack.test.mjs` 8 条：

- 全链落 `INDEX.md` 与 `pack.json`，八步全 `ok`，索引含七个段落与 `../../` 相对路径，回执 `directory` 形状为 `<id>/pack/<批次>`
- 重跑落到独立批次目录，旧包原样保留（两份索引各指自己的骨架，`pack/` 下没有摊平的 `INDEX.md`）
- 给 `runId` 时首步 `reused` 且不新增批次
- 单文件素材 `scaffold` 记 `skipped`（含原因），索引写明「这一步没有生成骨架」
- URL 档案跑 `run` 报「第 1 步「dissect」停下」，且 `pack/` 目录不存在
- 后一趟在 `scaffold` 失败时旧包字节不变、没有残留 `.new-*` 目录、批次目录仍只有一个
- 同一档案并发两趟：一趟成功、一趟被盘点锁挡在 `dissect`，只产生一个包
- 带 `candidate` 时同一趟出候选结论与结构报告，索引列出报告

同步：`tests/dossier.test.mjs` 工具计数 13 → 14（含 `run`）；`tests/host-smoke.mjs` 工具数组 14 项、新增 `run` 实跑断言（八步、首步 `reused`、索引段落、`pack.json` runId 与步数）、回执加 `derived.run`；`dsh-plugin.naming.json` 补 `guoluo_run`；`/guoluo` 命令加 `run <id>` verb；README 加「一条命令拿成品」段与产物表 `guoluo_run` 行；`skills/guoluo-rebuild/SKILL.md` 加第 0 步。

## 边界（没有变）

- `run` 只是编排：不新增盘点能力，不执行目标代码，不开浏览器（除显式 `visual`），不碰候选工程的路径边界。
- `INDEX.md` 里的「能开工」指证据齐、骨架已落、缺口已列，**不表示目标已被复刻**，也不表示样式/布局/脚本行为等价。
- 单文件素材、URL 登记、无 HTML 页面的批次仍不做骨架 / 结构 / 令牌 —— 索引与 `warnings` 都写明这是空集而不是通过。

## 残留

- Desktop profile 尚未装本插件（刀 B），真实样例的 `pack/` 留档与 `v1.0.0` tag（刀 C、D）在后续提交。
- `pack.json` 里 `pack` 这一步的 `durationMs` 为 `null`：索引先于写完才能知道自身耗时，回执里给的是实测值。