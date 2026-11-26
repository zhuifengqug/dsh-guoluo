# v1.0.0：交付面定型

这一版不加新能力，把已经能跑的东西钉成可交付的样子：一条命令出复刻包、README 给出复刻流程、装进 Desktop profile、tag 与 tarball 落地。代码与 0.26.0 相同。

## 为什么是 1.0.0

判据不是版本号好看，而是三件事同时成立：

1. **一条命令能出成品**：`guoluo_run` 从登记到包，每一步都有耗时、状态与产物路径，失败按步报错且不留半截。真实样本上跑通了（下节数字）。
2. **成品能被人接手**：`pack/<批次>/INDEX.md` 先给结论，再给阅读顺序、证据事实、缺口、五步路径与产物清单，不看别的文件也能判断能不能开工。
3. **边界写在明面上**：不做的事（craft-anything 后端、业务代码生成、Dart AOT/Flutter 快照、DOM 快照与样式换算、反编译、npm 发布）在 README 的「当前不做」与「版本与能力边界」里逐条列着。

## 三条刀各自落成什么

- **刀 A**（0.26.0，commit `6638b1f`）：`guoluo_run` + `pack/<批次>/` 不可变批次目录 + 失败不留半截；`publishPack` 先写 `.new-<批次>` 再 `rename`。
- **刀 B**（安装）：`plugin_manager install_bundle target=link:D:\dsh-workspaces\dev\虫珀\蜾蠃` 返回 `applied`、`version 0.26.0`、`warnings []`；profile `package.json` 的 `dsh.profile.bundles` 与 `node_modules/@zhuifengqug/dsh-guoluo` 链接都指回仓库。**重启 Desktop 才装载**。
- **刀 C**（真实样本）：OpenWrite 2.0.6 解包目录 `app/` 走一次 `guoluo_run`，数字见下。
- **刀 D**（本片）：README 补「拿它复刻一个应用」五步与「版本与能力边界」表；版本升 1.0.0；`git tag v1.0.0`；出 tarball。

## 刀 C 实测（真实素材，Flutter 桌面应用）

驱动脚本 `docs/aegis/work/2026-11-23-openwrite/tmp/drive-run.mjs`（在 gitignore 的 tmp 区）：隔离 `DSH_HOME`，junction 仓库源码，`settings.update` 配素材根/档案根/`reaPath`，`target_add` 后调 `run { name: 'openwrite', files: 4096, fileBytes: 33554432, totalBytes: 268435456 }`。

| 项 | 值 |
| --- | --- |
| 档案 | `38c9f2f8-7d28-4167-8e55-faba76f7ab02` |
| 复刻包 | `<id>/pack/1795687007753-9bf1a4af-c478-4fbf-b469-e3a1009a9647` |
| 总耗时 | 29,658 ms |
| 步骤 | dissect 24,549 / spec 24 / brief 14 / tokens 16 / export 10 / scaffold 4,992 / check 19 / pack 10 ms，八步全 `ok` |
| 证据 | asset 1,732、token 0、navigation 0、reference 0 |
| 类型分布 | image 1,705、other 14、library 10、audio 1、font 1、executable 1 |
| 骨架 | 复制 1,707、生成 4、17,495,280 B（约 17.5 MiB）、跳过 0、告警 1 |
| 覆盖度 | assets 1,732 / present 1,707 / missing 25，令牌与结构空集 |
| 证据核对 | `complete`（orphans 0、dangling 0、stale false、conflicts 0） |
| 环境 | REA 6.8.0 自动分析完成，根哈希与证据字节数逐项对上 |

25 个缺失全部是非静态类型（10 个 `library`、14 个 `other`、1 个 `executable`），不是复制预算拦下的：预算 `hit:false / blocked:0`。这与「只搬静态素材、非静态类型照实记缺口」的设计一致——`app/data/app.so`、`isolate_snapshot_data`、`vm_snapshot_data`、`icudtl.dat`、各 DLL 都在缺口里，没有一个被当作已复刻。

