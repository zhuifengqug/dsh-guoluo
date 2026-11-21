# 蜾蠃 v0.16.0 — UnityFS LZMA 块解压

## 目标

v0.11–v0.12 只能解 `none` / `lz4` / `lz4hc` 的 UnityFS 块，遇到 LZMA 压缩的块信息段或数据块只能标「未观测」。这一片把 LZMA 也做进插件自己的解码路径，不再依赖 REA 或外部工具，并且**由插件自己解出字节**，不是声明「已支持」。

## 交付内容

1. 新增 `lib/lzma.mjs`：`lzmaBlockDecompress(source, expectedSize, { maxOutput, signal })`。
   - 解析 Unity 的块内布局：1 字节属性（lc/lp/pb）+ 4 字节 LE 字典大小 + 原始 LZMA1 流；长度以块表声明为准，不依赖流内结束标记。
   - 完整实现 LZMA1 解码：区间解码器、字面量（含 state≥7 的匹配字面量）、新匹配、重复匹配（rep0–rep3 与 shortRep）、低/中/高位长度、位置槽、对齐 reverse bit 树。
   - **两套独立的长度概率表**：新匹配用 `lengthTable`，重复匹配用 `repLengthTable`。共用一张表会让「新匹配之后的下一个 token」整段错位，这是本片最隐蔽的一个坑。
   - 位置解码基址 `posDecoders` 按 `distance - slot - 1` 取，与参考实现一致；差一格会让距离解错但仍能吐出字节。
   - 拒绝面：属性字节 ≥225、lc+lp>4、字典 <4096、头部不足、解压长度超出 `maxOutput`、匹配距离越出已解压区间、匹配长度超出声明大小、提前结束。
   - 每 0x3fff 字节检查 `AbortSignal`，可按宿主取消。
2. `lib/unity.mjs` 接入：
   - `payloadCodecs` 增 `lzma`；
   - `extractPayload` 按块的 `compression === 'lzma'` 走 `lzmaBlockDecompress`，上限仍是 `payloadDecodedBytes`（256 MiB）；
   - `inspectUnityfs` 的 `blocksInfo.compressionCode === 1` 分支走 `lzmaBlockDecompress`，上限 `tableBytes`；
   - LZHAM（codec 4）仍是 `unobserved` + 「暂未支持」。
3. 文档：`lib/spec.mjs` 的 unknowns 与 Markdown 证据表、`lib/inventory.mjs` 的 note、`README.md` 的 Unity 段、`skills/guoluo-rebuild/SKILL.md` 第 3 步，把「LZMA/LZHAM 未观测」收窄为「只剩 LZHAM」。README 同时写明 UnityFS 压缩类型现在覆盖 `none/lz4/lz4hc/lzma`。

## 验证

- `tests/lzma.test.mjs`（新增）：4 组由 Python 3.12 `liblzma` 以 `FORMAT_RAW + FILTER_LZMA1` 独立压缩的向量，逐档断言解压结果的 SHA-256；其中 `repChain`（`b"ab"*100`，200 字节）正是「漏掉重复匹配长度表」的反证向量。另含 `lc0/lp2/pb1` 的非默认属性档、随机数据档、900 字节单字节重复档，以及空流、上限、短头、属性非法、字典过小、声明长度不符、取消等拒绝用例。
- `tests/unity.test.mjs`：新增「UnityPy 写出的 LZMA 包由插件自行解压块信息与数据块」，用两个 UnityPy 1.25.4 生成的夹具断言块信息段（46→71）与数据块（4110→291）都由插件解出，两个节点 SHA-256 与 Python 侧一致；原来的「LZMA 与 LZHAM 仍标未观测」收敛为「LZHAM 仍标未观测」。
- 夹具可复现：`tests/fixtures/make-unityfs.py` 新增 `write_lzma()`，一次生成 `unityfs-lzma.bundle`（140 B）与 `unityfs-lzma-data.bundle`（438 B），并在生成时用 UnityPy 回读校验。
- 全量：`GUOLUO_TEST_REA=... npm run test:serial` → 116 项全过 0 失败 0 跳过（含两项真实 REA 三档视口用例）。
- 打包：25 文件 75.5 kB / 解压 238.2 kB。
- 隔离宿主：从本包 tarball 离线安装后冷启动 → `{"result":"passed","version":"0.16.0","tools":12,...,"unity":"lz4"}`。

## 未验证与边界

- LZHAM（codec 4）仍未实现；Unity 已从引擎移除，UnityPy 也是 `NotImplementedError`，等真实样本再排。
- UnityFS 格式版本 9 起的块表布局仍未核对（AssetStudio 会多读一个 `u64` 偏移，UnityPy 仍按 10 字节读），遇到直接拒绝，不猜。
- LZMA 只覆盖 Unity 资产包的裸 LZMA1 块；独立 `.lzma` 容器（13 字节头、流内带长度）不在此范围内。
- 节点内容仍只记大小、SHA-256、类型魔数与 24 字节前缀，不保存内容。
- IL2CPP 元数据仍只到头部证据，字段表未解析。
- 加密 PCK 条目的实际存储区间仍未核验。

## 校验和

- `deliverables/zhuifengqug-dsh-guoluo-0.16.0.tgz`
  - 字节数：75527
  - SHA-256：`1454627EED6B93DE401080C05CE4C61039293951EE689509184A62AB43BFC049`
