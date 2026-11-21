# 蜾蠃 v0.12.0：候选工程覆盖度 + Unity 载荷加固

## 目标

1. 让 `guoluo_check` 能对着已经写出来的复刻候选目录，回答「档案里的素材、页面、令牌，候选里有没有」——只比文件层，不假装比运行时。
2. 消化 v0.11 独立复审的高危与中危缺口：LZ4 声明长度可让宿主进程 OOM、解压循环里观测不到取消、失败原因被折叠成一团。

## 交付

- **候选覆盖度**（`lib/check.mjs` `checkCandidate`、`lib/projects.mjs` `scanCandidate`/`checkCandidateRun`、`index.js` 的 `candidate` 参数）：按档案逐条比对素材是否存在，归档成员（ASAR/APK/PCK）单列为 `archived` 且不判缺失；页面按路径或同名文件命中；设计令牌在候选 CSS 文本里按声明检索。返回 `assets{entries,present,missing,archived,truncated}`、`structures`、`tokens` 与固定的 `unchecked` 两条（归档成员不回放、级联与作用域不在文件层）。结论落在 `check-<ts>-<uuid>.json` 的 `candidate` 字段，与证据自洽性、视觉核对并列。
- **Unity 载荷预算**：`payloadDecodedBytes = 256 MiB`。LZ4 解压先校验声明长度再分配内存，单块声明超限整段 `skipped` 并写原因；匹配循环每 16 KiB 观测一次取消。
- **三态语义**：`payload.status` 分 `parsed` / `skipped`（编码暂不支持、加密、超预算）/ `failed`（数据区解压失败），`spec` 的 Markdown 与 unknowns 按三态分别措辞，`truncated` 时写明「节点明细仅列前 N 个」。
- **LZ4 解码加固**：15 扩展长度越界、字面量与匹配越界都用自己的错误文案；结束时校验输入字节被完全消费。
- **回归稳定性**：`npm run check` 改用 `test:serial`（`--test-concurrency=1`）。并发跑时同时起多个 Chromium 偶发让某一档落到环境失败，串行后稳定；`npm test` 仍是并发快跑。

## 约束

- 只读：候选目录必须落在素材根内，拒符号链接，预算 20000 条目 / 深度 32 / CSS 64 文件 8 MiB。
- 不解析 CSS 级联与作用域，不执行候选里的任何代码，不启动浏览器（除非另外显式传 `visual`）。
- 仍不接 craft-anything 执行后端；不改 Desktop profile；测试只在隔离 `DSH_HOME` 里装载。

## 验证

- `npm run check`（含真实 REA，串行）：102 项全过 0 失败 0 跳过，打包 23 文件 68.8 kB / 解压 216.3 kB。
- 隔离宿主：从最终 tarball 离线安装后在隔离 DSH 0.2.2-rc.5 profile 里冷启动 `node tests/host-smoke.mjs`，断言 11 个工具、设置热更新、REA 绑定、PCK/Unity 夹具与候选覆盖度。
- 视觉无回归：假 REA 与假浏览器覆盖整条管线；真实 REA 的三档与部分差异用例在串行下全过。

## 未验证与边界

- 候选覆盖度只看文件层：有同名文件不等于内容等价，令牌只查是否声明，不查取值是否被真正使用。
- 并发跑测试的偶发失败未定位到根因（推测是多个 Chromium 实例争内存/端口），先用串行规避。
- bundle formatVersion ≥ 9 的块条目布局尚未核对：AssetStudio 在该版本多读一个偏移字段，UnityPy 1.25.4 仍按 10 字节读，本机没有真实 v9 包可对照，因此 v0.12.1 起对 v9 及以上直接拒绝，而不是按 10 字节猜出一张错的块表。
- 数据块 LZMA/LZHAM 仍未解；加密包只记块信息；IL2CPP 只到头部。
- 加密 PCK 条目的实际存储区间未核验。

## 校验和

```
zhuifengqug-dsh-guoluo-0.12.1.tgz  69238 字节
SHA-256  C2CF7D759A2788D4EC6BE8A70888BC4A9DE876390667AB12712E7134EBA8C9D7

zhuifengqug-dsh-guoluo-0.12.0.tgz  68974 字节
SHA-256  59A23806BF9D62C6C38BC4BE2CBBFEFF98619200FE55CF8EEF30E32115B653FE
```
