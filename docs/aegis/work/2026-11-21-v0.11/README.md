# v0.11.0 — UnityFS 数据区解压与节点指纹

## 目标

接着 v0.10.0 记下的剩余缺口往下走：UnityFS 之前只到块表与节点表，节点内容完全没观测。这一版把可解压的数据区按节点切开，给每个节点留下可核对的指纹，仍然不保存节点内容。

## 交付

- `lib/unity.mjs`：新增 `extractPayload()`。按块表顺序切分数据区，`compressionCode` 0 直读、2/3 用插件自己的 `lz4BlockDecompress()` 解压；逐块校验解压长度与声明一致，汇总长度必须等于块表声明的逻辑长度。之后按节点 `offset`/`size` 切片，记录 `size`、`sha256`、`magic`（`unityfs` / `serialized-file` / `zip` / `zero-filled` / `binary`）与 `preview`（前 24 字节十六进制）。
- `limits` 新增 `payloadBytes` 64 MiB、`payloadNodes` 32、`previewBytes` 24。数据区超出 64 MiB、或任一块是 LZMA/LZHAM 时，`payload.status` 保持 `unobserved` 并写明原因，不返回半份载荷。
- 解压或长度校验失败一律降级为 `{ status: 'unobserved', reason: '数据区解压失败：…' }`，不抛到调用方，也不返回部分节点。
- `lib/spec.mjs`：Unity 未知项与 Markdown 说明改为「读取块信息段、节点表与可解压数据区；LZMA/LZHAM 压缩块、IL2CPP 元数据字段表、资源内部结构与运行时依赖未观测；节点只记大小、SHA-256、类型魔数与 24 字节前缀」。Markdown 每份 UnityFS 追加「载荷 N 个节点 M 字节」或载荷未观测的原因。
- `lib/inventory.mjs`：Unity 说明同步。
- `README.md`、`skills/guoluo-rebuild/SKILL.md`：同步 Unity 覆盖范围与「只记指纹、不留内容」。

## 关键实现约束

- 节点内容永不落盘：只算 SHA-256、读 24 字节前缀判类型。整批证据因此不会因为包里有大资源而膨胀。
- 解压前先按 `limits.payloadBytes` 拒绝，避免按块表声明分配超大缓冲；解压后再核对总长与块表声明的逻辑长度，防止块表与数据区不一致时切出假节点。
- 节点数超过 32 时 `truncated: true`，只列前 32 个，不静默截断。
- LZ4 解压器与 v0.10.0 解块信息段共用同一实现，含自重叠回填与越界检查。

## 验证

- `node --test tests/unity.test.mjs`：15 项全过。其中两份真实夹具（UnityPy 生成的 v6 无压缩包、v7 尾置 LZ4 包）解出的节点一致：`bytes 14`、SHA-256 `e5de319f964572a88cc57c63161098d5a0afcaf62866fe1b467e9ee16914d062`、前缀 `67756f6c756f2d66697874757265`（`guoluo-fixture`）。
- 独立复算：对 `guoluo-fixture` 这 14 字节直接做 SHA-256，与上面一致。
- `$env:GUOLUO_TEST_REA='D:\Tools\bin\rea.cmd'; npm run check`：**97 项全过 0 失败 0 跳过**，打包 23 文件 65.6 kB / 解压 204.9 kB。
- 隔离宿主：交付包离线安装后在隔离 DSH 0.2.2-rc.5 profile 冷启动 `tests/host-smoke.mjs`，`{"result":"passed","version":"0.11.0","tools":11,"linkedRea":"verified","pck":2,"unity":"lz4"}`；smoke 断言 LZ4 包节点的 `payload.status`、`bytes` 与 `sha256`，以及无压缩包节点的 `magic`。

## 未验证与边界

- LZMA 与 LZHAM 压缩块仍未支持，遇到即 `unobserved`；没有这类真实夹具，无法验证解压路径。
- 加密 UnityFS 扩展仍然整包跳过，未尝试解密。
- IL2CPP 元数据只到声明版本与头长，字段表（字符串、类型、方法）未读取。
- `preview` 是原始字节前 24 字节，不代表节点内容已解析；`magic` 只按已知签名着色。
- 本机没有真实商业 Unity 包，本轮夹具全部来自仓库脚本与 UnityPy 回读，合成夹具与实现同源的风险仍在：指纹一致性只能证明「解出来的字节由块表与节点表共同决定」，不能证明对任意真实包都成立。
- 未跑一次完整全量后单档 `kind: 'environment'` 的偶发失败仍未定位（v0.10.0 记录已列，本轮三次全量未复现）。

## 校验和

- `zhuifengqug-dsh-guoluo-0.11.0.tgz`：65616 字节，SHA-256 `3FF38EE1C3A3788FC3B1FFFB2C69AB9ACD712203407178ABAB022227F37262E2`。
