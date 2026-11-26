# v1.4.0：三层核对后的人工拍板

## 目标

P4 把 `guoluo_check` 的候选核对接到工作台的人工结论。工具和界面按钮共用 `projectService.verdict()`，不另造一套状态写入路径。结论落在档案根 `verdict.json`，保存当前决定与最近 20 条历史。

## 关键契约

- 只有带 `candidate.directory` 的 `guoluo_check` 才能作为验收依据。
- 选择依据时按当前 `runId` 优先；`guoluo_run` 内部产生的无候选检查会跳过。
- 当前批次没有候选核对、但档案里只有其他批次的候选核对时，仍返回跨批次错误，不套用旧结论。
- `accepted` 可以接受 `partial`，但候选缺失、覆盖缺口、结构缺口、令牌差异和候选结论会逐项进入 `unmet`。
- `rejected` 必须填写原因；历史按最新在前、最多 20 条保留。

## 实现

`lib/verdict.mjs` 负责决定校验、缺口摘要、历史封顶和人读行。`lib/projects.mjs` 的 `latestCheck()` 是唯一读取验收依据的地方：扫描 `checks/check-*.json`，跳过没有非空 `candidate.directory` 的记录，先返回当前 `runId` 的候选核对；若只找到其他批次，交给服务层的跨批次检查报错。这样修复了「候选核对后，`guoluo_run` 又写一份无候选检查，最新文件被误选」的回归。

`POST /api/guoluo/verdict` 与 `guoluo_verdict` 都调用同一 `projects.verdict()`。客户端的接受/退回按钮只提交 JSON，不直接写文件。工作台阶段增加 `accepted`；退回后回到 `checked`，让下一次修改仍有明确的核对入口。

## 验收

- 聚焦回归：verdict、workbench、route、client、dossier 共 34/34 通过。
- 新增回归覆盖：候选核对后再生成无候选核对，仍能按当前批次找到候选；跨批次候选继续拒绝；退回原因、历史和 partial 的 `unmet` 均有断言。
- 隔离宿主 smoke 需要同时装载 `@deepseek-ai/dsh-host-webserver`，并通过 `agent-preset-registry` 提供 `default: standard`，真实验证 20 个工具、`/api/guoluo/verdict`、工作台阶段和 `verdict.json`。

## 边界

拍板记录的是静态候选核对结论，不是运行时功能验收。插件不执行目标程序，不写素材根，不抓 DOM，不做样式布局推断；`accepted` 也不把 `partial` 改写成 `complete`。
