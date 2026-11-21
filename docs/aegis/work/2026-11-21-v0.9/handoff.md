# 规格交接实跑 · 2026-11-21

蜾蠃生成了规格，DSH 子代理仅凭规格写出三个静态文件，视觉核对测得 **28.27%–34.90% 的像素发生变化**。规格能交接文件清单、引用和令牌。页面结构、布局、页内导航及原图仍需补证，候选只能在这些地方自行推断。

## 实跑步骤与原始输出

1. 在 `%TEMP%\guoluo-t4-dc56f303\source\fixture` 自制夹具。`index.html` 是中文「北岸观测站」，含一条 `查看站点指南` → `#guide` 导航及一张 `240×120` 的自制 `tide.svg`。`app.css` 有 `--ink: #173750`、`--paper: #edf6fb`、`500px` 断点和键盘焦点样式。`source` 为临时 `sourceRoot`，独立的 `archive` 为 `archiveRoot`。
2. 以起始提交 `a251747c1698c9227b502598cfdcd623a38e6eef` 的 `npm pack` 产物锁定版本，使用 `@zhuifengqug/dsh-guoluo@0.8.1`，tarball SHA-256 为 `972c957a0da4eb2510214b75a67c6932567540a7adf1652df98123a8756b68e6`。Windows、Node `22.23.4`、DSH `0.2.2-rc.5`、REA `6.8.0`。用临时宿主脚本 `node <临时根>/handoff-run.mjs produce <DSH 安装包目录>` 调用已安装 DSH 的 `runProfile`，以 `DSH_HOME=<临时根>/host-home` 加载真实打包产物。通过 `settings.update` 配置双根，从宿主工具注册表直接调用 `guoluo_target_add({kind:'local',location:'fixture',label:'自制交接样例'})` → `guoluo_dissect({id})` → `guoluo_spec({id,runId})`。并行工作树变化没有进入包或本轮测量。
3. 将原样 `spec.md` 交给隔离 `headless` 父会话，由原生 `subagent` 工具创建 `replicator`。启动入口为 `node <DSH 安装包目录>/lib/bin.js --profile headless --patch <隔离代理根>/route.patch.yml --json -`，`DSH_HOME=<临时根>/agent-home`，`DSH_PERMISSION_MODE=workspace-write`，模型路由为 `magpie / auto/deepseek-v4.1-flash`。输入只含任务约束与规格正文，候选工作目录 `candidate-spawn` 初始只有 `spec.md`。设置不引用 Desktop profile。首次命令行尝试在模型调用前因 `MISSING_CREDENTIAL` 停止，改用隔离配置与已可用路由后完成了实际子会话。本报告的候选数据取自该子会话。
4. 子会话生成了 `index.html`（2249 B）、`app.css`（9567 B）、`tide.svg`（5629 B）。它保留两个令牌及文件引用，编写了英文潮汐专题页、响应式排版和新的竖版 SVG。子会话在静态引用检索和 SVG XML 校验处停止。父会话汇报没有执行页面或真实交互。回读候选也确认页面缺 `#guide` 导航，且断点和图像规格由子代理自行选择。
5. 用相同宿主入口的 `spawn-check` 阶段执行 `guoluo_check({id,runId,visual:{candidateDirectory}})`。先用 `../candidate-spawn` 验证边界，再把三份产物按字节复制到 `source/handoff-candidate-spawn`，与登记的 `source/fixture` 同级。比较复制前后 SHA-256，并在核对前后断言基准文件和候选快照未变，规格也与原始摘要一致。两边入口都是 `index.html`，视口宽度为 `390/768/1440`，高度 `900`，设备像素比 `1`，通道阈值 `0`。

下列从真实工具结果挑选字段，省略其余字段。档案号 `700d1684-d28e-48c6-a000-d38a866ab764`，批次号 `1795230413200-7a205f06-75d8-4fbc-9751-3beed47057b2`。

```json
{"name":"guoluo_target_add","result":{"kind":"local","location":"fixture","status":"registered"}}
{"name":"guoluo_dissect","result":{"meter":{"durationMs":4051,"rows":7,"textBytes":1104,"visited":3},"totals":{"asset":3,"token":2,"navigation":0,"reference":2}}}
{"name":"guoluo_spec","result":{"counts":{"structure":0,"style-token":2,"route":0,"reference":2,"asset":3,"other":0},"conflicts":0}}
```

规格确实落盘于临时 `archive/<id>/spec/`。`spec.json` 的 SHA-256 为 `63e6ddb075d537a07470ee9e8f96a25effa14bdea5c7d0287cf17c09cbff9536`，`spec.md` 为 `e134d3c060d6e5dd75ba204e9f6d6771429fba7a9cffa5fe6b69079587742e7e`。`spec.md` 把两条引用定位到 `index.html:7` 与 `index.html:14`，页面结构和路由章节均显示「本类无证据。」。

`spawn-events.jsonl` 中父会话 `session-b07ef234-3e82-453c-bc22-b1e548278cca` 的工具回执为 `started subagent replicator`，最终 `reason.kind` 为 `completed`。隔离 `agent-home/sessions` 中候选工作目录下另有子会话 `7bde0682-39ec-4646-9c7c-cc507a498887` 的持久会话文件。收到子会话结果后，父会话原文摘录如下。

