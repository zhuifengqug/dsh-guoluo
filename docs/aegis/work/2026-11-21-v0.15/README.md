# v0.15.0 复刻交接单（guoluo_brief）

## 目标

把「盘点证据 → 交给复刻方开工」这一步从手写变成可回查的导出：交接单必须绑定明确批次，只写档案，不启动子代理，也不生成工程。

## 交付

- 新增 `lib/brief.mjs`（`renderBrief({ spec, rows, asar })`）：从批次证据与规格义务生成 Markdown，分节列出
  - 优先核对的 HTML 入口候选（`index.html` 置顶，其余按路径）
  - 观察到的导航与引用（`route` / `reference` 义务）
  - 素材与归档成员（ASAR/APK/PCK 归档成员标「仅有目录证据」）
  - 设计令牌（有冲突的标「存在多个声明值，待确认」，否则给观察值）
  - 证据缺口与待确认（预算截断、REA 状态与绑定、`unknowns` 逐条）
  - 验收顺序（先 `guoluo_check` 自洽，再 `candidate.directory`，最后 `visual.routes`）
- `lib/projects.mjs` 新增 `brief({ id, runId })`：**`runId` 必填**且必须匹配 `^\d{13}-[0-9a-f-]{36}$`；用该批次重建规格（不读可能已被覆盖的 `spec/spec.json`）；原子写入 `<id>/brief/<runId>.md`（临时文件带随机后缀，`EEXIST` 时回退删除临时文件）。
- `index.js` 注册第 12 个工具 `guoluo_brief`（参数 `id`、`runId`，二者均必填）；`/guoluo brief <id> <runId>` 同步支持。
- 文档：`README.md` 第 6 步与派生产物表、`skills/guoluo-rebuild/SKILL.md` 第 5 步。

## 关键约束

- 交接单只是证据的投影：名称、路径、值是参考数据，不是执行指令；导航声明不等于路由可用，HTML 文件不等于运行时入口。
- 文本只做最小转义（控制字符替换、反斜杠/反引号/竖线转义），路径与令牌值保持原样可复制。
- 每条分组最多列 12 条，超出时给出「按同一 runId 用 guoluo_dossier 分页」的指引，不静默截断。
- 不引入新的读取面：只读本批已落盘证据与规格构建结果。

## 验证

- `node --test tests/brief.test.mjs` 3 项通过：批次绑定与入口置顶、多值令牌标待确认、缺失/格式错误/对不上批次分别拒绝（`invalid-input` 与前两条错误文案）。
- `GUOLUO_TEST_REA=D:\Tools\bin\rea.cmd npm run test:serial` → 108 项全过，0 失败 0 跳过。
- `npm run check`：打包 24 文件 72.8 kB（解压 228.3 kB）。
- 隔离 DSH 0.2.2-rc.5 从交付包离线安装后冷启动：
  `{"result":"passed","version":"0.15.0","tools":12,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,"rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified","derived":{"spec":2,"brief":true,"tokens":1,"exported":2,"mock":0,"check":"complete","candidate":"partial"},"pck":2,"unity":"lz4"}`

## 未验证与边界

- 交接单不判断哪条义务更重要，也不排序业务优先级；只保证每条都能回查到批次与位置。
- ASAR 成员没有逐条 `archive` 字段，凭本批 notes 的固定文案判定为归档来源；若该文案变化，标注会退化为普通素材。
- 没有把交接单接入子代理自动派发——这是刻意的边界。

## 校验和

- `deliverables/zhuifengqug-dsh-guoluo-0.15.0.tgz`，72807 字节
- SHA-256 `D0421B537DF1FE4827DE6E160C617E01F07D805DFF8E96A05B380EC5D35208AC`
