# LA4 第二轮独立复核

日期：2026-09-20。结论：**暂不通过**。第一轮修复对顺序场景有效，但实际交错仍有 4 个已确认问题（3 P1、1 P2）。范围仅为 LA4；整天自然运行、外部渠道与 24h 联合验收归 LA6，群聊归 LA5，不列为本轮缺陷。

依据：[LA4 任务书](../../development/long-agent-functionality-plan.md)、[当前产物合同](../../modules/long-agents/deliverables.md)、[返工记录](./2026-09-20-long-agent-la4.md)。方法仍为独立复现后判定，遵循仓库 chat-architecture 审查路径。

## 验证结果

| 检查 | 结果 |
|---|---|
| 原有产物测试 + 返工永久边界测试 | 18/18 通过 |
| 独立新增交错探针 | 6 项：1 通过、5 失败，归并为下方 4 个问题 |
| 同身份补交与维护交替并发 20 次 | 通过，只发布 1 条 |
| self 本人读取、他人评论拒绝 | 永久边界测试复跑通过 |
| 顺序收窄受众、取消任务后恢复 | 永久边界测试复跑通过 |
| 4001 字符冻结前拒绝、4000 字符原文发布 | 永久边界测试复跑通过，接受这个修复合同 |
| 顺序旧记录恢复、预先发生的人工修改、预先存在的越界链接 | 永久边界测试复跑通过 |

全部使用隔离临时 CHAT_HOME、本地 HTTP 假模型、真实任务/产物/文件服务。交错通过暂停具体文件 I/O 或注入一次写入失败构造，不修改产品函数返回值。未重跑浏览器、付费真实模型或全量 verify；本轮不是 LA4 全部 UI/运行场景的完整认证。未修改产品代码、未部署、未提交。

## 1. P1：路径归属检查与写入分离，旧写入仍覆盖新产物

位置：`src/long-agents/artifacts/service.ts:239`（检查后写入）、`:345` 附近（锁按 artifactId，未覆盖相同路径的不同产物）。

独立步骤：启动旧 occurrence 笔记提交，暂停在已通过检查的文件 rename；提交另一次 occurrence 到同一路径并确认新产物 committed；释放旧 rename。实际文件从 `new` 变成 `old`，两个记录均可显示 committed。新归属检查只能保护后进入检查的旧请求，不能保护已经通过检查的旧写入。

相邻探针：同一位置暂停后人工写入 `manual edit`，释放 rename，人工内容被 `generated` 覆盖。

修复要求：受管写入须按规范化目标路径协调，归属判断、内容冲突判断、提交与回执在同一协议下完成。人工编辑必须明确处理：普通进程内锁不能约束外部编辑器；若不能提供文件级条件替换保证，应使用不可变版本/保留冲突副本等保全方案并明确合同，而不是继续宣称绝不覆盖。不能只再加一次锁外读取。

## 2. P1：维护使用旧快照，错误完成新修订

位置：`src/long-agents/artifacts/service.ts:389`–`:390`、`settle`（没有 expected revision/contentHash）。

独立步骤：

1. v1 文件已落盘，产物模拟回执丢失为 pending。
2. 维护读取 v1 文件后暂停，持有 v1 的校验结果。
3. 调用真实 resubmit 恢复 v1，再调用真实 revise 冻结 v2；注入目标 rename 失败，确认 v2 为 failed，文件仍是 v1。
4. 释放旧维护请求。

实际：维护把当前 v2 记录改成 committed，并清除失败，而磁盘仍是 v1。这会让界面和后续模型把失败修订当作完成。

修复要求：补记回执必须与提交/修订使用同一身份协调；校验和落状态绑定 revision/contentHash，过期回执不能改变新版本。不能仅在 commitFrozen 内加锁，保留 reconcile 的锁外 settle 快捷路径。

## 3. P1：受众变更与发布交错，撤权完成后仍追加公开帖子

位置：`src/long-agents/artifacts/service.ts:207`–`:216`，关联任务 update 与 Social append。

独立步骤：friends 产物通过授权检查后，在 Social 查重读取处暂停；用户通过真实任务 update 将受众改为 self，等待 update 完成；再释放发布。实际其他 Friend feed 仍出现 1 条公开帖子。

顺序“先撤权、再补交”已修好，但授权检查与实际发布之间没有和配置修改协调。应明确撤权/发布的提交顺序并落实：若撤权成功意味着阻止尚未提交的发布，发布与配置变更须共享相应的冲突/串行化机制；若允许已进入发布阶段的操作继续，必须明确产品语义并经审核，不能当前文档承诺阻塞而实际静默发布。此处没有要求追溯删除撤权前已经发布的帖子。

## 4. P2：维护补记仍仅按 key 判断，不核正文

位置：`src/long-agents/artifacts/service.ts:385`–`:390`，`verifyPost` 仅返回 id。

独立步骤：已有帖子模拟旧版截断/存储异常：保留 artifactKey、把正文改为 `truncated`；产物保留完整冻结正文并模拟回执丢失。运行维护，产物变成 committed，尽管帖子正文不等于冻结内容。

正常提交路径新增正文检查，但恢复快捷路径绕过了它。该情况也可来自第一轮代码曾经生成的截断帖子，不能仅以新写入已限制长度排除。

修复要求：正常提交和恢复共用身份、作者、受众、正文的一致性验证；不一致必须保留为待核查/阻塞，不能仅凭 key 补成功回执。

## 证据与复跑

- `.data/verification/la4-review-round2/regression.log`：18 项已有测试。
- `.data/verification/la4-review-round2/probe.log`：6 项新增探针。
- `.data/verification/la4-review-round2/la4-round2-probe.test.mjs`：源码。

将探针复制到 `test/long-agents/la4-round2-probe.test.mjs` 后运行（依赖现有 daily-fixture 相对路径）：

```bash
node --import ./scripts/typescript-test-loader.mjs --experimental-strip-types --test test/long-agents/la4-round2-probe.test.mjs
node --import ./scripts/typescript-test-loader.mjs --experimental-strip-types --test test/long-agents/artifacts.test.mjs test/long-agents/artifacts-boundaries.test.mjs
```

测试结束移除临时副本，保留证据。失败属于预期业务断言不满足，不是模型连接或测试 fixture 初始化失败。

## 下一步

将上述 4 项作为一次完整的并发提交协议修复：按目标保护文件写入、按内容版本保护回执、明确撤权与提交顺序、统一恢复验证。新增永久交错回归后运行完整门禁，再做浏览器状态验收。本记录不把已修好的顺序问题重复计算为新问题，也不承诺其余所有场景无缺陷。
