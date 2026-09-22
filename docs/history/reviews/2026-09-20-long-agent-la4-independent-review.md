# LA4 独立复核：产物恢复、受众与覆盖

日期：2026-09-20。结论：**暂不通过**。原验收正常路径成立，但不足以证明并发、恢复和权限边界。此次仅复核，不修改产品代码、不部署、不发布正式动态。

依据：[LA4 任务书](../../development/long-agent-functionality-plan.md#la4-执行交接任务书笔记与动态闭环)、[产物合同](../../modules/long-agents/deliverables.md)、[原验收记录](./2026-09-20-long-agent-la4.md)。遵循独立复现后判定；使用临时 CHAT_HOME、本地 HTTP 假模型、真实任务/工作/产物服务及文件系统。

## 结果

- 原有 `test/long-agents/artifacts.test.mjs`：7/7 通过。
- 独立边界探针：10 项，2 通过、8 失败；其中两个并发探针属于同一根因，合计 **7 个问题（5 个 P1、2 个 P2）**。
- 顺序丢回执恢复：帖子身份保持、无重复帖子、模型请求数不增加，通过。
- 无时序控制的 20 次并发补交此次通过；不能据此认定无竞争。控制两个读取在首个 append 前完成后，实际补交服务确定产生两条帖子。
- 本轮未重跑浏览器、付费真实模型、全量 verify；这些故障是服务端确定性边界，已有独立复现足以否定完整验收。并未独立确认原作者全部浏览器证据。

## 问题与修复要求

### 1. P1：同发生并发补交能发布两条动态

位置：`src/long-agents/artifacts/service.ts:250`、`src/long-agents/social.ts:98`。

构造一次发布失败但内容冻结的产物，恢复 Social 存储后同时调用两次 `resubmitArtifact`。测试仅在文件读取处加屏障，让两个调用都在 append 前读到不存在，未伪造发布结果。结果同一 artifactKey 在 feed 中出现 **2 条帖子**。直接并行调用发布服务 20 次得到 20 条。

原因：产物锁只保护 JSON 状态更新，副作用在锁外；Social 的查重与追加也不是原子操作。应在实际发布服务串行化同身份查重和副作用，并让状态落盘针对同一内容 revision 校验，不能只给前端禁用按钮。

### 2. P1：旧回执恢复把重新生成的笔记覆盖回旧内容

位置：`src/long-agents/artifacts/service.ts:289`。

旧产物写入 `old` 后模拟回执丢失为 pending；同任务新 occurrence 在相同路径写入 `new`，确认已 committed；运行维护，文件变回 `old`，新记录仍 committed。

这不是用户显式重新生成时的覆盖，而是后台恢复倒灌历史。必须建立目标文件的当前产物/内容 revision 归属及冲突保护；旧记录只补历史状态，不能覆盖更晚版本。普通人工编辑、旧记录 revise、不同任务同路径也应共用该保护。

### 3. P1：self 动态通过评论泄漏全文

位置：`src/long-agents/social.ts:141`。

Friend A 发 self 动态，B 使用已知 postId 评论；调用成功、写入评论，返回整个私密帖子。列表隐藏不能代替对象级权限。应在评论读取/写入/返回之前统一校验 actor 与 audience；未知和不可见对象不得返回正文。

### 4. P1：符号链接越界先写入后检查

位置：`src/long-agents/artifacts/service.ts:166`。

在 Friend workspace 内建立指向临时外部目录的 `escape` 符号链接，提交 `escape/proof.md`。产物虽校验失败，外部文件已经创建，自动重试还会继续写。写后 realpath 检查不是授权检查。

应复用已有授权文件机制，在创建目录、临时文件及 rename 前验证真实父路径与目标边界，并覆盖已有外部文件、链接父目录及失败重试。不得仅把状态改为失败后宣称越界被阻止。

### 5. P1：收窄受众后仍按旧授权补发

位置：`src/long-agents/artifacts/service.ts:153`、`:260`。

friends 任务生成后暂时发布失败；用户通过任务管理 update 改成 self；恢复存储并运行维护。另一 Friend 的 feed 仍读到该帖子（期望 0，实际 1）。

冻结内容与保留旧授权不是同一件事。提交/恢复前必须检查当前有效授权及职责目标是否仍有效；收窄或撤销后保留历史，明确等待处理，不能以旧授权继续公开。任务暂停与撤权应按合同区别处理，不要求所有编辑都取消执行。

### 6. P2：冻结 4001 字符，实际只发布 4000，仍标记成功

位置：`src/long-agents/social.ts:82`、`src/long-agents/artifacts/service.ts:162`。

产物服务接受最多 60000 字符；Social 静默截到 4000；回读只检查 key，丢失内容仍 committed。应统一长度合同，冻结前拒绝超限或显式选择允许的内容；校验正文与受众，不只校验身份存在。

### 7. P2：Friend 自己通过 social_manage 也读不到 self 动态

位置：`src/tools/builtins/social-manage/index.ts:73`。

使用真实 Tool provider，以 owner Friend 执行 read，其自己的 self 帖子仍被过滤。原因是未把可信执行身份传给 viewerLongAgentId。应由服务端上下文传入，不能让模型自行填写 viewer。

## 证据与复跑

本地证据（不含正式数据）：

- `.data/verification/la4-review/existing.log`
- `.data/verification/la4-review/probe.log`
- `.data/verification/la4-review/la4-independent-probe.test.mjs`

复跑时将探针复制到 `test/long-agents/la4-independent-probe.test.mjs`（复用现有 daily-fixture 相对导入），执行：

```bash
node --import ./scripts/typescript-test-loader.mjs --experimental-strip-types --test test/long-agents/la4-independent-probe.test.mjs
```

运行后移除测试目录中的临时副本；证据副本保留。本轮失败断言均为预期安全/正确性合同未满足，不是模型或网关连接错误。

## 下一次收口要求

一次修复上述 7 项并将探针转成永久回归门禁。重点矩阵包括：同身份交错补交/维护、旧版本回执与新版本交错、同文件人工修改/多任务冲突、self 的读和评论、撤权后的待发布记录、内容长度与哈希一致性。同步纠正原验收对并发及符号链接的过度声明。之后运行完整门禁，再以真实浏览器确认用户状态、冲突提示和恢复动作，不以正常路径通过代替故障恢复验证。此次未对全 LA4 所有入口作穷尽证明，7 项为已确认问题，不承诺剩余问题数为零。
