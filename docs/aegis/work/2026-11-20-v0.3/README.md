# 蜾蠃 v0.3.0 · REA 自动调用与证据绑定

## 目标

把 REA 从"人工提供摘要、来源未校验"改成插件自动调用：`guoluo_dissect` 对目录型素材直接跑 `rea analyze-javascript-application`，拿到证据包并写进档案，再用八项检查把摘要与本次素材绑定。绑定不通过就不给行为侧结论。

## 交付

- `guoluo_dissect` 参数由 `reaSummary` 改为 `rea`（布尔，默认开启）与 `reaTimeoutMs`（10000–1800000）。批次 `schemaVersion` 升到 2，新增 `rea` 字段与 `meter`。
- 目录素材：把证据包写到 `<id>/rea/<runId>/evidence.json`，返回 `{status:'analyzed', version, binding, artifactSha256, evidenceId, parentEvidenceId, stats, evidence:{path,bytes}}`。
- 单文件、ASAR、URL 档案不触发 REA：分别记为 `skipped`（只接受目录，需先解包）与 `off`（用户显式跳过）；REA 不可用记 `unavailable`；调用出错记 `failed`，并把原因写进批次 `notes`，静态盘点结果不受影响。
- 绑定检查（`verifyBinding`）：`view-shape`、`view-digest`、`evidence-readable`、`parent-operation`、`artifact-path`、`parent-root-digest`、`view-root-digest`、`evidence-bytes`。全过为 `verified`；任一不过为 `mismatch`，并清空 id/hash 字段。
- `guoluo_spec` 的 `unknowns` 按 REA 状态生成：没有 REA 证据就明确写"函数级行为、模块依赖与配置读取不在本批证据内"；有摘要但绑定不通过，写"未给出可采信的行为侧证据"。`spec.md` 的证据范围表新增 REA 状态、绑定、根哈希、已解析 JS 文件四行。
- `guoluo_check` 增加 `rea` 字段；`analyzed` 但 `binding !== 'verified'` 计入 `blocked`，并给出"摘要未能绑定到本次素材"的说明。
- 新增可配置项 `reaTimeoutMs`（默认 180000），全部叶子仍标 `volatile`。

## 关键实现约束

- REA 的 `root_artifact_sha256` 是确定性的，但**前提是证据包输出到被分析目录之外**。实测把 `evidence.json` 写进被分析目录会让目录内容变化、哈希漂移（`1cdda2a9…` → `dce9cd2e…`），字节数也从 55688 变 58474。实现里素材根与档案根互不包含，天然满足。
- REA stdout 是 NDJSON，最后一行才是 `{"summary":…,"evidence_bundle":{path,bytes}}`；`evidence_bundle` 在顶层，不在 `summary` 里。磁盘证据包的记录在 `records[0]`，只有 `subject.local_path`、`subject.digest.sha256`、`normalized_result.root_artifact_sha256`，没有 `normalized_result.artifact`。
- 调用走 `shell:false`，Windows 上只认 `.exe`、`.mjs` 或符合固定格式的 Node 启动器，避免把用户参数交给 cmd shell；stdout 上限 32 MB、stderr 上限 64 KB。

## 验证

- `npm test`：22 项回归全过。新增 `tests/rea.test.mjs` 覆盖绑定逐项通过、路径不符、根哈希矛盾、证据字节不符、证据包缺失、非零退出/无摘要/超时。
- `npm run check`：22 项全过，打包 17 文件 26.0 kB。
- 隔离宿主（真实 DSH 0.2.2-rc.5）跑通：

```
{"result":"passed","tools":11,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,
 "rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified",
 "derived":{"spec":2,"tokens":1,"exported":2,"mock":0,"check":"complete"}}
```

## 未做与边界

- 未改 Desktop profile，界面未做目视验收。
- 未生成复刻工程骨架；未做截图比对与视觉还原；未接 APK/EXE/Unity/Godot/craft-anything 后端。
- ASAR 仍只盘点头部目录；URL 仍只登记出处，不发请求。
- REA 只接受目录；ASAR 与单文件需先解包再登记。
- `check` 的 `complete` 只说明规格与证据自洽，不说明目标已被复刻。

## 校验和

`deliverables/zhuifengqug-dsh-guoluo-0.3.0.tgz`
SHA-256 `BB127AC1D6B9563B389B437A17FFB117C4C9B25F69C539E457493729A17DC8E4`
