# 蜾蠃 v0.2.0 · 复刻义务账本与派生产物

## 目标

在 v0.1 已落盘的只读证据之上，增加"从证据到实现前规格"的那一段，并让每一步都能回查到文件与行号；再补上能证明"证据够不够复刻"的闭环。

## 交付

- `guoluo_spec`：把一批证据转成复刻义务账本，写 `<id>/spec/spec.json` 与 `spec.md`。每条义务有编号、种类、`requires`、`status: declared` 和 `evidence`（`path[:line]`）。同名令牌多值进 `conflicts`，证据未覆盖的进 `unknowns`。
- `guoluo_tokens`：写 `<id>/tokens/tokens.css`、`tokens.tailwind.css`、`tokens.json`。CSS 变量按素材原样输出并注释来源行；Tailwind 用 `@theme inline` 透传，不做语义改名（改 `--color-*` 这类命名空间留给人工决定）。
- `guoluo_export`：写 `<id>/export/assets.{json,md,csv}`，可按 `kind` 过滤。CSV 与 Markdown 都做了分隔符转义。
- `guoluo_mock`：写 `<id>/mock/mock.json` 与零依赖 `server.mjs`。已观测的静态链接回占位页（占位页写明证据位置、明说没有观测到页面内容），素材按素材根发原始字节，其余一律 404 JSON `not-observed`。外部 URL 与未校验的相对引用进 `unreplayed`，不代发请求。只生成不启动，返回可复制执行的 `start` 命令。
- `guoluo_check`：写 `<id>/checks/check-<ts>.json`。算漏项（rows 无对应义务）、悬空证据（义务无对应 row）、批次偏差（已落盘规格的 `runId` 或义务数与当前不符）。有任一则为 `blocked`；否则有令牌冲突为 `needs-decision`；否则 `complete`。
- 盘点记录 `meter`：`durationMs`、`rows`、`textBytes`、`visited`，写进批次文件并在 `spec.md` 里显示耗时。
- 派生产物整份替换、可重复生成，不新增批次；写入走同目录临时文件再 rename。

## 验证

- `npm run check`：16 项回归全过，打包 17 文件 23.0 kB。
- 隔离宿主（真实 DSH 0.2.2-rc.5，从 tarball 安装 10 包）跑通：

```
{"result":"passed","tools":11,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,
 "rea":{"status":"available","version":"6.8.0"},
 "derived":{"spec":2,"tokens":1,"exported":2,"mock":0,"check":"complete"}}
```

## 未做与边界

- 未改 Desktop profile，界面未做目视验收。
- 仍未自动调用 REA；导入摘要与当前素材的绑定仍未校验。
- 未生成复刻工程骨架（本轮明确不做）；未做截图比对与视觉还原（等 REA 采集能力接入）；未接 APK/EXE/Unity/Godot/craft-anything 后端。
- ASAR 仍只盘点头部目录；URL 仍只登记出处，不发请求。
- `check` 的 `complete` 只说明规格与证据自洽，不说明目标已被复刻。

## 校验和

`deliverables/zhuifengqug-dsh-guoluo-0.2.0.tgz`
SHA-256 `6DFD738BDD4B42617E2BC47ECCBE7E4A12668A9E2FE3BCDA7C5D28EA7432C5B8`
