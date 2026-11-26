# OpenWrite 2.0.6 真实应用试跑（2026-11-23）

用 G 给的真实安装包 `D:\edge下载\OpenWrite-win-x64-Setup-v2.0.6.exe` 跑一遍 guoluo 全链路，看它在「非 Web 打包应用」上到底能给出什么、漏了什么。

## 样本与拆包

- 安装包 39,316,141 B，PE + Inno Setup（`zlb` 分块、`rDlPtS` 标记），LZMA 压缩，简体中文单语言，安装标题「OpenWrite 写作助手 2.0.6」。
- 拆包工具：innoextract 1.9（官方 Windows 发布包，本机无 7-Zip；7-Zip 本身也不支持 Inno）。
- 解出 1732 个文件 / 67.6 MB，落到 `tmp/src/app/`（安装包内部保留自身 `app\` 目录，档案里的证据路径因此以 `app/` 开头）。
- 技术栈：Flutter Windows 桌面应用。`app\OpenWrite.exe`(128 KiB) + `flutter_windows.dll`(20.3 MiB) + `data\app.so`(13.6 MiB, Dart AOT) + `data\isolate_snapshot_data`(11.1 MiB) + `data\icudtl.dat` + `data\flutter_assets\`（1705 张 webp/png、1 个 otf、1 个 mp3、2 个 shader、若干清单）+ 10 个插件 DLL。**没有任何 HTML/CSS/JS**：界面由 Flutter 引擎用 Skia 直接绘制。

## 试跑方式

隔离 DSH_HOME 冷启动，junction 到仓库源码形态，`settings.update('guoluo', { sourceRoot: tmp/src, archiveRoot: archive })`，再按序调用 13 个工具里的 10 个：

```powershell
node docs/aegis/work/2026-11-23-openwrite/tmp/drive.mjs `
  'D:\deepseek HARNESS\resources\app\dsh\node_modules' `
  'D:\dsh-workspaces\dev\虫珀\蜾蠃' `
  docs/aegis/work/2026-11-23-openwrite/tmp/src `
  docs/aegis/work/2026-11-23-openwrite/archive
```

`target_add` → `dissect` → `dossier`(asset/binary) → `spec` → `brief` → `tokens` → `export`(json/markdown) → `mock` → `scaffold`；`list`、`status` 一并核过。

## 实测结果

| 项 | 数值 |
| --- | --- |
| 盘点耗时 | 13.2 s（目录 1769 项 / 67.6 MB） |
| 证据行 | 1718（image 1705、library 10、audio 1、executable 1、font 1） |
| 内容指纹 | 1717 个有 SHA-256，1 个因超 8 MiB 跳过（`flutter_windows.dll`） |
| token / navigation / reference | 0 / 0 / 0 |
| spec counts | structure 0、style-token 0、route 0、reference 0、asset 1718、other 0 |
| PE 解析 | 11 个全部 parsed（exe 1 + dll 10），含节表、导入/导出、CLR 标记 |
| REA | 6.8.0 自动分析完成，8 项绑定校验全过，`relevant_files 4`、`text_bytes_read 2869`、`parsed_javascript_files 0` |
| scaffold | copied 512 + generated 4，`skippedCount 1195`，`warnings []`，bytes 6,035,558 |
| scaffold 自带核对 | verdict `partial`，assets 1718 / present 512 / missing 1206 |
| 结构层 | comparedPages 0，pages.extra 1（`_scaffold/index.html`），diverged false |

产出落在 `archive/edeeeeed-1b29-4178-a792-e133595bd69b/`：`target.json`、`runs/<runId>.json`、`rea/<runId>/evidence.json`（23,453 B）、`spec/{spec.json,spec.md}`、`tokens/{tokens.css,tokens.tailwind.css,tokens.json}`、`export/{assets.json,assets.md}`、`mock/{mock.json,server.mjs}`、`brief/<runId>.md`、`scaffold/openwrite/`（512 个素材 + `_scaffold/` 四件 + `README.md`）。

## 这次试跑暴露的缺口

1. **未知扩展被静默丢弃**（阻断级）。`lib/inventory.mjs:12` 的 `types` 只有 21 个扩展名，`lib/inventory.mjs:143` `if (!type) return;` 既不计数也不告警。实测 1732 个文件里 **14 个被丢掉，合计 28,869,583 B（27.53 MB，占整个 payload 的 40.7%）**：`data/app.so`(13.64 MB, Dart AOT 业务代码)、`data/flutter_assets/isolate_snapshot_data`(11.11 MB)、`native_assets/jniLibs/lib/armeabi-v7a/libcnativeapi.so`(1.67 MB)、`data/icudtl.dat`(0.82 MB)、`AssetManifest.bin`、`NOTICES.Z`、两个 `shaders/*.frag`、`native_assets.json`、`FontManifest.json`、`NativeAssetsManifest.json`、`vm_snapshot_data`、`.last_build_id`、`assets/pet/dafeiyu/manifest.json`。Web 应用同理：`.js/.mjs/.json/.wasm/.map` 都不在表里，只有 REA 那条通路能碰到 JS。
2. **scaffold 512 文件上限静默截断**（高）。`scaffoldLimits.files = 512`，1718 个资产只复制 512 个，`skippedCount 1195` 却不进 `warnings`，coverage 只能看出 `missing 1206`，分不清是预算打满还是真缺失，也没有入参可调。
3. **无 HTML/CSS 的批次三维全 0 且不解释**（中）。Flutter 界面不进 DOM，structure/token/navigation 恒 0；`coverage.note` 仍是通用措辞，复刻方会误读成核对失败。
4. **超大文件不取指纹只留一句 note**（中）。`assetHashPerFile = 8 MiB`，20.3 MB 的 `flutter_windows.dll` 无 SHA-256，PE 都解析了却无法校验内容。
5. **Dart AOT 快照无任何解析能力**（预期内，但必须写进 unknowns）。`app.so` 是 Flutter 业务逻辑的载体，当前完全不读。

## 复现与清理

- `tmp/` 已被 `.gitignore`（`docs/aegis/work/*/tmp/`）覆盖：`innoextract/`、`listing.txt`、`run.json`、`drive.mjs`、`src/app/`（67.6 MB）。收尾时整体删除。
- `archive/` 是本次试跑的交付证据，保留。