`web.applicable:false`，所以 `structure.comparedPages:0`、`pages.extra:1`（骨架自带的 `_scaffold/index.html`）、`diverged:false`，回执 note 明说「这是空集，不是核对通过」。

包里 `INDEX.md` 的实样见同目录 `sample-INDEX.md`（路径指向那次 tmp 档案，档案不入库）。

## 交付物

- 14 个工具：probe、target_add、dissect、dossier、spec、brief、tokens、export、mock、check、list、status、scaffold、run。
- `guoluo-rebuild` 技能（第 0 步 `run`，1–11 步为分步参考）。
- `/guoluo` 命令（含 `run <id>`）。
- README 的「拿它复刻一个应用」五步与「版本与能力边界」表。
- git tag `v1.0.0`、tarball（不入库，路径写在验收节）。

## 验收

三份真实样本 env 全开（`GUOLUO_TEST_UNITY_V9`、`GUOLUO_TEST_IL2CPP`、`GUOLUO_TEST_REA`）：

- `npm run check` → **172 tests / 172 pass / 0 fail / 0 skipped**；打包 29 文件、package **105.8 kB**、unpacked **338.7 kB**、shasum `6901c198ca7c8a6518b4dc3d5643579c87077aed`。
- tarball `zhuifengqug-dsh-guoluo-1.0.0.tgz`：**105,764 B**，SHA-256 `5BE8FD5FD55B71DD9DCFE9E2BC00C58B88C79E4D63AEB94EEE12720010CE5AAB`（在 gitignore 的 `docs/aegis/work/2026-11-22-samples/tmp/v9/`，不入库）。
- 隔离 DSH 冷启动 smoke（`package-1.0.0` 解包产物）：退出 0，
  `{"result":"passed","version":"1.0.0","tools":14,"skill":"guoluo-rebuild","command":"guoluo","rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified","derived":{"spec":2,"brief":true,"tokens":1,"exported":2,"mock":0,"check":"complete","candidate":"partial","scaffold":2,"structure":1,"report":1,"run":8},"pck":2,"unity":"lz4","unityV9":null,"il2cpp":1}`
  （该次未设 `GUOLUO_TEST_UNITY_V9`，故 `unityV9:null`；UnityFS v9 的 11 块 / 4 节点已在 0.21–0.26 的验收里核过。）

## Desktop 装载

`plugin_manager` 装的是 `link:`，所以仓库里 `git pull` 或改文件就等于改插件；**重启 Desktop 后**：

1. 工具列表应有 14 个 `guoluo_*`（含 `guoluo_run`、`guoluo_scaffold`）。
2. 技能列表应有 `guoluo-rebuild`。
3. `/guoluo run <素材名或 id>` 能直接出复刻包；没有目标时先 `/guoluo` 看用法。
4. 设置页应能改 `sourceRoot` / `archiveRoot` / `reaPath` / `chromiumPath` / `reaTimeoutMs`。

验收失败时先看 `cordis` 日志里的 bundle 装载行，再确认 `D:\DSHData\home\profiles\desktop\node_modules\@zhuifengqug\dsh-guoluo` 的链接指向本仓库。

## 残留（v1.0.0 之后）

| 缺口 | 为什么留着 |
| --- | --- |
| Dart AOT / Flutter 快照解析 | 要校准 Dart 快照格式与类表布局，属于新的二进制解析面，另开一版 |
| DOM 快照、样式计算、布局与脚本行为 | 现在只比静态 HTML 文本；再往上要走浏览器运行时，和「不执行目标代码」的边界冲突，要单独设计 |
| 业务代码生成 | craft-anything 执行后端未接，scaffold 只搬静态素材 |
| CI | 仓库无 CI；真实样本走 env var opt-in，不适合放进默认门禁 |
| npm 公网发布 | 只留 tag 与 tarball，不发公网包 |