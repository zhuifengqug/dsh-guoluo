# 蜾蠃 v0.17.0 — PE 导入与导出符号可按页读全

## 目标

盘点时为了不让一批证据回灌整包，PE 的导入 DLL 只留前 24 个、每个 DLL 前 12 个符号、命名导出只留前 24 条。这在真实 DLL 上明显不够：`kernel32.dll` 的命名导出有 1698 条，导入表横跨 104 个 DLL、1276 个符号。这一片让这些全量证据可以从档案里按页读完，而不是「只看到被截断的摘要」。

## 交付内容

1. `lib/projects.mjs` 新增 `pePage({ record, data, kind, path, offset, limit, signal })`：
   - 新增两个证据类别 `pe-imports` 与 `pe-exports`（进 `dossierKinds`）。
   - **回到源文件现解析**：按登记位置解析出基准目录（登记目录时把 `path` 拼在目录后；登记单个文件时用它的父目录），再定位这批证据里登记过的那一个 PE 文件，用 `parsePe` 重新读表。不读批次里被截断的投影冒充全量。
   - 多文件时必须用 `path` 指明；`path` 不在这批证据里、或这批证据没有 PE 结果，分别给出明确错误。
   - 导入按「DLL × 符号」摊平成行，导出按「名称 + 序号」给出；都按 `offset`/`limit` 分页，`total` 是真实总量，`nextOffset` 为空表示读完，`truncated` 表示还有下一页。
2. `lib/pe.mjs` 的 `parsePe(path, signal, { nameLimit, descriptorLimit })`：符号名上限与导入描述符上限改为可选参数，默认仍是 128 / 64，保持盘点时的保守预算；只有 `pePage` 走 20000 / 512 的读取上限。
3. `index.js`：`guoluo_dossier` 的 `kind` 枚举加 `pe-imports`、`pe-exports`，新增可选参数 `path`（≤500 字符），描述里说明用途。
4. 文档：`README.md` 第 4 步与 `skills/guoluo-rebuild/SKILL.md` 第 4 步补这两个类别的用法；`header()` 里 PE 摘要的 `detail` 也指向它们。

## 验证

- `tests/pe.test.mjs` 新增两项：
  - 「PE 导入与命名导出可按 offset/limit 分页读全量」：一份带两个 PE 的目录档案，断言多文件时必须给 `path`、错误 `path` 被拒、`limit: 1` 的两页分别拿到 `CreateThing` 与 `#3`、`nextOffset` 依次为 1 与 `null`、导出页与越过末尾的空页行为正确。
  - 「单个 PE 档案可直接用 pe-imports 读符号，不必再写 path」：单文件档案默认定位，`path` 回显为文件名。
- 真实文件实测（不进仓库，只作为证据）：`C:\Windows\System32\kernel32.dll` → 命名导出 1698 条，`offset: 1600` 仍能取到第 1601–1605 条；导入 104 个 DLL / 1276 个符号，`imports.status` 为 `parsed`。全量解析耗时 234 ms。`user32.dll` 148 ms、`shell32.dll` 70 ms。
- 全量：`GUOLUO_TEST_REA=... npm run test:serial` → 118 项全过 0 失败 0 跳过。
- 打包：25 文件 76.4 kB / 解压 241.1 kB。
- 隔离宿主：从本包 tarball 离线安装后冷启动 `/tests/host-smoke.mjs` → `{"result":"passed","version":"0.17.0","tools":12,...}`，其中新增一条断言：单文件 PE 档案 `pe-exports` 页 `total: 0`、`rows: []`、`path` 回显文件名。

## 未验证与边界

- `pe-imports` 的 `total` 是实际读到的符号数；若某个 DLL 的符号数超过 `nameLimit`（20000），`status` 会是 `partial`，`note` 说明还有下一页。此时 `total` 只是这一轮读到的数量，不是理论总量。
- 仍不解析延迟导入（delay import）与绑定导入的符号名。
- 只读文件，不执行 PE。
- 其余缺口未变：LZHAM 块、UnityFS v9 块表、IL2CPP 元数据字段表、加密 PCK 实际区间、craft-anything 后端（保持关闭）、复刻工程骨架（暂缓）、小说流程（最后）。

## 校验和

- `deliverables/zhuifengqug-dsh-guoluo-0.17.0.tgz`
  - 字节数：76488
  - SHA-256：`C78D687E3BF56876B397ED5B163C4D0A4A2FB0FA3CF750F317DDCBB6384F7881`
