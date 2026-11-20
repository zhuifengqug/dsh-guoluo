# 蜾蠃 v0.5.0 · APK 离线静态盘点

## 目标

把 Android `.apk` 纳入只读盘点：不解压、不联网、不运行，只从 ZIP 中央目录和二进制 `AndroidManifest.xml` 取出可复查的清单事实与应用素材条目，接进既有的证据 → 规格 → 导出链路。

## 交付

- 新增 `lib/apk.mjs`：ZIP 中央目录读取（含 ZIP64 定位记录、越界与上限校验）、成员解压（store / deflate，`maxOutputLength` 限幅）、二进制 AXML 解析（字符串池 UTF-8/UTF-16、Start/End 元素、属性 typed value）、`manifestFacts` 汇总。
- `guoluo_target_add` 接受 `.apk`；`guoluo_dissect` 对 `.apk` 走静态盘点分支，返回 `apk` 段：
  - `manifest`：`package`、`versionCode`、`versionName`、`minSdk`、`targetSdk`、`label`、`permissions[]`、`activities[]`、`launcherActivity`、`activityAliases`。
  - `counts`：`entries`、`dex`、`libs`、`signatures`、`resources`、`manifest`、`dirs`、`assets`。
  - `abis[]`。
- APK 内可识别扩展名的成员（图片/字体/音视频/HTML/CSS）记成 `asset` 行，带 `archive:"apk"`，只登记字节数，不读内容。
- `guoluo_spec` 增 `evidence.apk` 投影与 markdown「APK 包名/版本/SDK/入口/ABI/条目」行，并加一条固定未知项「APK 只做静态清单解析：未解压资源内容、未校验签名、未运行应用；权限声明与实际行为未验证。」
- `guoluo_mock` 跳过 `archive:"apk"` 的素材行，记进 `unreplayed`（原因「APK 归档成员，未解包，不回放」）。
- APK 不触发 REA；`rea.status` 为 `skipped`，原因明确「ASAR、APK 与单文件需先解包成目录再登记」。

## 关键实现约束

- ZIP 只读中央目录与局部头：条目数 ≤12000、中央目录 ≤16MB、单成员解压 ≤16MB；出现 ZIP64 条目（compressed/uncompressed/offset 为 0xffffffff）直接拒绝，不做静默降级。
- AXML 解析有硬上限：字符串 ≤200000、元素 ≤100000、深度 ≤64；任何越界或结构不符抛错，不返回半份清单。
- 属性值按 typed value 还原：`TYPE_STRING` 走字符串池、`TYPE_INT_DEC/HEX` 转数字、`TYPE_INT_BOOLEAN` 转布尔、`TYPE_REFERENCE` 记成 `@0x…`（资源未解析）。
- 启动入口的判定要求 activity 下同时有 `android.intent.action.MAIN` 与 `android.intent.category.LAUNCHER`，按声明顺序取第一个。

## 验证

- `npm test`：33 项，31 过 2 跳过（真实 REA 用例按需）。新增 `tests/apk.test.mjs` 3 项：
  - 用自建的 ZIP + 二进制 AXML 素材验证包名/版本/SDK/权限/入口/ABI、dex/lib/signature/resources 计数与 `asset` 行带 `archive:"apk"`，并断言说明含「未校验签名」。
  - APK 清单事实进入 `spec.json`（`evidence.apk`）与 `spec.md`（`APK 包名 | com.example.demo`），且缺口含 APK 静态解析说明。
  - 损坏 ZIP 被拒（`/ZIP/u`）且不留下批次（`runCount === 0`）。
- `npm run check`：打包 19 文件 111.0 kB（tarball 37.3 kB）。
- 隔离宿主（真实 DSH 0.2.2-rc.5）：

```
{"result":"passed","tools":11,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,
 "rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified",
 "derived":{"spec":2,"tokens":1,"exported":2,"mock":0,"check":"complete"}}
```

## 未做与边界

- 不解压 APK 的 `resources.arsc`，应用名与图标引用仍是资源引用或字符串原值，未做资源表解码。
- 不校验 APK 签名有效性（只统计 `META-INF/*.RSA|DSA|EC` 数量）；不运行应用、不抓运行时行为。
- APK 内 HTML/CSS 成员只登记为素材行，不做文本级证据（未解压读内容）。
- EXE/DLL、Unity/Godot、craft-anything 后端与复刻工程骨架仍未接入。

## 校验和

`deliverables/zhuifengqug-dsh-guoluo-0.5.0.tgz`（37307 字节）
SHA-256 `849DF3F9C0CD36A0092A69691783C270C915BA705B6C5220F503A043F98C6A4F`

## 推送状态

本地提交 `67a078e`。推送时本机无法连 github.com:443（直连 `Recv failure: Connection was reset` / 连接超时；配置的 git 代理 127.0.0.1:7897 未启动），本轮未上推。网络恢复后执行 `git -c http.proxy= -c https.proxy= push origin main`。
