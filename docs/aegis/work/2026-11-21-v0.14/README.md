# v0.14.0 候选覆盖度按内容指纹比对

## 目标

候选工程里同名但换了内容的文件，在 v0.13.0 之前会被算成「已覆盖」，这是一种假阳性。本切片给素材与候选文件都算 SHA-256，覆盖度由「同名存在」升级为「同名且内容一致」。

## 交付

- `lib/inventory.mjs`：新增 `fingerprint(row, path, stat)`，在预算内（4096 个文件 / 单文件 8 MiB / 合计 256 MiB）读取内容算 SHA-256 写入 `row.sha256`；`counts` 增 `hashedAssets`、`skippedAssetHashes`；超预算或读失败只计数并在 notes 说明。`file()` 改为异步并在登记资产行后取指纹。
- `lib/spec.mjs`：asset 义务带上 `sha256`（有则带）与 `archive`，规格因此携带内容基线。
- `lib/projects.mjs`：`candidateLimits` 增 `hashFiles`/`hashPerFile`/`hashBytes`；`scanCandidate` 为每个候选文件在预算内算 `file.sha256` 并返回 `hashed`/`skippedHashes`；`checkCandidateRun` 回传 `hashedFiles`/`skippedHashes`。
- `lib/check.mjs`：`checkCandidate` 增加 `digests` 表；候选命中时若两边指纹都存在且不同 → 进 `assets.changed` 并并列 `archive`/`built`，否则进 `present` 并在两边都有指纹时标 `same: true`；`note` 合并素材指纹与令牌取值两处差异计数；`unchecked` 增至 4 条（第四条说明指纹只覆盖预算内读到的文件）。
- 文档：`README.md` 候选段落改为四组（`present`/`missing`/`archived`/`changed`）并说明 `same`，`skills/guoluo-rebuild/SKILL.md` 第 8 步补指纹语义。
- 测试：`tests/candidate.test.mjs` 增加「内容完全相同的素材判为已覆盖且标同指纹」用例；首个用例改为断言 `app.css` 进 `changed`、`index.html` 标 `same: true`、`unchecked.length === 4`。`tests/pe.test.mjs`、`tests/unity.test.mjs` 的资产行精确断言改为「指纹单独核形状 + 其余字段逐项相等」。

## 验证

- `$env:GUOLUO_TEST_REA='D:\Tools\bin\rea.cmd'; npm run test:serial` → 104 项全过、0 失败、0 跳过。
- `npm run check`（无真实 REA）→ 104 项、102 过、2 跳过（真实 REA 用例按需启用）、23 文件打包（70.7 kB / 解压 221.7 kB）。
- 隔离 DSH 0.2.2-rc.5 冷启动（tarball 离线安装后 `node tests/host-smoke.mjs "D:\deepseek HARNESS\resources\app\dsh\node_modules" <拆包目录>`）→

```
{"result":"passed","version":"0.14.0","visual":null,"tools":11,"skill":"guoluo-rebuild","command":"guoluo","liveSettings":true,"rea":{"status":"available","version":"6.8.0"},"linkedRea":"verified","derived":{"spec":2,"tokens":1,"exported":2,"mock":0,"check":"complete","candidate":"partial"},"pck":2,"unity":"lz4"}
```

## 未验证与边界

- 指纹只覆盖预算内读到的文件；超预算的文件保持无指纹，`unchecked` 已写明。
- 内容一致不等于结构与行为一致，`verdict` 仍只表达文件层覆盖。
- 孤立一次（非本切片引入，历史已见两次）带真实 REA 的全量跑曾出现「非 8 位 PNG」用例偶发失败，单跑该文件与随后两次全量均通过，判断为多个 Chromium 实例争用资源的偶发问题。

## 校验和

- `deliverables/zhuifengqug-dsh-guoluo-0.14.0.tgz`，70 705 字节，SHA-256 `921E7DD02B295411D5AAB196D94A4EB35C95CCB70651157C7D481BAC828EFD1E`
