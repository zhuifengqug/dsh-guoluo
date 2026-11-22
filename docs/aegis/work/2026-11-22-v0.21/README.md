# v0.21.0：UnityFS v9 块偏移与节点指纹

## 目标

在找到真实 UnityFS format 9 文件并以 UnityDataTool 2.3.0 独立解析后，实现 v9 块表读取；保持 v6–v8 的读取与输出兼容，format 10 及以上继续只保留头部事实。二进制样本留在忽略的 `docs/aegis/work/*/tmp/`，不进入包或仓库。

## 样本与独立基准

- 来源仓库：`Unity-Technologies/UnityDataTools`
- 合并 PR：[#128](https://github.com/Unity-Technologies/UnityDataTools/pull/128)，标题 `Read storage block offsets from the archive BlocksInfo (format version 9)`；merge commit `431100547f62b047e682bbd4ca0e03e31ee8126a`
- 固定样本 commit：`8b8e0fe65264ac6595c9d1eb37ab80ea9ab95c08`
- 路径：`TestCommon/Data/LeadingEdgeBuilds/AssetBundlesLz4/scenes`
- 下载地址：`https://raw.githubusercontent.com/Unity-Technologies/UnityDataTools/8b8e0fe65264ac6595c9d1eb37ab80ea9ab95c08/TestCommon/Data/LeadingEdgeBuilds/AssetBundlesLz4/scenes`
- 样本：362352 B，SHA-256 `fb116ff6e0e455d2d063dc6f71d05ffa3bf4b6d914c87918bfacd246d6c3b22a`，UnityFS v9，Unity `6000.7.0b2`
- UnityDataTool 2.3.0 给出 11 个相对 `dataStart` 的块偏移：`[0, 6352, 136624, 221360, 264880, 296080, 312048, 348976, 349312, 355344, 356032]`；`dataStart=288`。块间 9 段共 80 B，全部为零填充。
- 官方工具独立提取的节点 SHA-256：`BuildPlayer-Scene1.sharedAssets` `903228b4c44c540c9480d871223edde4049957390532eb39c8f0b2b6058dfa72`；`BuildPlayer-Scene1` `6cb03b57ba3f6667c18eca8625d227d7a376c38d26cb135055dd1abc0f7512ba`；`BuildPlayer-Scene2.sharedAssets` `5b8c30385c93aeaf34107ba5f223727b1bb168af4bd40b344da29a323e202c13`；`BuildPlayer-Scene2` `5229c0310ec19ef66b1e192003fb5dbe28bd1ca7d4680b058a2e6bfcd586f24e`。
- UnityPy 1.25.4 不支持该 v9 存储布局，因顺序解压将填充并入块而失败；独立成功基准为 Unity 官方 UnityDataTool 2.3.0。

## 实现与回归

- v9 每个既有 10 B 块项后解析一个大端 u64 存储偏移。偏移相对数据区起点，偏移必须有序且不重叠，压缩块区间必须完全落在数据区内；逻辑节点偏移仍相对解压拼接后的数据。
- v6–v8 沿用压缩长度累加，不改变既有输出字段。v10+ 保持头部事实、块表 `unsupported`、节点未解析。
- 合成回归包含块间填充、节点 SHA、偏移重叠、u64 极值与块尾越界。
- 真实样本回归固定长度、SHA、Unity 版本、11 块偏移、80 B 零填充、4 节点路径/长度与逐项 SHA。
- 隔离 DSH smoke 接受 `GUOLUO_TEST_UNITY_V9` 后，以实际加载的打包插件调用 `target_add → dissect → dossier`，重复核对全部 11 个偏移与 4 个节点哈希；没有此变量时仍跑原有 smoke。

## 复现

```powershell
$env:GUOLUO_TEST_UNITY_V9='[下载至本机的 scenes 文件路径]'
npm run check
node tests/host-smoke.mjs '[DSH node_modules 路径]' '[npm pack 后解压的包目录]'
```

## 验收记录

全套回归（`GUOLUO_TEST_UNITY_V9` + `GUOLUO_TEST_IL2CPP` + `GUOLUO_TEST_REA` 同时生效）：

```text
# tests 133
# pass 133
# fail 0
# skipped 0
# duration_ms 136687
```

其中包含官方 v9 样本用例（11 块偏移、80 B 零填充、4 节点 SHA）、新增「UnityFS v9 显式偏移与 LZ4 数据块、尾置表同时生效」用例、真实 IL2CPP 样本与两条真实 REA 用例；没有跳过项。

打包（`npm pack`）：26 文件，package size 81.6 kB，unpacked 260.0 kB，shasum `27fe4566dfb4d49fc281ce54cda6ea255f99d171`。`tests/` 不进包，测试改动不影响包内容。

隔离 DSH smoke（`node tests/host-smoke.mjs 'D:\deepseek HARNESS\resources\app\dsh\node_modules' <解包后的包目录>`，退出码 0）：

```json
{"result":"passed","version":"0.21.0","visual":{"status":"measured","routes":2,"scores":[1,1]},"tools":12,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,"rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified","derived":{"spec":2,"brief":true,"tokens":1,"exported":2,"mock":0,"check":"complete","candidate":"partial"},"pck":2,"unity":"lz4","unityV9":{"blocks":11,"nodes":4},"il2cpp":1}
```

独立复审（`unityfs-review`）：无阻断缺陷，可提交；核心逻辑与 AssetStudio（commit `1f2bc05`，Unity 6.7+）布局一致。已按意见补 v9 + LZ4 + 尾置表用例，并把官方样本用例的跳过改为可读理由。

提交：`main` 上的 `feat(guoluo): read UnityFS v9 block offsets from the block table`（v0.21.0）。

残留缺口（不随本版关闭）：官方 v9 样本与真实 IL2CPP 样本默认由环境变量开启，常规 `npm run check` 不执行这两条外部锚点；format 10 及以上仍只保留头部事实，没有真实头样本可核；v9 偏移的 16 字节对齐未作硬性断言（公开实现未证明该约束对所有写入器成立）。
