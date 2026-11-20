# 蜾蠃 v0.4.0 · 三档视口截图比对

## 目标

把「像不像」变成可量化结论：`guoluo_check` 显式接收 `visual` 时，用 REA 的 `capture-web-screenshot` 与 `compare-web-screenshots` 对基准与复刻候选抓 390 / 768 / 1440 三档静态视口，算出变化像素比例并落盘可复查的截图与差异证据。视觉结果与证据自洽性核对**独立呈报**，视觉失败不回退或污染 `verdict`。

## 交付

- 新增 `lib/visual.mjs`：`widths = [390, 768, 1440]`、`height = 900`；`visualPage` 校验入口是 HTML 且指纹与盘点行一致；`serveStaticPage` 起 127.0.0.1 随机端口只读静态服务；`validArtifact` 校验截图自绑定；`visualMetrics` 校验差异证据自洽；`comparePages` 编排整条链路。
- `guoluo_check` 参数新增 `visual` 对象：`candidateDirectory`（必填，素材根内目录）、`baselineEntry`、`candidateEntry`、`channelThreshold`（0–255）。工具超时 210000 ms。
- 新增配置项 `chromiumPath`（留空用本机 Chrome，缺失回退 Edge）。
- 产物：`<id>/checks/check-<ts>-<uuid>.json`；视觉子目录下每档 `<w>-baseline.artifact.json`、`<w>-baseline.png`、`<w>-candidate.artifact.json`、`<w>-candidate.png`、`<w>-diff.json`，共 15 个。
- `visual.status` 为 `measured` 或 `blocked`；`blocked` 带 `kind`（`invalid-input` / `environment`）与原因，`environment` 保留更长原因。

## 关键实现约束

- 只抓静态视口：隔离 Chromium 无头、`javaScriptEnabled:false`、`serviceWorkers:'block'`、`acceptDownloads:false`、`--remote-debugging-port=0`，`browser.route` 只放行当前侧 origin；禁脚本使 fixture 的 `[1,0,0]` 成为「脚本确实被关」的反证。
- 静态服务安全边界：CSP `default-src 'none'`、`nosniff`、`no-store`、Host 精确校验、路径逐段解码后走 `relativeInput`+`localPath`（拒 `..`、`%2e%2e`、反斜杠、符号链接）、只发 mime 白名单、单文件 ≤8MB、总计 ≤64MB、请求 ≤1024、并发 ≤16；同一文件指纹变化即 404 并记 `changed`。
- 证据绑定：`visualMetrics` 用 `before/after_artifact_sha256` 把差异绑回本次抓的 PNG，并重算 `changed/pixels`（`1e-9` 容差）、校验尺寸、`channel_threshold`、`compared_pixels`、`status` 与 `mean <= peak`。
- 内部总预算 `AbortSignal.timeout(175000)` 与外部信号 `AbortSignal.any` 合并，低于工具 210000，避免外层硬杀；取消时关闭浏览器、关两个静态服务、删隔离 profile。

## 验证

- 默认 `npm test`（无真实 Chrome/REA）：30 项里 28 过、2 个真实 REA 用例跳过。新增 `tests/visual.test.mjs` 6 项，含用 `tests/fixtures/fake-rea-browser.mjs` 假 REA + 假浏览器跑完整管线（落盘 15 产物、无 `browser` 残留）、取消后清理、静态服务穿越/Host/CSP 断言、像素投影构造用例、相对 Chromium 路径与越界阈值拒绝。
- `GUOLUO_TEST_REA=D:\Tools\bin\rea.cmd npm test`：30 项全过，含真实 REA 三档用例与**部分差异**用例（`0 < ratio < 1`）。
- `npm run check`：打包 18 文件 95.0 kB（tarball 32.8 kB）。
- 隔离宿主（真实 DSH 0.2.2-rc.5）：

```
{"result":"passed","tools":11,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,
 "rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified",
 "derived":{"spec":2,"tokens":1,"exported":2,"mock":0,"check":"complete"}}
```

## 复审与修复

子代理只读复审 13 条，已处理：默认 CI 现覆盖整条视觉链路（假 REA 三动词 + 假浏览器）；`visualMetrics` 改容差比较并补部分差异真实用例；内部总预算收敛到 175s；补取消/回收与静态服务安全边界测试；README 补 `chromiumPath`、新文件名、可选视觉与浏览器依赖（含 Edge 回退）；`baselineEntry` 归一化反斜杠；`check` 异常分 `invalid-input`/`environment`；`schemaVersion` 只在 `measured` 时为 2；删死参与 package.json 格式化噪声。

## 未做与边界

- 未改 Desktop profile，界面未做目视验收；未生成复刻工程骨架。
- 差异像素数由 REA 计算，插件只做自洽校验，未用落盘 PNG 独立复算；只衡量相同视口静态像素差异，不代表动态页面、交互或功能等价。
- 需本机 Chrome 或 Edge，或配置 `chromiumPath`；`playwright-core` 不自带浏览器。
- ASAR 仍只盘点头部目录；URL 仍只登记出处；REA 分析只接受目录。

## 校验和

`deliverables/zhuifengqug-dsh-guoluo-0.4.0.tgz`（32810 字节）
SHA-256 `50FBAD505DE38DA4879CCFF784341C3D8BE698B879F9793C636AB422D0AECE4E`
