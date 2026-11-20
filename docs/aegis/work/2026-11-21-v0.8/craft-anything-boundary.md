# craft-anything 接入边界（结论：暂不接）

本文件记录 `guoluo` 为什么不把 [craft-anything](https://github.com/storytold/craft-anything) 当执行后端，以及将来要接时必须先满足什么。属于设计判断，不含代码。

## 它是什么（据 v0.6.1 的仓库结构）

单个 Rust 引擎，约 320 个 `ToolSpec`，UI（egui 桌面）、CLI、MCP、AI 四条入口都按 tool id 分发到同一个引擎；crate 分 L0–L6 强制分层（evidence/formats → disasm/js → analysis/platform → engines → engine → ai/mcp/setup → ui-egui），由 `cargo xtask layers` 守护。复刻流程是四阶段项目机（Study → Build → Check → Ready），项目目录固定 `craft.json / capture/ / app/ / checks/ / investigation.cany/ / inbox/`，人工决策走 inbox 问题卡。

## 值得抄的三点（已抄或已对齐）

1. **证据账本模型**：每条结论带 confidence/coverage/limitations，大结果先给摘要再分页。`guoluo` 的 `coverage`、`meter`、`dossier` 分页与 `unknowns` 就是这个形状。
2. **fail-closed 的项目机**：状态不可跳级，缺口不补就不算完成。`guoluo_check` 的 `blocked`/`needs-decision`/`complete` 与「`complete` 只表示自洽、不表示复刻完成」的措辞照此。
3. **「像不像」可量化**：网站三档宽度截图比对。`guoluo_check` 的 `visual` 就是这个，只是差异数值交给 REA 计算并只做自洽校验。

## 为什么不接（三个硬理由）

1. **本机没有 Rust 工具链。** craft-anything 只有 Release 产物；要在本地改它就是编译不出来的死代码。装发布包也能用，但那意味着把插件的关键路径压在一个外部二进制的版本上。
2. **它的 MCP 入口要求两个绝对根。** `<app>-cli mcp` 不带 `--automation-read-root` 与 `--automation-write-root` 会直接拒启，且拒绝两根之外的路径。`guoluo` 的档案根/素材根是用户可热改的 volatile 配置，一旦与它的两个根绑定，根一变就得重启它的进程；热更新语义会被这条约束吃掉。
3. **工具面过宽。** 320 个工具里绝大多数与「资产→证据」无关（反汇编、IL2CPP、frida、浏览器自动化、游戏自检）。把整棵工具树挂进 DSH 会让模型在每个工具调用前先做一次 320 项筛选，这和 `guoluo` 刻意保持 11 个工具的方向相反。

## 如果要接，最小可行形状

不做「引擎代理」，只做**单一投影**：

1. 只暴露一个 `guoluo_craft` 工具，参数只有 `{ verb, projectFolder }`，`verb` 枚举白名单（例如 `study`, `check`, `export-evidence`），其余一律拒绝。
2. 两根写死由 `guoluo` 的 `archiveRoot`/`sourceRoot` 派生，不接受用户自填；`archiveRoot` 变更时插件自己重启子进程。
3. 所有返回先落 `craft.json`/`evidence.json` 到档案根，再按 `guoluo` 的分页约定投影给模型，绝不把它的原始 tool 输出整包回灌。
4. 先决条件：本机装 craft-anything 发布包 + 在 `rea` 与它之间确认证据不冲突（同一份素材的两套 `root_artifact_sha256` 必须一致，不一致就取 REA 的）。

## 未核实的部分

以下取自 v0.6.1 的 README 与 AGENTS.md，本轮**没有联网复核**，接之前必须重新确认：

- 320 个 `ToolSpec` 的具体数量与分区。
- Windows 只有 msi 与 portable zip、应用内置 CLI（README 称 0.2.0 之后版本内置）。
- `craft-anything-cli rebuild <url> "<请求>" [--rounds N] [--continue-in <dir>] [--project-folder <dir> --existing edit]` 的参数形状。
- builder 对 Claude Code 之外（Codex/Copilot/Grok/ACP）的支持程度。

## 与「DSH 子代理复刻」的边界

复刻的执行者是 DSH 的子代理，不是 craft-anything 的 builder。分工：

- `guoluo` 出证据、规格、令牌、清单与核对结论 —— 只读素材，只写档案根。
- 子代理拿 `spec.json` 与 `guoluo_mock` 起的回放服务干活，产物落在素材根之外的独立工程目录。
- 核对仍走 `guoluo_check`：证据自洽 + 可选三档视口。子代理的产物不由 `guoluo` 生成，所以插件也不对它的质量作担保。