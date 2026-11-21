# 蜾蠃 v0.18.0 — 用独立工具交叉核对清单解析

## 目标

前面几片（APK、PE）的解析器都只有自己写的合成夹具做回归，夹具和实现同源——同源夹具能证明「代码按我的理解跑」，不能证明「我的理解和真实工具一致」。这一片给两条解析链各加一条**独立参照**：APK 用 Google 的 `aapt2` 重新解析同一份包，PE 直接读系统目录里的真实二进制。参照物不通过就说明解析器有错，不是夹具写错。

## 交付内容

1. 新增 `tests/apk-cross.test.mjs`：
   - 用 `aapt2 link` 从一个已知清单生成 APK（包名 `com.example.cross`、`versionCode 7`、`versionName 1.2.3`、min 24 / target 34、label「Cross Check」、三条权限、一个 MAIN/LAUNCHER 活动与一个普通活动）。
   - 插件的 `dissect` 解析同一份 APK 的二进制清单，再与 `aapt2 dump badging` 的输出逐项比对：包名、版本号、版本名、min/target SDK、label、权限集合、启动活动、活动总数、别名数。
   - 权限与活动的完整名字通过 `kind: apk-permission` / `kind: apk-activity` 分页取回后比对，顺带验证分页内容与清单摘要一致。
   - 找不到 `aapt2` 或 `android.jar` 时 `t.skip`，不把「没装 Android SDK」算成失败；路径可用 `GUOLUO_TEST_AAPT2` / `GUOLUO_TEST_ANDROID_JAR` 指定。
2. `tests/pe.test.mjs` 新增「系统 PE 文件能过头部与节表，且节范围落在文件内」：
   - 读 `%SystemRoot%\System32` 下的 `kernel32.dll`、`ntdll.dll`、`user32.dll`、`notepad.exe`（存在几个读几个）。
   - 断言格式是 `pe32*`、至少一个节、每个节的 `rawOffset`/`rawOffset+rawSize` 都落在文件内、导入与导出状态在允许集合内、`parsed` 导出的 `namedCount` 非负——用真实二进制验证「节窗口裁剪」与「范围检查」不会在真文件上误判。
   - 一个样本都没有时 `t.skip`。
3. `README.md` 开发段补这两条交叉核对的启用方式与跳过条件。

## 验证

- `GUOLUO_TEST_REA=D:\Tools\bin\rea.cmd npm run test:serial` → **125 项全过 0 失败 0 跳过**。
  - 其中 `tests/apk-cross.test.mjs` 在本机（`aapt2` 35.0.0 + android-35 jar）通过，比对全部一致。
  - `tests/pe.test.mjs` 的系统 PE 用例在本机读取 4 个真实文件通过。
- `npm run check` → 打包 25 文件 77.1 kB。
- 隔离宿主：从本包 tarball 离线安装后冷启动 `tests/host-smoke.mjs` →
  `{"result":"passed","version":"0.18.0","visual":null,"tools":12,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,"rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified","derived":{"spec":2,"brief":true,"tokens":1,"exported":2,"mock":0,"check":"complete","candidate":"partial"},"pck":2,"unity":"lz4"}`

## 未验证与边界

- aapt2 与系统 PE 两条用例都依赖本机环境，换一台机器（无 Android SDK / 非 Windows）会自动跳过，跳过不等于通过；发布说明里不把它们算作「在所有机器上都验证过」。
- aapt2 交叉核对只覆盖清单事实（包名、版本、SDK、label、权限、活动）；资源表、签名、dex 内容仍不在核对范围内。
- 系统 PE 用例只检查结构不变式，不比对导入/导出符号名是否与 `dumpbin` 一致（本机没有 dumpbin）。
- 其余缺口未变：LZHAM 块、UnityFS v9 块表、IL2CPP 元数据字段表、加密 PCK 实际区间、craft-anything 后端（保持关闭）、复刻工程骨架（暂缓）、小说流程（最后）。

## 校验和

- `deliverables/zhuifengqug-dsh-guoluo-0.18.0.tgz`
  - 字节数：77066
  - SHA-256：`2259068B39DDA2B71B6FF990F41ADB33D2C60FAFE2258081C32075A01A6C0DBD`
