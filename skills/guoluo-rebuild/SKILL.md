---
name: guoluo-rebuild
description: 使用蜾蠃整理经过导出或准备好的 HTML、CSS、素材目录、Electron ASAR、Android APK，自动调用 REA 取得并绑定行为侧证据，按证据行产出复刻规格、设计令牌、资产清单，并可对本地复刻候选做三档视口截图比对。
---

# 蜾蠃：素材 → 档案 → 复刻义务

1. 调用 `guoluo_probe` 检查素材根和档案根。REA 未装不影响本地静态盘点。
2. 用 `guoluo_target_add` 登记素材根内相对路径，`kind` 选 `local`；目录、单个 HTML/CSS、Electron `.asar` 或 Android `.apk` 都可登记。`kind: url` 只记录出处，不触发采集；已有的本地导出件单独登记。
3. 用 `guoluo_dissect` 返回批次 ID、数量、范围、耗时与 REA 绑定结果。目录型素材会自动调用 REA 分析并把摘要绑定到本次素材的路径与根哈希；`rea.status` 为 `analyzed` 且 `rea.binding.status` 为 `verified` 才能采信行为侧证据，`mismatch` 视为无行为侧证据，需要重新采集。单文件、ASAR、APK 与 URL 档案不会触发 REA；APK 只按 ZIP 中央目录与二进制清单静态解析（包名、版本、SDK、权限、入口 Activity、ABI），不解压资源、不校验签名。
4. 用 `guoluo_dossier` 指定批次 `runId`，按 `asset`、`token`、`navigation` 或 `reference` 分页；当前页的 `nextOffset` 为 `null` 时结束。资产路径和证据行号引用同一批次。
5. 需要落到实现时，先 `guoluo_spec` 拿复刻义务账本：每条有编号、证据位置和 `declared` 状态；`conflicts` 里的令牌必须在动工前定值，`unknowns` 里的缺口必须显式处理，不能当作已完成。
6. 要变量就 `guoluo_tokens`（原样 CSS + Tailwind v4 片段），要清单就 `guoluo_export`（json/markdown/csv）。派生产物可重复生成，每次整份替换，不追加历史。
7. 要验证页面骨架或联调前端路由，用 `guoluo_mock` 生成零依赖回放服务（只回放已观测的静态链接与素材，其余 404 `not-observed`）。它只写文件不启动，自己执行返回的 `start`。占位页没有真实结构，不能当作还原结果。
8. 动工前和改完之后各跑一次 `guoluo_check`：`blocked` 说明证据漏项、悬空或规格批次过期，必须重新 `guoluo_spec` 或补盘点；`needs-decision` 说明令牌冲突待定值；`complete` 只表示规格与证据自洽，不表示目标已被复刻。
9. 想知道做得「像不像」，给 `guoluo_check` 传 `visual: { "candidateDirectory": "<素材根内候选目录>" }`：插件会用隔离的无头 Chromium 抓 390/768/1440 三档视口，再用 REA 算出变化像素比例并落盘。只看相同视口的静态像素差异，差异数由 REA 计算；`visual.status` 为 `measured` 才拿到分数，`blocked` 时看 `visual.kind`（`invalid-input` 还是 `environment`）和原因。
10. 结论区分静态观察、推断、尚缺证据。HTML 链接不是后端路由，ASAR 目录不是归档成员内容，APK 清单声明不是运行行为，CSS 变量不是运行时样式，截图比例不是功能等价。以档案支持新的项目规格，不把盘点当作已完成的复刻。

蜾蠃默认不启动目标应用、打开页面或运行目标脚本；只有显式传 `visual` 才启动插件自己起的隔离 Chromium 去加载本地静态副本，不需要为了凑齐分类而扩展输入范围。
