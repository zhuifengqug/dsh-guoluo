# 蜾蠃 v0.6.0 · EXE/DLL 离线静态盘点

## 目标

把 Windows PE 二进制（`.exe`/`.dll`）纳入只读盘点：不反编译、不解析资源与证书、不运行，只从 DOS/COFF/可选头、节表、导入导出表与 CLR 目录标记取出可复查事实，接进既有的证据 → 规格 → 导出链路。

## 交付

- 新增 `lib/pe.mjs`：`parsePe(path, signal)`。
  - DOS 头（`MZ`、`e_lfanew@60` ≥ 64）、COFF（`PE\0\0`、machine、节数 ≤96、可选头长度 96–4096）、可选头（`0x10b` PE32 / `0x20b` PE32+）、头大小自洽校验。
  - 节表逐项：名称、`virtualSize`、`rva`、`rawSize`、`rawOffset`，原始范围越界即抛「PE 节范围越界。」
  - `range(rva)` 要求**唯一**文件字节映射（头部或某一节），否则抛「PE 目录引用没有唯一的文件字节范围。」——避免多节重叠时给出错误字节。
  - 导入表：描述符 ≤64、符号 ≤128、`IMAGE_ORDINAL_FLAG`（32/64 位）识别序号导入、名称按 ASCII 校验、缺终止项抛错。
  - 导出表：`ordinalBase`、`functions`、`count`、`names`/`ordinals` 表，序号越界抛错。
  - CLR 目录（index 14）与 delay-import（index 13）只记声明与 `{rva, size}`。
  - 读取前后比对 `size`/`mtimeMs`/`ctimeMs`，变化即抛「PE 文件在读取期间发生变化。」
  - 数据目录不可读时不中断整批：`imports`/`exports` 记为 `{status:'unreadable', reason}`。
- `guoluo_target_add` 接受 `.exe`/`.dll`；`types` 映射新增 `executable`/`library`。
- 目录盘点遇到 PE 时登记 `asset` 行 `{kind:'asset', path, type:'executable'|'library', bytes, binary:'pe'}`，并把事实写进批次 `pe[]`：
  `format`、`machine`、`subsystem`、`bytes`、`imageBase`、`entryPointRva`、`timestamp`、`sectionCount`、`sections[]`、`imports{status,items[{dll,symbols[]}]}`、`exports{status,namedCount,items[]}`、`clr`。
- `guoluo_spec` 增 `evidence.pe.files[]` 投影与 markdown「原生二进制（PE）」表（文件/格式/架构/子系统/节数/导入 DLL/命名导出/CLR），并加固定未知项「PE 只解析头部、节表、导入与导出表及 CLR 目录标记：未反编译、未解析资源与证书、未运行二进制；导入函数只登记名称与序号，签名与调用关系未验证。」
- `guoluo_mock` 跳过 `binary:"pe"` 的素材行，记进 `unreplayed`（原因「原生二进制，不回放」）。
- PE 不触发 REA；`rea.status` 为 `skipped`，原因列出「ASAR、APK、PE 与单文件需先解包成目录再登记」。

## 关键实现约束

- 每个 PE 文件的解析全在固定上限内：节表 ≤96、导入描述符 ≤64、符号 ≤128、导出名 ≤128、名称 ≤256 字节；批次最多深度解析 16 个 PE，超出记 `clipped`。
- 投影进 `pe[]` 时再裁一次：节 ≤24、DLL ≤24、每 DLL 符号 ≤12、导出 ≤24，避免整包回灌。
- 只读 `open(path,'r')`，从不写；不执行、不映射、不做签名校验。
- 目录引用必须唯一映射，宁判 `unreadable` 也不猜一段字节当作导入表。

## 验证

- `npm test`：38 项，36 过 2 跳过（真实 REA 用例按需）。新增 `tests/pe.test.mjs` 5 项：
  - PE32+ 合成 fixture 解出 `pe32+`/`x64`/`windows-cui`、`.text` 节、`DEMO.dll` 的 `CreateThing` 与序号 3、导出 `DoThing` 序号 1、CLR 声明为真。
  - PE32 fixture 走 32 位宽度，`imageBase 0x400000`，序号位 `0x80000003` 正确识别。
  - 导入/导出目录指向节外 → `status:'unreadable'` 且带 `reason`，不抛错。
  - 截断文件抛「PE 文件范围越界。」，非 PE 文件抛「PE DOS 头无效。」
  - 目录内含 `index.html` + `app.exe` 时：`asset` 行精确等于 `{kind:'asset',path:'app.exe',type:'executable',bytes:1536,binary:'pe'}`，`spec.json` 的 `evidence.pe.files[0].dlls` 含 `DEMO.dll`，`spec.md` 有「原生二进制（PE，1）」表，`mock.json` 的 `unreplayed` 含 `app.exe` 且原因含「原生二进制」。
- `npm run check`：打包 20 文件 124.6 kB（tarball 41.3 kB）。
- 隔离宿主（真实 DSH 0.2.2-rc.5）：

```
{"result":"passed","tools":11,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,
 "rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified",
 "derived":{"spec":2,"tokens":1,"exported":2,"mock":0,"check":"complete"}}
```

## 未做与边界

- 不反编译、不做反汇编分析；节内容除导入/导出表外不读。
- 不解析资源目录（图标、版本信息、清单）、不解析证书/签名目录、不解析 load-config / TLS / 重定位细节。
- 不跟进 delay-import 的符号，只记目录声明。
- `.NET` 只标 CLR 目录存在，不解析元数据（不列类型与方法）。
- Unity/Godot、craft-anything 后端与复刻工程骨架仍未接入。

## 校验和

`deliverables/zhuifengqug-dsh-guoluo-0.6.0.tgz`（41278 字节）
SHA-256 `733688A50BD078CF1839AC4362F5B9E652DBE6B7001982DE8287831540A05842`