> **停点**：完成三份静态文件并进行引用检索与 SVG XML 校验；未打开浏览器、未启动服务器、未执行目标代码、未发起外部请求，因此没有真实渲染与交互验证。

```json
{"candidateDirectory":"../candidate-spawn","verdict":"complete","visual":{"scope":"static-html-viewport","status":"blocked","kind":"invalid-input","reason":"路径包含空段、保留名或上级跳转。"}}
{"candidateDirectory":"handoff-candidate-spawn","verdict":"complete","orphans":0,"dangling":0,"stale":false,"conflicts":0,"visual":{"scope":"static-html-viewport","status":"measured","widths":[390,768,1440],"height":900,"deviceScaleFactor":1,"channelThreshold":0}}
```

| 视口 | `status` | `changedPixels` / `comparedPixels` | `changedRatio` | 变化像素占比 |
| --- | --- | ---: | ---: | ---: |
| 390×900 | `different` | 122485 / 351000 | 0.34896011396011395 | 34.90% |
| 768×900 | `different` | 195409 / 691200 | 0.28270978009259257 | 28.27% |
| 1440×900 | `different` | 429319 / 1296000 | 0.33126466049382713 | 33.13% |

工具未输出总分或通过阈值。`verdict: complete` 表示当前批次证据自洽。`visual.status: measured` 表示成功测量，三个 `different` 表示各视口都有变化。`0.8.1` 的视觉回执原文如下，计算与校验口径限于本次打包版本。

> 只衡量相同视口内变化像素的比例；禁用脚本和外站请求，不代表动态页面、功能或整体复刻质量。差异像素数由 REA 计算，本插件只校验其与本次截图指纹、尺寸和代数关系的自洽性，未独立复算像素。

负例报告为临时 `archive/<id>/checks/check-1795231746397-553cb509-fca5-4500-8ad0-1d86b29c7fd3.json`。正例报告为同目录的 `check-1795231746426-d92d34f9-e7c2-4836-a140-2bd429598442.json`，截图与 `*-diff.json` 在同名子目录。报告记录的基准 HTML 和候选 HTML SHA-256 分别是 `58a64f959a17a6bc5be0a7588524a96f0dbbbb102a9d52cfbeab8bca80ddddb3` 与 `237940bd000c2594d970c145a885ffbebe965220cacef576fec667dff3e96cce`。以上临时文件仅作为本机证据保留。

## 规格里缺失的关键信息

| 类别 | 规格交付的事实 | 与夹具对照发现的缺口和结果 |
| --- | --- | --- |
| 结构 | 文件名 `index.html`，`structure: 0` | 缺 `zh-CN`、标题和正文、导航与主内容的层级、`h1` 与指南 `section`。候选自行生成英文专题页、事实列表和页脚。 |
| 样式 | 两个 CSS 自定义属性及行号 | 缺 `:root` 作用域、令牌与元素的映射、`46rem` 最大宽度、`1.5rem` 内边距、`500px` 断点。候选保留色值，并自行选择排版和 `900/620/470px` 断点。 |
| 交互 | `route: 0`，未知项只标出运行时证据缺失 | 缺静态可见的 `查看站点指南`、`href="#guide"` 与目标 `id="guide"` 的绑定，以及 `:focus-visible` 规则。候选没有复作该链接。点击、键盘聚焦和滚动未执行验收。 |
| 资源 | `app.css`、`tide.svg` 的路径及两条 HTML 引用定位 | 缺 `alt`、`240×120` 显示尺寸、图像指纹及本次可随规格交付的原始图像内容。候选绘制新图，HTML 记录 `640×880`，保留相同文件名。 |

`spec.md` 还给出这条原始未知项：「ASAR 只盘点头部资产目录：归档成员未解包，成员内容与内部依赖图未读。」本夹具没有 ASAR，该条对这次交接无用。

## 改进项与验收边界

1. 优先补静态 HTML 的结构证据和页内锚点绑定。基线的 [inventory.mjs](<../../../../lib/inventory.mjs>) 给 HTML 产出资产与引用，过滤 `#` 引用，未产出 [spec.mjs](<../../../../lib/spec.mjs>) 用来生成结构义务的 `page` 行。用同一夹具回归文档语言、标题、标志性元素、可见文本，以及锚点文字和目标。对 HTML 做有限量的静态读取就能补齐这组字段。
2. 为 CSS 令牌补选择器作用域、使用位置和媒体查询，图像补尺寸、`alt` 和内容指纹。决定允许随规格交给子代理的本地素材内容形式，避免让子代理自行猜图或读取登记根。把 ASAR 未知项改为依据本批实际素材种类生成。
3. 将候选路径约定放入交接指南，注明静态候选快照应在 `sourceRoot` 内且与基准分开。明确显示证据状态、视觉测量状态和功能验收状态。此次复现了 `complete` 同时伴随 `visual.status: blocked` 的情形，需决定工具或界面是否应在视觉被显式请求时突出提示这一组合。

实跑只覆盖一个本地静态入口与三个视口。动态交互、外部服务、历史包格式和 v0.9 的多路由及 PNG 独立复算仍须用各自的验收证据。缺陷和决策留在本报告，产品代码不在本切片改动范围内。
