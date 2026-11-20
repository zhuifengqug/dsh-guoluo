# 虫珀·蜾蠃

DSH 0.2.2-rc.5 的本地应用资产档案插件。把静态素材整理成可逐条回查的证据，再以证据决定新项目要实现什么。项目阶段和证据分层参考 [craft-anything](https://github.com/storytold/craft-anything)，REA 的静态摘要作为独立来源记录。

## 开始

在插件设置中填写两个**已存在、互不包含**的绝对目录：`sourceRoot`（素材根）和 `archiveRoot`（档案根）。`reaPath` 可留空从 `PATH` 找，仅用于检测 REA 版本；适配普通可执行文件、Node `.mjs` 和符合固定格式的 Windows Node 启动器。REA 未装也能盘点静态素材。

1. `/guoluo probe` 检查配置与 REA CLI。
2. `guoluo_target_add` 登记 `{ "kind": "local", "location": "my-export" }`。位置相对于素材根。
3. `guoluo_dissect` 传档案 `id`，返回批次 `runId`、证据数量与覆盖说明。可选 `reaSummary` 是素材根内已有的 REA 静态 JSON 摘要。
4. `guoluo_dossier` 传 `id`，可选固定 `runId`、`kind`、`offset`、`limit`。通过 `nextOffset` 翻页。
5. `/guoluo list` 列档案，`/guoluo status <id>` 看状态；也可用 `guoluo_list`、`guoluo_status`。

随包提供 `guoluo-rebuild` 技能。档案索引和独立批次保存在档案根的 `<id>/target.json` 与 `<id>/runs/<runId>.json`。请使用单独的归档目录；不要在盘点时改动、移动或替换素材目录与档案目录中的条目。

## v0.1 能看到什么

- **本地目录或单个 HTML/CSS**：常见媒体和字体文件目录、HTML/CSS SHA-256、CSS 自定义属性、静态 HTML 链接和部分资产引用。引用值丢弃查询参数、片段和带登录信息的 URL；不将链接当作服务器路由。
- **ASAR**：只看包头里的目录和登记大小，不验证归档成员或解包内容。要读 HTML/CSS 的证据，请单独登记已经导出的目录。
- **URL**：只保存出处，不发请求、不打开页面。原 URL 的查询参数和片段不会保存。
- **REA**：探测 CLI 版本、导入既有 `analyze-javascript-application` JSON 摘要的统计和指纹。导入摘要与当前盘点素材的绑定未验证，插件不自动调用 REA 分析。

v0.1 到盘点档案为止。不生成复刻工程，不验证运行时交互，不接入 APK、EXE/DLL、Unity/Godot、craft-anything 执行后端或小说流程。扫描有数量、深度和大小预算，命中时在覆盖字段或局限中可见。只写档案根，默认不启动目标应用、目标脚本或浏览器。

## 开发

需要 Node.js 22 或以上。`npm ci` 后用 `npm run check` 运行回归并核对打包清单。此项目使用 MIT 许可。
