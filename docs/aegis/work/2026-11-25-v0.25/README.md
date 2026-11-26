# v0.25.0 真实 Flutter 应用试跑暴露的四处缺陷

## 为什么做

用真实安装包 `D:\edge下载\OpenWrite-win-x64-Setup-v2.0.6.exe`（OpenWrite 写作助手 2.0.6，Inno Setup + LZMA，39,316,141 B）跑完整链路，暴露的问题不在资产层或 PE 层，而在三处「静默」与一处预算：盘点把 14 个文件直接丢掉、复制上限静默截断、没有页面时三个维度报 0 却不说原因、单文件指纹上限 8 MiB 让 20.3 MiB 的 `flutter_windows.dll` 没有指纹。试跑原始记录见 [`docs/aegis/work/2026-11-23-openwrite/README.md`](../2026-11-23-openwrite/README.md)。

## 改了什么

1. **未识别类型不再消失**（`lib/inventory.mjs`）。`file()` 从 `if (!type) return;` 改成 `const type = unity ?? types.get(extension) ?? 'other';`，这类行照常输出路径、字节数、`extension` 与预算内的 SHA-256，并计入 `counts.untyped`；`notes` 追加「N 个未识别类型的文件已标为 other，保留路径、大小与预算内的 SHA-256。」。识别表本身没有扩充——扩表是猜类型，标 `other` 才是事实。
2. **指纹预算按需**（`lib/paths.mjs`、`lib/inventory.mjs`、`lib/projects.mjs`）。新增 `maxAssetHashFileBytes = 32 * 1024 * 1024`，盘点与候选扫描的单文件上限都改成它；总量仍 256 MiB。预算不足时 `counts.skippedAssetHashes` 逐条累加，`notes` 写出条数与两个上限，不再静默留空。
3. **复制预算可调 + 超限可见**（`lib/scaffold.mjs`、`lib/projects.mjs`、`index.js`）。`guoluo_scaffold` 新增 `files` / `fileBytes` / `totalBytes` 三个入参，默认仍是 512 / 8 MiB / 64 MiB，硬上限 4096 / 32 MiB / 256 MiB（`scaffoldHardLimits`），越界按「需为 1–N 的整数」拒绝且不落目录。被预算挡下的素材逐条进 `skipped`，`warnings` 给出计数与「调高对应上限」，回执与 `_scaffold/scaffold.json` 都带 `budget: {files,fileBytes,totalBytes,hit,blocked}`。
4. **空集说明**（`lib/scaffold.mjs`、`lib/check.mjs`、`lib/spec.mjs`）。`planScaffold` 返回 `web: {pages,styles,tokens,applicable}`；`applicable` 为 `false` 时 `warnings` 明写「结构、令牌与导航维度是空集而不是核对通过」。`checkCandidate` 的 `note` 在 `structure.evidencePages === 0` 时补同一句。`buildSpec` 探测到 `flutter_assets/AssetManifest.bin` 或 `isolate_snapshot_data` 时把「Dart AOT、快照与 Flutter 资源清单仅保留文件级证据」写进 `unknowns`。

## 验收

三 env 全开（`GUOLUO_TEST_UNITY_V9=docs/aegis/work/2026-11-22-samples/tmp/v9/unity-6.7.0b2-scenes-v9`、`GUOLUO_TEST_IL2CPP=docs/aegis/work/2026-11-22-samples/tmp/meta-2020.3.12.dat`、`GUOLUO_TEST_REA=D:\Tools\bin\rea.cmd`）：

- `npm run test:serial` → **164 tests / 164 pass / 0 fail / 0 skipped**（v0.24 为 158）。新增 `tests/untyped.test.mjs` 6 条：other 类型保留路径/扩展名/指纹与 note、指纹预算计数、预算调高后全部搬过来（`capped` 2 条 / `blocked 3`，`raised` 5 条 / `hit false`）、预算入参越界拒绝且不落半截目录、无页面时骨架与候选核对的空集说明、有页面时不出现该说明。
- `npm run check` → 28 文件，package **97.2 kB**，unpacked **311.6 kB**，shasum `021143daab937d7bb241428b5654928f0f79a8d2`。
- 隔离 DSH 冷启动（`node tests/host-smoke.mjs 'D:\deepseek HARNESS\resources\app\dsh\node_modules' docs/aegis/work/2026-11-22-samples/tmp/v9/package-0.25.0`）退出码 0：`{"result":"passed","version":"0.25.0","tools":13,…,"derived":{…,"check":"complete","candidate":"partial","scaffold":2,"structure":1,"report":1},"pck":2,"unity":"lz4","unityV9":{"blocks":11,"nodes":4},"il2cpp":1}`。tgz 97,160 B，SHA-256 `2FC432F96ABFD3F5E3AB9FD0333515E84416E697F50AC16E95CB872C1D8DF901`（在忽略的 tmp 区，不入库）。

真实应用复跑（同一份 innoextract 结果在 `2026-11-23-openwrite/tmp/src`，隔离 DSH profile `guoluo-v025`，同一驱动脚本多跑一次带预算的 scaffold 做对比；本次的 archive 与驱动脚本属一次性产物，已在收尾删除）：

| 指标 | v0.24 | v0.25 |
| --- | --- | --- |
| 盘点行数 | 1718 | **1732** |
| `coverage.untyped` | 不存在（14 个文件被丢） | **14** |
| `hashedAssets` / `skippedAssetHashes` | 1717 / 0 | 1732 / 0 |
| `flutter_windows.dll`（21,274,112 B） | 无指纹 | `8bd7b61eee31aa43…` |
| 复制（默认预算） | 512 + 4，`skippedCount 1195`，无告警 | 512 + 4，`skippedCount 1195`，`budget.blocked 1195` + 告警 |
| 复制（预算拉满） | — | **1707 + 4**，`skippedCount 0`，`budget.hit false` |
| 名称清单里 `asset` 义务 | 1718 | 1732（全量对上 1732 = 1732） |

- 默认预算回执：`budget {files:512,…,hit:true,blocked:1195}`，`web {pages:0,styles:0,tokens:0,applicable:false}`，两条 warnings（预算未复制 1195 / 没有 HTML 页面）。
- 拉满预算回执：`copied 1707`、`generated 4`、`bytes 18,328,280`、`skippedCount 0`、`hit false`，`coverage.assets {total:1732,present:1707,missing:25}`——缺的 25 个正是 14 个 `other` 加 10 个 `library` 与 1 个 `executable`，非预算所致，属「非静态可复刻类型」，`note` 同时带空集说明。
- 批次耗时：dissect 27,962 ms，全链 36,758 ms。`spec.counts` = `{asset:1732}`，`unknowns` 6 条（含 Flutter 快照那条）。

## 残留

- Dart AOT（`app.so`、两份 snapshot）仍未解析：本切片只把它们从「被丢掉」改成「有路径、大小与指纹」，不反编译 Dart。
- `other` 类型不进 scaffold 复制类型集合，是刻意的：`.so`/`.dat`/`.bin` 不是可直接回放的静态素材，覆盖度照实记缺口，而不是把它们塞进工程当成品。
- 默认真实样本仍需 env var（`GUOLUO_TEST_UNITY_V9` / `GUOLUO_TEST_IL2CPP` / `GUOLUO_TEST_REA`）开启；仓库仍无 CI。
