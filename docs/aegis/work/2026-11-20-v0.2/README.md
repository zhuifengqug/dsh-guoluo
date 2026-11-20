# 蜾蠃 v0.2.0 · 复刻义务账本与派生产物

## 目标

在 v0.1 已落盘的只读证据之上，增加"从证据到实现前规格"的那一段，并让每一步都能回查到文件与行号。

## 交付

- `guoluo_spec`：把一批证据转成复刻义务账本，写 `<id>/spec/spec.json` 与 `spec.md`。每条义务有编号、种类、`requires`、`status: declared` 和 `evidence`（`path[:line]`）。同名令牌多值进 `conflicts`，证据未覆盖的进 `unknowns`。
- `guoluo_tokens`：写 `<id>/tokens/tokens.css`、`tokens.tailwind.css`、`tokens.json`。CSS 变量按素材原样输出并注释来源行；Tailwind 用 `@theme inline` 透传，不做语义改名（改 `--color-*` 这类命名空间留给人工决定）。
- `guoluo_export`：写 `<id>/export/assets.{json,md,csv}`，可按 `kind` 过滤。CSV 与 Markdown 都做了分隔符转义。
- 盘点记录 `meter`：`durationMs`、`rows`、`textBytes`、`visited`，写进批次文件并在 `spec.md` 里显示耗时。
- 派生产物整份替换、可重复生成，不新增批次；写入走同目录临时文件再 rename。

## 验证

- `npm run check`：11 项回归全过，打包 15 文件 18.9 kB。
- 隔离宿主（真实 DSH 0.2.2-rc.5，从 tarball 安装 10 包）跑通：

```
{"result":"passed","tools":9,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,
 "rea":{"status":"available","version":"6.8.0"},"derived":{"spec":2,"tokens":1,"exported":2}}
```

## 未做与边界

- 未改 Desktop profile，界面未做目视验收。
- 仍未自动调用 REA；导入摘要与当前素材的绑定仍未校验。
- 未生成复刻工程、未搭 mock、未做视觉比对、未接 APK/EXE/Unity/Godot/craft-anything 后端。
- ASAR 仍只盘点头部目录；URL 仍只登记出处，不发请求。

## 校验和

`deliverables/zhuifengqug-dsh-guoluo-0.2.0.tgz`
SHA-256 `6B6C65CAA157ADB6656DEAD238D0046FD33DBFB81AEC979E7F13F7BFC05689C6`
