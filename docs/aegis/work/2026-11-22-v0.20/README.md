# v0.20.0 —— UnityFS v9 只保留头部事实

## 目标

按 G 的裁决处理第三项：UnityFS 格式版本 9 的块表。裁决原文：「第三条你去网上随便找一个」——先找到真实 v9 包再做核对。

## 找样本的过程与结论

先查实现，再决定是否值得花时间找包。

1. `https://raw.githubusercontent.com/morluto/rea/main/docs/unityfs.md` 原文：「Header format versions 6 through 8 are supported. Version 9 adds a different block-table layout and is unsupported until independently verified.」
2. 同一仓库的实现把上限写死：`src/domain/unityfsFormat.ts` 里 `// Version 9 adds explicit block offsets; it needs a different table reader.` 与 `export const UNITYFS_FORMAT_VERSION_MAX = 8;`——**REA 自己也不实现 v9**，这条只是「不猜」的声明。
3. AssetStudio master 的 `AssetStudio/BundleFile.cs`（`ReadBlocksInfoAndDirectory`）按 `uncompressedSize u32 / compressedSize u32 / flags u16` 逐条读 10 字节，没有任何版本分支。
4. 本机 UnityPy 1.25.4 的 `files/BundleFile.py:13` 是 `BlockInfo = namedtuple("BlockInfo", "uncompressedSize compressedSize flags")`，`:146-155` 同样按 10 字节读，也无版本分支。
5. `https://reverseengineering.wiki/index.php/Format:Unity_asset_bundle_(UnityFS)` 的块表一节写：16 字节 hash、int32 块数、每块 10 字节、int32 节点数；infobox 注明「format version 6, 7, 8 seen in UnityPy」。
6. 找真实包：UnityPy 仓库 `tests/samples/char_118_yuki.ab`（Git LFS，必须走 `media.githubusercontent.com`）实测是格式版本 6 / Unity 5.6.7f1，不是 v9。GitHub 代码搜索 `unityfs version 9 offset` 命中 0，`"version >= 9" unity bundle block` 的命中都是 SerializedFile 版本，与包容器无关。XentaxWiki 列的游戏样本（如 Dragon Drop / 2021.3.0f1）也落在 8 以内。

结论：**没有公开的真实 v9 包，也没有任何独立实现支持 v9 块表。** 三份独立来源都按 10 字节读、与版本无关，因此「v9 每条多一个偏移」目前只是一条未经验证的断言。按这条断言写解析器等于赌。

## 交付

从「遇到 v9 直接抛错」改为「保留头部事实、明确标记块表未核对」，这是在不猜的前提下能给出的最大信息量：v8 及以下行为完全不变。

- `lib/unity.mjs`：`parseUnityfsHeader` 用 `tableLayout = formatVersion > 8 ? 'unverified' : 'verified'` 取代抛错，并把 `tableLayout` 放进返回体；`inspectUnityfs` 在 `tableLayout === 'unverified'` 时早退，返回 `blocksInfo.status: 'unsupported'`、`blocks: null`、`nodes: null`、`payload.status: 'skipped'`，`reason` 写明「只保留头部事实，块表、节点表与数据区未解析」。
- `lib/inventory.mjs`：Unity 公共说明补上「格式版本 9 及以上的块表布局明确不支持」；单个文件命中 v9 时再写一条 `UnityFS 格式版本 N 的块表布局未独立核对，只保留头部事实。`
- `lib/spec.mjs`：unknowns 同步该口径；规格表里 v9 文件单独渲染成「UnityFS 9 / <revision> / 块表布局未独立核对，只保留头部事实」，随后照常追加载荷跳过原因。
- `README.md`、`skills/guoluo-rebuild/SKILL.md`：把旧说法「遇到时明确拒绝而不是猜」改成现在的可观测行为，并写明为什么不做。

## 测试

`tests/unity.test.mjs` 的旧断言是「v9 必须抛错」，改为：

- v9 包头：`tableLayout === 'unverified'`、`blocksInfo.status === 'unsupported'`、`blocks`/`nodes` 为 null、`payload.status === 'skipped'`、`reason` 命中 `/块表布局未独立核对/u`。
- 同一份内容声明为 v8：`tableLayout === 'verified'`、`blocksInfo.status === 'parsed'`——证明拒绝只针对未核对版本，没有顺手把 v6–v8 也关掉。
- v6 真夹具的解构断言补上 `tableLayout: 'verified'`。
- LZHAM 文案断言改为新的合并口径（`LZHAM 压缩与 UnityFS 格式版本 9`）。

## 验证证据

- `GUOLUO_TEST_IL2CPP=<样本> GUOLUO_TEST_REA=D:\Tools\bin\rea.cmd npm run test:serial` → **130 项全过 0 失败 0 跳过**。
- `npm run check` → 打包 26 文件 81.4 kB / 解压 259.2 kB。
- 隔离 DSH 0.2.2-rc.5 用交付包离线安装（`npm install --offline --ignore-scripts ./zhuifengqug-dsh-guoluo-0.20.0.tgz`，安装 11 包）后冷启动：`{"result":"passed","version":"0.20.0","visual":null,"tools":12,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,"rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified","derived":{"spec":2,"brief":true,"tokens":1,"exported":2,"mock":0,"check":"complete","candidate":"partial"},"pck":2,"unity":"lz4","il2cpp":1}`。

## 未做与边界

- v9 及以上仍不解析块表、节点表与数据区；真要支持，必须有真实 v9 包与第二份独立实现互相印证，否则只能继续标未核对。
- LZHAM 依旧明确不支持（G 裁决：标明确不支持）。
- 加密 PCK 只核起点与声明大小（G 裁决：维持现状）。

## 校验和

`deliverables/zhuifengqug-dsh-guoluo-0.20.0.tgz`，81386 字节，SHA-256 `591F43C6262FEFEF63DE7B4AD6CFE22513F6F444A09683C41281B74E6349D65B`。