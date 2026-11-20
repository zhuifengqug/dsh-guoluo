---
name: guoluo-rebuild
description: 使用蜾蠃整理经过导出或准备好的 HTML、CSS、素材目录、Electron ASAR，按证据行产出重新实现前的档案。
---

# 蜾蠃：素材 → 档案

1. 调用 `guoluo_probe` 检查素材根和档案根。REA 未装不影响本地静态盘点。
2. 用 `guoluo_target_add` 登记素材根内相对路径，`kind` 选 `local`。`kind: url` 只记录出处，不触发采集；已有的本地导出件单独登记。
3. 用 `guoluo_dissect` 返回批次 ID、数量、范围与局限。只在已给出 REA 静态 JSON 摘要时传 `reaSummary`，该摘要来源单列，未经绑定验证。
4. 用 `guoluo_dossier` 指定批次 `runId`，按 `asset`、`token`、`navigation` 或 `reference` 分页；当前页的 `nextOffset` 为 `null` 时结束。资产路径和证据行号引用同一批次。
5. 结论区分静态观察、推断、尚缺证据。HTML 链接不是后端路由，ASAR 目录不是归档成员内容，CSS 变量不是运行时样式。以档案支持新的项目规格，不把盘点当作已完成的复刻。

蜾蠃不会启动目标应用、打开页面或运行目标脚本，不需要为了凑齐分类而扩展输入范围。
