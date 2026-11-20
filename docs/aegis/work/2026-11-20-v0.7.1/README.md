# v0.7.1 — APK 与 PE 复审修复

独立子代理分别复审了 v0.5（APK）与 v0.6（PE）两个切片。本切片按意见修复高风险与可验证的项，并补了对应的回归用例。未修复项在末尾如实列出。

## APK 修复

- **UTF-16 字符串长度前缀（原为高严重度缺陷）**：`lib/apk.mjs` 的 `decodeUtf16Length` 按 AXML 规格用 16 位字读取长度（最高位置 1 时为双字），不再沿用 UTF-8 池的单字节规则。此前所有真实 APK 的 UTF-16 字符串池（长度 ≥ 128 字符）都会被误读。
- **条目读取的字节预算**：`readEntry` 现在接收文件大小，先校验本地头与数据区间落在文件内，再校验压缩与解压长度都在 `maxBytes` 内，避免按中央目录声明的压缩长度直接大额分配。
- **AXML 解析工作量约束**：字符串池头部、偏移表与每条偏移都校验在块内；新增累计解码字节预算（8 MiB）与属性总数上限；属性表整段校验在块内，属性步长必须 ≥ 20。
- **结构完整性**：结束标签必须与开始标签同名、文档结束时栈必须为空；否则抛错而不返回半份清单。
- **行数上限不再阻断元数据扫描**：APK 循环改用独立的 `counts.scanned` 预算，素材行上限只影响素材行输出；清单、dex/so 计数与 ABI 统计不再因为 4000 行截断而漏扫，并给出 `scanTruncated`。
- **权限与活动去重后再截断**：先按集合去重，再截 500 条，并输出 `permissionsTotal`/`permissionsTruncated`、`activitiesTotal`/`activitiesTruncated`。
- **清单状态机读**：`apk.manifestStatus` 取 `absent`/`read`/`unreadable`/`parsed`/`no-manifest`/`parse-failed`，规格不再把「清单缺失」和「未声明入口」混为一谈。
- **ZIP 成员路径语义**：成员名按 `/` 分类；含反斜杠的成员跳过登记并记一条说明。
- **十六进制整数**：`TYPE_INT_HEX` 转成数值，`versionCode` 不再退成 `null`。
- **导出保留归档来源**：`lib/export.mjs` 的 CSV/Markdown 增加 `archive` / 「来源」列，APK、PCK 成员不会在导出后丢掉出处。

## PE 修复

- **RVA 全区间唯一映射**：`requireRange` 现在除了检查起点归属，还拒绝读取区间中途跨越另一节的映射，避免用第一节的字节拼出后半段「看似 parsed」的导入/导出。
- **解析名额按尝试扣除**：`lib/inventory.mjs` 的 `binary()` 在 `parsePe` 前占用名额，解析失败也计入 `pe.files`，并把失败文件记为 `{path, status:'unreadable', reason}`。一批里最多尝试 16 个 PE，不再可能对上千个二进制反复解析。
- **工具头部不再回灌整批 PE 明细**：`header()` 把 `pe` 压成 `{files, parsed, unreadable, paths(≤50), detail}`；逐文件明细（节表、导入 DLL/符号、导出）改走 `guoluo_dossier kind=binary` 分页读取。
- **不可读与裁剪如实区分**：`exports.status === 'unreadable'` 时 `namedExports` 记为 `null`，规格表显示「不可读」而不是 `0`；不可读文件在规格表单独标注。

## 验证

- `npm test`：45 项，43 通过 2 跳过（真实 REA 用例按需）。
- 新增回归：APK 长 UTF-16 字符串/权限去重/十六进制整数、缺清单状态；PE 工具头部摘要与 `dossier kind=binary` 分页、解析失败仍消耗名额并标记不可读。
- `npm run check`：21 个文件，解包 136.3 kB。
- 隔离宿主 `node tests/host-smoke.mjs <DSH node_modules> <包目录>`：`{"result":"passed","tools":11,...,"linkedRea":"verified",...}`。

## 未修复（如实保留）

- APK 的 `activities` 明细仍随批次头部返回（已加总量与截断标记），尚未拆到分页；权限/活动明细分页待后续。
- AXML 不校验属性 `rawValue` 与 `data` 的一致性，也不校验命名空间 URI。
- PE 不校验 thunk 保留位、不交叉验证导出地址表槽位、不带出 CLR/延迟导入的 `{rva, bytes}`；这些是复审点 5 的遗留，需在后续切片按声明层「只报声明、标明未验证」处理。
- PE 的 `walk()` 对子目录 I/O 失败未做隔离（复审点 6），取消语义正常。
- APK 的 `activity-alias` 未区分 targetActivity 指向。

## 校验和

- `docs/aegis/work/2026-11-20-v0.7.1/deliverables/zhuifengqug-dsh-guoluo-0.7.1.tgz`
- SHA-256：`D2E58C39AF20CEEA7754C41EE90D887CC9EC90C41EDC7BD540692F3F4A78E477`（44441 字节）
