---
name: guoluo-rebuild
description: 使用蜾蠃整理经过导出或准备好的 HTML、CSS、素材目录、Electron ASAR、Android APK、Godot PCK、Windows EXE/DLL、Unity 头部素材，自动调用 REA 取得并绑定行为侧证据，按证据行产出复刻规格、设计令牌、资产清单，并可对本地复刻候选做三档视口截图比对。
---

# 蜾蠃：素材 → 档案 → 复刻义务

1. 调用 `guoluo_probe` 检查素材根和档案根。REA 未装不影响本地静态盘点。
2. 用 `guoluo_target_add` 登记素材根内相对路径，`kind` 选 `local`；目录、单个 HTML/CSS、Electron `.asar`、Android `.apk`、Godot `.pck`、Windows `.exe`/`.dll`，或 Unity 的 `global-metadata.dat`、`.bundle`/`.unity3d` 都可登记。`kind: url` 只记录出处，不触发采集；已有的本地导出件单独登记。
3. 用 `guoluo_dissect` 返回批次 ID、数量、范围、耗时与 REA 绑定结果。目录型素材会自动调用 REA 分析并把摘要绑定到本次素材的路径与根哈希；`rea.status` 为 `analyzed` 且 `rea.binding.status` 为 `verified` 才能采信行为侧证据，`mismatch` 视为无行为侧证据，需要重新采集。单文件、ASAR、APK、PCK、PE、Unity 与 URL 档案不会触发 REA；APK 只按 ZIP 中央目录与二进制清单静态解析（包名、版本、SDK、权限、入口 Activity、ABI），不解压资源、不校验签名；PCK 只读包头与文件表（引擎版本、条目、加密标记、场景/脚本/资源计数），不解压条目、不解密、不运行游戏；PE 只解析头部、节表、导入导出表与 CLR 标记，不反编译、不运行二进制；Unity 盘点 `UnityFS` 头和可读的未压缩块表、节点表，也记录 `global-metadata.dat` 的 IL2CPP 头部证据。压缩表、节点内容和 IL2CPP 元数据表仍是证据缺口。
4. 用 `guoluo_dossier` 指定批次 `runId`，按 `asset`、`token`、`navigation`、`reference` 或 `binary`（PE 与 Unity 逐文件明细）分页；当前页的 `nextOffset` 为 `null` 时结束。资产路径和证据行号引用同一批次。
5. 需要落到实现时，先 `guoluo_spec` 拿复刻义务账本：每条有编号、证据位置和 `declared` 状态；`conflicts` 里的令牌必须在动工前定值，`unknowns` 里的缺口必须显式处理，不能当作已完成。
6. 要变量就 `guoluo_tokens`（原样 CSS + Tailwind v4 片段），要清单就 `guoluo_export`（json/markdown/csv）。派生产物可重复生成，每次整份替换，不追加历史。
7. 要验证页面骨架或联调前端路由，用 `guoluo_mock` 生成零依赖回放服务（只回放已观测的静态链接与素材，其余 404 `not-observed`）。它只写文件不启动，自己执行返回的 `start`。占位页没有真实结构，不能当作还原结果。
8. 动工前和改完之后各跑一次 `guoluo_check`：`blocked` 说明证据漏项、悬空或规格批次过期，必须重新 `guoluo_spec` 或补盘点；`needs-decision` 说明令牌冲突待定值；`complete` 只表示规格与证据自洽，不表示目标已被复刻。
9. 想知道做得「像不像」，给 `guoluo_check` 传 `visual`：`candidateDirectory` 必填（素材根内候选目录），单页用 `baselineEntry`/`candidateEntry`，多页用 `routes: [{ baselineEntry, candidateEntry }]`（1–16 条，二者不可混用）。每条路由按 390/768/1440 宽、900 高逐档测量，截图与 `summary.json` 落在 `check-<ts>-<uuid>/`。差异像素由插件独立解码 PNG 复算，再与 REA 的 `changedPixels` 交叉核对；不一致时该档记 `conflict` 并并列两组数值，不拿 REA 数字当结论。只有三档全部 `verified` 的路由才出 `score`（`1 −` 各档自算变化比例最大值）。默认 `channelThreshold: 0`，结论写明「本分数按逐通道 0 阈值计算，含抗锯齿差异」。整体 `visual.status` 为 `blocked` 时，查看 `visual.kind`、原因和逐路由结果。已核验的路由保留分数。
10. 结论区分静态观察、推断、尚缺证据。HTML 链接不是后端路由，ASAR 目录不是归档成员内容，APK 清单声明不是运行行为，PCK 条目清单不是运行时资源依赖，PE 导入函数不是被调用的证据，Unity 头也不代表包内资产，CSS 变量不是运行时样式，截图比例不是功能等价。以档案支持新的项目规格，不把盘点当作已完成的复刻。

蜾蠃默认不启动目标应用、打开页面或运行目标脚本；只有显式传 `visual` 才启动插件自己起的隔离 Chromium 去加载本地静态副本，不需要为了凑齐分类而扩展输入范围。
