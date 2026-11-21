# 蜾蠃 v0.9.0

## 发布内容

- 视觉核对支持 1–16 条本地静态路由，每条按 390、768、1440 像素宽度测量，高度为 900。蜾蠃独立解码 PNG，变化像素计数与 REA 对齐后才给该路由三档评分。发生冲突时保留双方计数。默认核对结论写明「本分数按逐通道 0 阈值计算，含抗锯齿差异」。
- APK 对照 ZIP 中央目录和本地头，限制二进制清单属性解析预算。权限与活动在盘点时整批落盘，`guoluo_dossier` 新增 `kind=apk-permission` 与 `kind=apk-activity`，按 `offset` / `limit` 读已落盘证据续页，不重新解包素材。旧批次只保留首页时回执 `stale: true` 并提示重新盘点。
- PE 在节映射范围内读取名称，校验命名导出引用的地址槽位，并记录前 128 个命名导出中不同槽位引用同一非零 RVA 的组数。
- UnityFS 读取可验证的未压缩块表和节点表，并记录截断范围。IL2CPP 目前记录版本和头布局证据。压缩块信息、节点载荷、IL2CPP 字段表仍待覆盖。
- 在隔离 DSH 中使用 v0.8.1 安装包实跑静态规格交接。真实子代理用规格生成了三个文件，三档变化像素为 34.90%、28.27%、33.13%。实验记录了结构、作用域及断点、页内导航、原始图像四类规格缺口。[交接实验](handoff.md)
- craft-anything 本轮交付接入设计与边界核对。[接入边界](../2026-11-21-v0.8/craft-anything-boundary.md)

## 验证

- `npm run check`：95 项测试全过、0 失败、0 跳过（含两项真实 REA 三档视口用例）；`npm pack` 打包 23 文件，63.5 kB。
- 隔离 DSH 0.2.2-rc.5 从交付包安装 10 个依赖后冷启动：

  ```
  {"result":"passed","version":"0.9.0","visual":{"status":"measured","routes":2,"scores":[1,1]},"tools":11,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,"rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified","derived":{"spec":2,"tokens":1,"exported":2,"mock":0,"check":"complete"},"pck":2,"unity":"lz4"}
  ```

- 宿主 smoke 覆盖：11 个工具名、设置热更新、真实 REA 绑定、PCK 真包（2 条目）、UnityFS 尾置 LZ4 与未压缩块/节点表、PE32+ 头部、APK 70 条权限的跨页读取。
- 交付包 `deliverables/zhuifengqug-dsh-guoluo-0.9.0.tgz`，63453 字节，SHA-256 `A47D21FD487315CD4E24F49DF104491B7D6C0326B7E2C56CA8585874D4AFEC96`。

## 边界

- 视觉分数只衡量同一视口内的变化像素比例，禁用脚本和外站请求，不代表动态页面、功能或整体复刻质量。16 位或隔行 PNG 仍整档判为 blocked，不做降级。
- APK 与 PCK 的归档成员只登记名字和大小，不解压内容、不校验签名、不运行应用。PE 未反编译、未解析资源与证书。
- Unity 压缩块信息、节点载荷与 IL2CPP 元数据字段表未交付；加密 PCK 条目的实际存储区间未核验。

## 待拍板

- APK 清单的采集预算：目前权限与活动各保留 256 条、每份 64 KiB 字节预算，超出只留前缀并标 truncated。相对 `limits.entries` 12000 与 `rows` 4000 偏紧，是否放大。
- 16 位或隔行 PNG 是否改为给出警告而非整档 blocked。
- `maximumChannelDelta` 与 `meanAbsoluteChannelDelta` 是否从并列证据升级为硬校验。

## 后续（v0.10.0）

三项均已按 G 的决定落地：APK 预算放大为每类 512 条 / 单类 256 KiB；16 位与隔行 PNG 保持整档 blocked；两项通道差值升级为硬校验。UnityFS 块信息段同期支持 LZ4/LZ4HC。详见 [v0.10.0 记录](../2026-11-21-v0.10/README.md)。
