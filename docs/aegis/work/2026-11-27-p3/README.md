# v1.3.0 · P3 生成适配器

上一版（v1.2.0）之前，插件能回答「这批素材是什么、缺什么、要你拍板什么」，能出复刻包与素材底座，但**不能给出一个自己的工程**——`scaffold` 是逐字节搬素材，README 里也写着「不是工程生成器」。这一版补上那一步：把证据与访谈答案变成一份可打开、可改、可回核的静态工程。

## 为什么要适配器注册表，而不是再来一个 `guoluo_scaffold`

`scaffold` 的语义是「证据底座」：字节必须与档案指纹一致，多一个文件都会污染证据。生成工程正好相反——页面要被重排、脚本要被摘掉、样式要重新组织，产物是**自己的代码**，不是证据。两种语义不能塞进同一个函数，否则以后每次改生成逻辑都要先证明它没有动到证据路径。

所以新增 `lib/build/index.mjs`，本质是一张表：

```js
const adapters = { 'static-html': { id, name, summary, build, applicable } };
```

`guoluo_build` 只做三件事：选适配器（`adapterFor`，未知时报错并列出可用项）、问它适不适用（`applicable`，不适用就带着原因拒绝，不生成半成品）、把结果落盘。首版只有 `static-html`。Electron、React/Vite、Flutter 这类要做的时候，往表里加一行即可，工具签名、落盘布局、回执结构都不变——这是把「再加一种目标」的成本压到单文件的原因。

## 页面重排：保留什么，丢什么

`lib/build/reflow.mjs` 用 parse5 把证据页解析成树再重新输出，判据是**结构事实**而非视觉：

保留：标签名、文档顺序、嵌套层级、`id`、`class`、`href`、`src`、`alt`/`title`/`role`/`aria-label` 等可访问性与表单属性、正文文本、`<title>`。
丢弃并计数：`on*` 内联事件（`dropped.handlers`）、`style`（`dropped.inlineStyle`）、`srcset`（`dropped.srcset`）、白名单外属性（`dropped.attrs`）。
`<script>`/`<style>`：只留空标签占位（`emptyScripts`/`emptyStyles`），**`src` 必须一起丢**——留着等于让新页面去加载原目标的代码，那既不是复刻也不是重写，是最糟的中间态。

理由：`guoluo_check` 的结构维度比的正是页面清单、`id`/`class` 选择器、`a[href]` 原文目标与标签层级。保留这四项，自证才有意义；丢弃的那几类恰好是「照抄别人的成品」与「自己重写」的分界线。样式不再逐行搬：令牌进 `styles/project.css`，其余视觉由人决定。

**实现坑（记下来，别再踩）**：第一版用「吐开标签 → 立刻吐闭标签 → 再压子节点」的写法，输出成了 `<section></section><div></div><span></span>深一层`——结构全塌。必须用关闭帧栈：压开标签，把「关闭帧」先压栈，再逆序压子节点，弹出关闭帧时才吐 `</tag>`。测试 `tests/build-reflow.test.mjs` 第一条就是抓这个的。

## 工程名：参数 > 访谈 > 档案标签

访谈里的 `name` 问题是有建议值的，但用户答了就该算数。第一版只认工具参数，测试里 `answer({questionId:'name', answer:'我的站'})` 之后生成的工程名仍是 `site`，断言直接失败。改为三级回退：

```js
explicitName !== '' ? explicitName : (answeredName !== '' ? answeredName : record.data.label)
```

工具参数在前，因为「这一趟我就要叫这个名字」比上次访谈的答案更新。

## 落盘与自证：不可变批次，自证不等于验收

生成目录是 `build/<13 位毫秒>-<uuid>/`，与 `pack/` 同一套：先写 `.new-<批次>`、逐文件 `writeFile(flag:'wx',mode:0o600)`、`rename` 到位，失败 `rm` 临时目录。理由与复刻包相同——固定路径两次写入会在中途失败时留下新旧混合的工程，而读者无法分辨哪份是这次的。

写完立刻做一次自证：拿证据页与刚生成的页面跑 `analyzeStructure`，把 `comparedPages`/`missingCount`/`diverged` 写进 `project.json` 的 `selfCheck` 与工程 `README.md`。**这一步只证明「我按证据重排了结构」**，不证明候选合格：同一份代码既生成又判定，天然偏袒自己。要独立口径必须把目录复制回素材根，用 `guoluo_check` 带 `candidate.directory` 再核一遍——`tests/host-smoke.mjs` 走的就是这条真实路径，断言 `verdict === 'complete'`。

## 与素材底座的取舍

`planScaffold` 复用了，但生成工程**跳过所有 `origin: 'generated'` 的文件**（第一版只跳 `_scaffold/` 前缀，结果骨架写出的根 `README.md` 与本工程 README 撞名，`EEXIST` 直接中断）。素材只数非页面文件：`counts.assets` 是 css/图片/字体/音视频，页面单独进 `counts.pages`——否则「3 个资产」这种数字读起来会以为搬了三张图。

## 版本边界

- 静态 HTML 工程：结构重排 + 素材落位 + 令牌成表，脚本空占位。不含脚手架、路由框架、状态管理、构建配置。
- 不重建脚本行为、不重建交互。这一版不假装能。
- Electron 与框架工程适配器未写，位置是 `lib/build/` 下新增一个适配器。
- 结构自证只有一层（`analyzeStructure`），视觉对比仍走 `guoluo_check` 的 `visual`。

## 验收

- `node --test tests/build-reflow.test.mjs tests/build.test.mjs` 7/7；与 workbench/dossier 合跑 20/20；与 client 合跑 15/15。
- 三 env（UnityFS v9 / IL2CPP / 真实 REA）全量回归见提交正文。
- 隔离 smoke 覆盖：19 个工具、真实 `build` 调用、生成目录结构断言、复制回素材根后 `guoluo_check` 出 `complete`。

## 残留

1. 生成工程的样式只有令牌与最小重置，页面视觉需要人接手；这不是缺陷，是边界。
2. `apps` 字段只记发现的应用外壳数量，不做可用性判断。
3. 自证与验收共用同一个 `analyzeStructure`；将来若有第二套结构口径，应该让它成为可选参数，而不是偷偷换掉默认。