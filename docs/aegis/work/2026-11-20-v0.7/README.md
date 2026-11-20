# v0.7.0 — Godot PCK 离线静态盘点

> **已被 v0.8 更正。** 本记录里「按顺序游标读 PCK 头（…保留区；format 2 追加 `packFlags` 与 `fileBase`）」的顺序与引擎实际布局不符：`pack_flags`/`file_base` 在保留区**之前**，v3/v4 还有 `dir_offset`，且 v2 起路径长度已含补零。当时的测试夹具复刻了同一错误布局，所以测试全绿也没暴露。以 `docs/aegis/work/2026-11-21-v0.8/README.md` 与 `lib/pck.mjs` 的实际实现为准。

## 目标

让 `guoluo_dissect` 接受 `.pck`，把 Godot 导出的资源包读成可回查的证据：包格式、引擎版本、条目清单、加密标记、场景/脚本/资源计数，并进入 spec 与 mock 的说明面。不解压条目内容、不解密加密条目、不运行游戏。

## 交付

- 新增 `lib/pck.mjs`：按顺序游标读 PCK 头（magic `GDPC`、pack format 1/2、major/minor/patch、保留区；format 2 追加 `packFlags` 与 `fileBase`），逐条读文件表（路径长度、路径、4 字节对齐、offset、length、16 字节 md5、format 2 的 per-entry flags）。路径按 UTF-8 fatal 解码并拒绝控制字符、反斜杠与 `..` 段；非加密条目校验 `offset+length` 不越界；按扩展名统计 scenes / scripts / resources。
- `lib/inventory.mjs`：新增 `pck()` 分支，把命中类型的条目登记为 `{kind:'asset', archive:'pck', encrypted?}`，并返回 `{engine, packFormat, counts, declaredBytes}`。
- `lib/spec.mjs`：`spec.evidence.pck` 投影（engine/packFormat/counts/declaredBytes）；Markdown 证据表加三行；`unknowns` 增固定条目「PCK 只读包头与文件表……」。
- `lib/mock.mjs`：PCK 成员进 `unreplayed`，原因「PCK 归档成员，未解包，不回放」。
- `lib/projects.mjs`：`pluginVersion` → `0.7.0`；登记正则与错误文案接受 `.pck`。
- `index.js`：`guoluo_dissect` 描述补 Godot PCK。
- `tests/pck.test.mjs`：4 项——format 2 全字段与计数；format 1 与 `packFlags:2` 相对基址；坏 magic / 未知格式 / 越界条目 / `../` 路径四类拒绝；端到端登记→盘点→规格→mock 说明。

## 关键实现约束

- 只读包头与文件表，绝不读条目数据；加密条目只标 `encrypted: true`，不做范围越界判断。
- 路径校验先于任何使用，`..`、控制字符、反斜杠一律拒绝，避免归档内路径污染档案路径。
- 顺序游标读取，任何一次 `take()` 超出文件长度都抛错，不返回半份清单。

## 验证

- `npm test`：42 项，40 通过 2 跳过（真实 REA 用例按需）。
- `npm run check`：21 个文件，43.1 kB（解包 131.4 kB）。
- 隔离宿主 `node tests/host-smoke.mjs <DSH node_modules> <包目录>`：`{"result":"passed","tools":11,...,"linkedRea":"verified",...}`。

## 未做与边界

- 不解压 PCK 条目，因此 PCK 里的 HTML/CSS 不能进入页面证据；需要时先解包成目录再单独登记。
- 不解析 `.tscn`/`.tres` 结构，不还原场景树与脚本依赖。
- 不识别 Unity 资产包（UnityFS / IL2CPP），排在后续切片。

## 校验和

- `docs/aegis/work/2026-11-20-v0.7/deliverables/zhuifengqug-dsh-guoluo-0.7.0.tgz`
- SHA-256：`4B641A638CD43257AE65DCBCEC39B0B6ED4C031BD795296F5104174F66B4A005`（43134 字节）
