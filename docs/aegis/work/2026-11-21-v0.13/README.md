# 蜾蠃 v0.13.0：候选令牌取值对照

## 目标

候选覆盖度此前只回答「同名令牌有没有声明」。同名但取值被改掉的情况会被判成通过，这是最容易骗过自己的假阳性。这一版把声明值也读出来逐字符比对，并明确写出这套比较的边界。

## 交付

- `lib/check.mjs` 新增 `tokenValue()`：按 `--name: value` 取声明值，截到下一个 `;` 或 `}`，只 `trim()`，不做任何归一化。
- `checkCandidate` 返回新增 `values: { checked, same, differs[], method }`。`differs` 每项并列 `archive`（档案里的值）与 `built`（候选里的值）以及命中文件路径。
- 判定不变：`verdict` 只看素材、页面、令牌有没有找到；取值不同不算缺失，但 `note` 会追一句「另有 N 个令牌的声明值与档案不同」。
- `unchecked` 增加第三条：令牌取值只比声明文本，不判断最终是否生效（级联、继承、媒体查询与运行时样式均未计算）。
- 文档同步：`README.md` 候选段落、`SKILL.md` 第 8 步。

## 约束

- 只读候选目录，不执行候选代码，不启动浏览器。
- 比较口径固定为「去首尾空白的字面量相等」：`#112233` 与 `#112 233` 会被判为不同，`var(--x)` 不展开——这是刻意的，宁可漏判也不猜。

## 验证

- `node --test tests/candidate.test.mjs`：5 项全过，其中新增一项覆盖「同名不同值 → `complete` + `differs` 1 条 + note 提示」。
- `npm run check`（含真实 REA，串行）：103 项全过 0 失败 0 跳过。
- 隔离宿主：从最终 tarball 离线安装后在隔离 DSH profile 冷启动 `node tests/host-smoke.mjs`，11 工具、REA 绑定、PCK/Unity 夹具、候选覆盖度 `partial` 均通过。

## 未验证与边界

- 若候选把令牌声明在 `@media` 或 `:root.dark` 里，这里只认第一处文本命中，不区分作用域。
- 简写与等价写法（`#fff` 对 `#ffffff`、`8px` 对 `0.5rem`）都按不同处理。
- 素材与页面仍只按文件名/路径比对，没有内容哈希；同名换内容查不出来（下一步候选）。

## 校验和

```
zhuifengqug-dsh-guoluo-0.13.0.tgz  69845 字节
SHA-256  7991758FCCB61121C47789AD5F01CC69702F08B5A1D04E802E4F6441666ECFD6
```
