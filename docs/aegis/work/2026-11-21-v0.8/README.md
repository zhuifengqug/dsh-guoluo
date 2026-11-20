# v0.8.0 — Godot PCK 真实格式修正 + Unity 头部盘点

## 目标

1. 让 PCK 解析对齐引擎真实格式（v0.7 的实现与官方布局不一致，见「已修正的错误」）。
2. 让 `guoluo_dissect` 接受 Unity 侧素材：`UnityFS` 包与 `global-metadata.dat`，只读头部，进入 dossier / spec / mock 说明面。

## 交付

### PCK 重写（`lib/pck.mjs`）

- 头部按官方顺序读：`magic`｜`pack_format`｜`major`/`minor`/`patch`｜v2+ 的 `pack_flags`(u32) 与 `file_base`(u64)｜v3/v4 的 `dir_offset`(u64)｜16×u32 保留区。v1/v2 目录紧随头部，v3/v4 用 `dir_offset` 跳转。
- 条目：`u32 path_len`（**已含补零到 4 字节倍数**）｜路径字节 + 补零｜相对 `file_base` 的 `u64 offset`｜`u64 size`｜16 字节 MD5｜v2+ 的 `u32 flags`。
- `absolute = file_base + offset` 对 v2+ 无条件成立；v1 的 offset 本身绝对且路径不补齐。
- 目录状态：`pack_flags & 1` → `encrypted`，`& 4` → `sparse`，否则 `parsed`。非 `parsed` 时只记头部与声明条目数。
- per-entry flags：`& 2` 计 `removed` 跳过，`& 4` 计 `delta` 跳过，`& 1` 标 `encrypted`（加密条目不判越界）。
- 拒绝：坏 magic、未知 `pack_format`、条目数超限、路径长度 0/超长、路径填充非零、非 UTF-8、控制字符/反斜杠/冒号/绝对路径/`.`/`..`、条目范围越界、**条目与头部或目录重叠**、读取期间文件变化。

### Unity（`lib/unity.mjs`，新增）

- `unityCandidate(path)`：`global-metadata.dat` → `il2cpp-metadata`；`.bundle`/`.unity3d` → `unity-bundle`。
- `UnityFS`：签名、格式版本（<6 拒绝）、`unityVersion`/`unityRevision`（NUL 终止、≤128、无控制字符）、声明包长、块信息压缩字节数、flags 与压缩码（`none`/`lzma`/`lz4`/`lz4hc`/`lzham`）、`atEnd`。声明包长必须容得下头 + 元数据块且不超过文件长度。
- `global-metadata.dat`：`0xFAB11BAF` 小端标识 + 正的声明版本。
- 只读头部字节（UnityFS 512、IL2CPP 8），前后 `stat` 比对大小与时间戳。

### 接入

- `lib/inventory.mjs`：Unity 分支先于 PE 分支；成功 `{path, kind, status:'header-read', ...facts}`，失败记 `unreadable` 与原因；`unityFiles` 上限 16，超出记 `clipped`。`pck()` 返回 `directoryStatus` 并在非 `parsed` 时加局限说明。
- `lib/projects.mjs`：`pluginVersion` 改为直接读 `package.json`，升版不再需要手改两处；登记判定与错误文案接受 Unity 素材；档案头 `unity` 只给 `{files, headersRead, detail}`；`guoluo_dossier kind: binary` 返回 PE + Unity 逐文件明细。
- `lib/spec.mjs`：`evidence.unity` 投影、Markdown 逐文件行（`UnityFS 6 / 2021.3.16f1` 或 `IL2CPP 声明版本 29`）、PCK 文件目录行、缺失计数显示「未知」、Unity 缺口进入 `unknowns`。
- `lib/mock.mjs`：Unity 素材进 `unreplayed`，原因「Unity 素材仅有头部证据，未纳入回放」。

## 已修正的错误（v0.7 → v0.8）

v0.7 的 PCK 实现与 `docs/aegis/work/2026-11-20-v0.7/README.md` 的描述都与引擎不符，逐条：

1. 保留区读在 `pack_flags`/`file_base` 之前 —— 错位，导致两者恒为 0。
2. `absolute` 的门控错（v2 应无条件加 `file_base`）。
3. 路径补零处理错：v2 的 `path_len` 已含补零，v1 完全不补齐。
4. `/[\x00-\x1f\\]/` 会误杀 v2 的补零字节。
5. 测试夹具复刻了同一错误布局，所以测试全绿也没发现。

第 5 条是本轮最需要记住的教训：**夹具与解析器同源时，测试只能证明自洽，不能证明正确**。本轮因此改成用外部实现产出夹具。

## 验证

- `npm test`：51 项，49 通过、2 跳过（真实 REA 用例按需）。
- **外部夹具（关键证据）**：
  - `tests/fixtures/godot-4.7.2.pck`：由 Godot 4.7.2 自带 `PCKPacker` 直接导出（212 字节）。解析结果 `packFormat 4`、`engine Godot 4.7.2`、`packFlags 2`、`fileBase 128`、`declaredBytes 5`、`files [{path:'ok.txt', bytes:5, offset:128}]` —— 与引擎写出的头部逐字段对应。
  - `tests/fixtures/unityfs-none.bundle`：由 `tests/fixtures/make-unityfs.py` 写出，**先经 UnityPy 1.25.4 回读校验**（版本 6、玩家串、节点可读）后才落盘。本插件读出 `formatVersion 6`、`unityVersion 2021.3.16f1`、`flags 64`、`blocksInfo 71/71 none`，与 UnityPy 视点一致。
- `npm run check`：22 个文件，47.3 kB（解压 145.9 kB）。
- 隔离宿主 smoke：11 个工具、技能、命令、volatile 热更新、REA `verified`、派生链路 `complete`。

## 未做与边界

- PCK：不解压条目、不解密、不解析 `.tscn`/`.tres`。加密或稀疏目录只给头部与声明条目数，`declaredBytes` 为 `null`。
- Unity：只有头部。不解包节点、不解析 IL2CPP 元数据表、不做 IL2CPP 反编译、不生成 `Assembly-CSharp` 视图。`global-metadata.dat` 的版本只被称为「声明版本」，未校验文件长度与该版本应有的表结构是否吻合。
- 仍缺：UnityFS 的 `UnityWeb`/`UnityRaw`/`UnityArchive` 签名、块数据解压、节点表逐项列举。
- APK/PE 复审遗留项（见 v0.7.1 记录）未在本轮处理。

## 校验和

- `docs/aegis/work/2026-11-21-v0.8/deliverables/zhuifengqug-dsh-guoluo-0.8.0.tgz`
- SHA-256：`96AEB13E034929D1032C99AA9D9000F7D3DB9FCE80605A7D775913C578969F06`（47340 字节）