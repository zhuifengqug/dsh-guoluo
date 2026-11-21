# v0.10.0 — 预算决定、差异三项硬校验、UnityFS LZ4 块信息

## 目标

按 G 在 m02821 的决定收口三件事，再补一项剩余缺口：

1. APK 清单采集预算改为每类 512 条、单类 256 KiB。
2. 16 位与隔行 PNG 保持现状（该档 blocked，不出分，不降级）。
3. 视觉核对的最大通道差值与平均绝对通道差值升级为硬校验，与变化像素数一并逐项交叉核对。
4. 剩余缺口之一：UnityFS 块信息段支持 LZ4/LZ4HC，由插件自行解压后解析块表与节点表。

## 交付

- `lib/apk.mjs`：`MANIFEST_RETAIN` 512、`MANIFEST_RETAIN_MAX` 2048、`MANIFEST_RETAIN_BYTES` 256 KiB。
- `lib/inventory.mjs`：`limits.apkPermissions`/`limits.apkActivities` 512、`limits.apkManifestBytes` 256 KiB；Unity 说明改为「块信息段（未压缩或 LZ4/LZ4HC 压缩）」。
- `lib/visual.mjs`：新增 `diffs` 汇总，`changedPixels`、`maximumChannelDelta`、`meanAbsoluteChannelDelta` 三项任一与 REA 不符即该档 `conflict`，`round.conflict.fields` 列出全部不符字段，`round.conflict.diffs` 保留逐项两边数值；`field`/`rea`/`computed` 仍指第一处不符，兼容既有读取方。路由与整体 reason、结论 note 同步改成「差异数值」口径。
- `lib/unity.mjs`：新增 `lz4BlockDecompress(src, expectedSize)`（token 高/低 4 位、15 扩展步长、自重叠回填、越界与长度不符均报错）。`inspectUnityfs` 对 `compressionCode` 0/2/3 分别读取或解压块信息段；LZMA(1)、LZHAM(4) 仍标 `unobserved` 并写明暂未支持；解压或解析失败直接报错，不返回半张表。
- `lib/spec.mjs`：Unity unknown 与 Markdown 说明改为 LZ4/LZ4HC 已覆盖，LZMA/LZHAM 与节点内容、IL2CPP 字段表仍是缺口。
- `README.md`、`skills/guoluo-rebuild/SKILL.md`：同步 Unity 与视觉口径；APK 预算写明 512 条 / 256 KiB。

## 关键实现约束

- 差异三项都必须来自插件对落盘 PNG 的独立解码，不以 REA 数字为结论；`mean` 用 1e-9 容差比较。
- LZ4 只解块信息段（表），不解数据块；节点内容仍是缺口，`payload.status` 保持 `unobserved`。
- LZ4 解压前先按 `limits.tableBytes`（4 MiB）拒绝压缩与解压长度，避免按声明分配超大缓冲。

## 验证

- `npm test`（无真实 REA/Chrome）：97 项父级，95 通过、2 跳过（真实 REA 视觉用例）。
- `$env:GUOLUO_TEST_REA='D:\Tools\bin\rea.cmd'; npm run check`：**97 项全过 0 失败 0 跳过**（含两条真实 REA 三档视口用例），打包 23 文件 64.5 kB / 解压 200.8 kB。
- LZ4 交叉验证：`tests/fixtures/unityfs-lz4-tail.bundle` 由 UnityPy 1.25.4 `BundleFile.save('lz4')` 写出，插件解压后得到 `assets/demo/data`（偏移 0、大小 14、flags 4），与 UnityPy 回读一致。
- 隔离宿主冷启动：从 `deliverables/zhuifengqug-dsh-guoluo-0.10.0.tgz` 离线安装到临时前缀，`node tests/host-smoke.mjs "D:\deepseek HARNESS\resources\app\dsh\node_modules" <解包目录>` →
  `{"result":"passed","version":"0.10.0","tools":11,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,"rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified","derived":{"spec":2,"tokens":1,"exported":2,"mock":0,"check":"complete"},"pck":2,"unity":"lz4"}`，其中 `unity` 字段取自 LZ4 解压后的块信息。

## 未验证与边界

- LZMA/LZHAM 压缩的块信息段、UnityFS 数据块解压与节点内容仍未覆盖。
- IL2CPP 仅版本与头布局证据，字段表未解析。
- 加密 PCK 条目实际存储区间未核验。
- 16 位与隔行 PNG 仍整档 blocked；未做降级路径。
- 全量套件在高并发下有一次性偶发失败（某档 `kind: environment`，单独重跑与后续两次全量均通过），未定位到确定原因。

## 校验和

- `deliverables/zhuifengqug-dsh-guoluo-0.10.0.tgz`，64 505 字节，SHA-256 `2213A6FFE0570B0E8E80436DDF371811E79BC863E53E855F5BB588723D5BF9AE`。
