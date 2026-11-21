# 蜾蠃 v0.17.1 — 修正 PE 符号分页的终止语义与文档口径

## 目标

v0.17.0 让 PE 导入与导出符号可以按页读全，但独立复审发现 8 条问题，其中一条是高危：导出页的 `total` 取的是导出表声明的总数（可能大于 20000），而实际条目被读取上限截到 20000；当 `offset` 走到 20000 时返回空页、`nextOffset` 仍停在 20000，客户端会无限翻空页，「`nextOffset` 为空即读完」这个契约被破坏。这一片收掉复审意见，把分页语义、截断回执与文档口径统一。

## 交付内容

1. `lib/projects.mjs` 的 `pePage`：
   - `total` 改为「这一轮可翻阅的条数」，导出表声明的总数单独放 `namedCount`（`absent` 时为 0，读取失败为 `null`）。
   - `nextOffset = rows.length && consumed < total ? consumed : null`：空页不再给出游标，`offset` 越过可读末尾时 `nextOffset` 与 `truncated` 都为假。
   - 新增 `incomplete`（`status` 为 `partial` 或 `unreadable`）与 `source: 'current-file'`，明确符号来自当前源文件而不是历史快照。
   - `note` 改为「符号表超过读取预算；只能翻阅已解析的条目，翻页结束不代表读完整张表。」（或原表 `reason`）。
   - 源文件被删、路径失效或解析抛错时不再向上抛，而是降级成 `status: 'unreadable'` 的空页并带 `reason`，与 `binary` 证据页的不可读语义一致。
2. 测试：
   - `tests/pe.test.mjs` 新增「PE 分页到达读取预算后终止游标，并区分可翻阅条数与声明数」：构造 20001 条命名导出与 20001 条导入符号，断言最后一页 `total === 20000`、`status: partial`、`incomplete: true`、`nextOffset: null`、`truncated: false`、导出 `namedCount === 20001`，越过末尾的空页 `nextOffset` 为 `null`。
   - `tests/lzma.test.mjs` 补四类向量：匹配后接字面量（matched literal）、单字节短匹配（shortRep）、最近距离轮转（rep1–3）、距离 1200 的大位移匹配（posSlot ≥ 14 的 directBits + align）。四档都由 Python liblzma 独立压缩、逐档断言 SHA-256。
   - `tests/host-smoke.mjs` 的 PE 夹具从「只有头、没有导入导出」换成带一个导入 DLL（`DEMO.dll` / `CreateThing` / 序号 3）和一个命名导出（`DoThing`）的 PE32+，断言 `pe-imports` 取到 `['CreateThing','#3']`、`pe-exports` 取到 `['DoThing']`、`nextOffset` 为 `null`、`source` 为 `current-file`。
3. 文档：`README.md` 第 4 步把 512 KiB `clipped` 的适用范围收回到 `binary`/`apk-*` 落盘证据页，并写清符号页的 `total`/`namedCount`/`nextOffset`/`incomplete` 语义；本记录与 `2026-11-21-v0.17/README.md` 去掉「`total` 是真实总量」这类与实现不符的说法。

## 验证

- `GUOLUO_TEST_REA=D:\Tools\bin\rea.cmd npm run test:serial` → **123 项全过 0 失败 0 跳过**。
- `npm run check` → 打包 25 文件 76.9 kB / 解压 242.4 kB。
- 隔离宿主：从本包 tarball 离线安装后冷启动 `tests/host-smoke.mjs` →
  `{"result":"passed","version":"0.17.1","visual":null,"tools":12,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,"rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified","derived":{"spec":2,"brief":true,"tokens":1,"exported":2,"mock":0,"check":"complete","candidate":"partial"},"pck":2,"unity":"lz4"}`

## 未验证与边界

- 符号页的 `total` 只是这一轮读到的条数；某张表超过 `nameLimit`（20000）时 `incomplete` 为真，翻页结束不代表读完整张表——这一点已在 `note` 与文档写清，但没有提供「再提高上限」的旋钮。
- 仍不解析延迟导入与绑定导入的符号名；只读文件，不执行 PE。
- LZMA 仍不支持 LZHAM；大位移向量只覆盖到距离 1200，未覆盖到字典上限级别的距离。
- 其余缺口未变：LZHAM 块、UnityFS v9 块表、IL2CPP 元数据字段表、加密 PCK 实际区间、craft-anything 后端（保持关闭）、复刻工程骨架（暂缓）、小说流程（最后）。

## 校验和

- `deliverables/zhuifengqug-dsh-guoluo-0.17.1.tgz`
  - 字节数：76861
  - SHA-256：`D6BA08E38F3C5020CB03D08723B348483DC890225B8634C5A584CAF2D744E236`
