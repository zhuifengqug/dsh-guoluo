# v0.19.0 — IL2CPP 类型与字段表

## 目标

在 v0.18.0 的基础上补掉 Unity 侧最后一块可离线验证的静态证据：`global-metadata.dat` 的类型名与字段名，并让它们能被分页读完、进得了规格。其余缺口按 G 在 m04452 的裁决处理：LZHAM 标明确不支持，UnityFS v9 块表等真实样本，加密 PCK 维持只核起点。

## 交付

- 新增 `lib/il2cpp.mjs`：32 段区段表、已核对布局（v24）的类型表 92 字节与字段表 12 字节解码、名字池、`inspectIl2cpp` 与 `readIl2cppPage`（`il2cpp-types` / `il2cpp-fields`）。
- `lib/unity.mjs` 的 `inspectUnityHeader` 把 `il2cpp-metadata` 分支交给新模块；原来只读 12 字节头的 `parseIl2cpp` 与版本白名单一并删除，避免两处各说一套。
- `lib/projects.mjs`：`dossierKinds` 加两类，新增 `il2cppPage`（复用 PE 页的路径解析与 `source: current-file` 口径），`headersRead` 把 `parsed`/`unverified` 也算作读到了头。
- `lib/spec.mjs`：证据表按 `parsed` 给出类型/字段/方法/程序集计数与前三个类型名，`unverified` 给出原因；unknowns 改成「LZHAM 压缩明确不支持」与「未核对版本只记录了头部」。
- `lib/inventory.mjs`：Unity 证据说明按新口径重写。
- `index.js`：`guoluo_dossier` 的 kind 枚举与描述加上 `il2cpp-types` / `il2cpp-fields`。
- 文档：README 第 4 步与 Unity 段、`skills/guoluo-rebuild/SKILL.md` 第 3、4 步同步。

## 关键约束（实测得出）

- 样本 `skillz/integration-examples` 的 `global-metadata.dat` 在 Git LFS 里，必须走 `media.githubusercontent.com/media/...`；本机保留的是 2 413 208 字节、version 24 的 iOS 导出。
- 区段顺序固定为 32 段；`typeDefinitions` 245088 / 2664 = 92 字节，`fields` 129804 / 10817 = 12 字节，由此确认偏移表：name@0、namespace@4、declaringType@16、fieldStart@36、methodStart@40、methodCount@68、fieldCount@72、nestedTypeCount@76。
- 我曾把 `methodCount`/`fieldCount` 读成 72/76（错位一槽），表现为类型 1 的方法数从 4 变成 1；修正后与 REA 完全一致。
- 字段的 `declaringType` 由类型表的 `[fieldStart, fieldStart + fieldCount)` 反查，二进制搜索，不按类型数 × 字段数扫描。

## 验证

- 独立参照：`REA 6.8.0 inspect-il2cpp-metadata`（必须带 `--evidence_output`，否则 `invalid_request`）。样本上 REA 报 sections 32、images 24、types 2664、fields 10817、methods 16567、string_literals 4065，插件逐项一致；首三个类型名 `<Module>`、`<>f__AnonymousType0``1`、`Locale` 一致；字段 0/1/2 的 `declaringType` 1/5/6 一致。
- `tests/il2cpp.test.mjs` 4 项：合成 v24 结构与计数、分页游标语义（末页 `nextOffset` 为 `null`）、未核对版本只报头与坏标识/越界拒绝、经 `projectService` 的端到端（盘点 → `binary` → `il2cpp-types` → `il2cpp-fields` → 规格 Markdown 与 `evidence.unity`）；真实样本用例由 `GUOLUO_TEST_IL2CPP` 门禁。
- 带真实 REA 与真实样本的串行全量：130 项全过、0 失败、0 跳过。
- 隔离宿主 smoke（`DSH 0.2.2-rc.5`，真机 load）新增合成 v24 元数据：`binary` 行 `status: parsed`、`counts.types: 1`，`il2cpp-types` 页 `source: current-file`、读回 `Demo.Type`、`nextOffset: null`。
- `npm run check` 打包 26 文件。

## 未做与边界

- 样本与 REA 证据包不进仓库（`docs/aegis/work/*/tmp/` 已忽略）：`meta-2020.3.12.dat` 与 `rea-il2cpp.json` 各约 2.4/2.7 MB，需要时按上文 URL 重新取。
- 只登记 v24 布局。27/29/31 及 24.x 子版（头长 272）不按猜偏移读表，只回 `unverified`。
- 方法体、字段类型签名、属性、事件、泛型实例与运行时行为不读；字符串字面量只计数不取值。
- LZHAM 压缩明确不支持；UnityFS v9 块表等真实样本；加密 PCK 仍只核条目起点与声明大小。
- craft-anything 执行后端保持关闭；复刻工程骨架暂缓；小说流程排最后。

## 校验和

- 交付包：`deliverables/zhuifengqug-dsh-guoluo-0.19.0.tgz`
- SHA-256：`438AC99A8E0603F676F9609C4A16F216A474450ADFA5E5A727146BA496886AD5`（80 947 字节）