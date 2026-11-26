# v1.2.0 · P2：预设工作流、集中提问与逆向报告

日期：2026-11-27。上一版 1.1.0（P1 只读工作台）已经能让 G 在对话里逐条调工具、在侧栏看档案；这一版把「指一个应用就开拆」这件事做成一个能选的预设，并把「要拍板的事」和「已经知道的事」分成两份产物。

## 做了什么

### 1. 预设 `guoluo-rebuild`（显示名「复刻工坊」）

预设不再是 `$DSH_HOME/.agent-presets/<id>/`（那套机制宿主已经不再读取，`compositions.md:65` 原文写着 Nothing reads that directory any more）。现在唯一的声明方式是 bundle patch 里的一行 `@deepseek-ai/dsh-agent-preset`：

```yaml
- id: preset-guoluo-rebuild
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: guoluo-rebuild
    name: 复刻工坊
    order: 20
    plugins: [...]
```

`plugins` 以宿主的 `standard.patch.yml` 为底，去掉两样东西：

- **`planning` 组**：这个预设的职责是执行，不是先写一份计划等批准。plan mode 会把「点一个目标」变成「先审一份计划」。
- **`tool-schedule`**：定时任务与复刻无关。

`persona.prefix` 换成复刻工坊的人设：一句话开工的五步链、证据/推断/缺口三层分账、以及五条硬规矩（只读素材、静态证据不等于复刻、一批一次绝不覆盖、不替用户答题、数字用真实回执）。人设写的是行为，不是介绍。

**工具可见性**：预设不重复声明 `guoluo` 插件行。宿主平面的工具在预设会话里照常可见——本会话跑的是 `standard` 预设，却能用 profile bundle 提供的 `dragonfly_*`、`mnemon_*`、`deck_*`，同一个道理。

### 2. `guoluo_questions` / `guoluo_answer` / `guoluo_report`

`lib/questions.mjs`：六类固定 key 的问题，只问证据决定不了的事。

| key | 什么时候出 | 建议值从哪来 |
| --- | --- | --- |
| `stack` | 总是 | `inferStack` 判断到「有没有页面/样式/打包产物」这一层，用哪种实现属于用户选择 |
| `missing` | `coverage.missing > 0` | 先留缺口，复刻到那一步再处理 |
| `tokens-conflict` | `spec.conflicts` 非空 | 以出现次数最多的那份为准 |
| `tokens-source` | 令牌数为 0（与上一条互斥） | 先从品牌图取主色，其余留空 |
| `assets` | 资产 ≥ 200 | 关键界面用原素材，其余重画 |
| `native` | executable + library + other > 0 | 首版只覆盖界面与静态资源 |
| `name` | 总是 | label 的 slug |

key 固定（不随证据条数变化），所以同一批次重新生成时旧答案能对上；换批次时 `note` 明写「换了批次，上一批的答案没有沿用」。答案落在 `<id>/questions.json`，`applyAnswer` 拒绝未知 key（错误里列出可答的 key）、空答案与超过 2000 字的答案。

`lib/report.mjs`：八节 Markdown，落在 `<id>/report.md`。三条口径写死在正文里——目标程序没有运行、技术栈判断是推断不是观测、空集不是核对通过。

### 3. 落盘位置：档案根，不是子目录

`questions.json` 与 `report.md` 直接放在 `<archiveRoot>/<id>/`。理由：它们是会被反复改写的工作状态，不是「一批一份」的派生产物；放进 `brief/` 那种以批次命名的目录里，会让人以为换个批次就得重新答一遍。写入仍走 `writeDerived`（先写 `.new-*` 再 rename），中途失败不会留半份。

## 验收

- `npm run test:serial`，三个固定样本环境变量全开（UnityFS v9 包、IL2CPP 元数据、真实 REA 6.8.0）：**195 tests / 195 pass / 0 fail / 0 skipped**。新增 `tests/questions.test.mjs` 7 条。
- `tests/dossier.test.mjs` 的工具数 15 → 18；`dsh-plugin.naming.json` 补齐三项。
- `tests/host-smoke.mjs`：工具名单 18 项；新增三样断言——`agentPresets.list()` 里有 `guoluo-rebuild` 且 `broken` 为空、`name` 为「复刻工坊」；`questions → answer → report` 三连（含同批次沿用答案）；回执里带 `preset: 'guoluo-rebuild'`。
- 打包与隔离 smoke 的数字见本条目的提交说明。

## 残留

- P3 才做 Web/Electron 的生成适配器；`scaffold` 目前只是证据底座。
- 预设改动对新会话生效，已存在的会话保持启动时的插件组成——重启后要开新会话验收。
- 问题清单的六类规则是经验值（200 个资产、令牌冲突数），不是统计结论；不合适的阈值应当随真实项目调整，而不是先加更多规则。