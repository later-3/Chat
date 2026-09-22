# LA4 第四轮独立复核：方案 B

2026-09-20。结论：B 的不覆盖笔记正文方向成立，但暂不通过，确认 2 个 P1 和 1 个 P2；不建议进入 LA5。工作区用户文件不随版本自动更新，是 B 的明确行为，不列为缺陷。

## 证据

独立运行 artifacts、artifacts-boundaries、note-store 三套测试：31/31 通过；新增独立探针 3/3 失败，均为业务断言失败，没有超时。使用隔离临时 CHAT_HOME、本地 HTTP 假模型、真实任务/产物服务。未重跑付费模型、浏览器、全量 verify；未修改产品代码、提交或部署。

## P1：旧维护刷新回滚新版本指针及记录中的文件路径

位置：`src/long-agents/artifacts/service.ts:522`，特别是 refreshCommittedNote 尾部的 writeNotePointer 和 changeArtifactState。

步骤：提交 v1；维护在读取 v1 versionFile 后暂停；通过真实 reviseArtifact 完成 v2，确认 committed；释放旧维护请求。

结果：产物 content/revision 是 v2，但 note.versionFile 指回正文 v1 的文件，current.json 也回到 v1。普通提交 settle 的 CAS 并未保护新加的 refreshCommittedNote。后者未接入同身份/同路径锁，也未对修改记录加预期 revision/contentHash。

修复要求：刷新是写操作，必须与提交、修订、冲突处理共用版本/路径协调协议；使用旧快照的刷新不得改当前指针及 note 元数据。历史产物与同路径最新所有者的投影也要统一约束。不能只在 settle 有 CAS 而让维护入口直接改写。

## P1：内部版本目录缺少路径授权检查

位置：`src/long-agents/artifacts/service.ts:264`、`src/long-agents/artifacts/note-store.ts:44` 起。

步骤：在合法的 workspace/notes 下预先放置 `.chat-notes` 符号链接，指向临时外部目录；提交 notes/test.md。

结果：外部目录出现版本库目录、版本及指针文件。检查只覆盖了用户文件 canonicalPath，没有覆盖由其派生的 `.chat-notes`、versions、user 和指针路径。这个场景无需竞争或攻击时序，既有符号链接即可复现。

修复要求：所有派生存储/临时文件/指针路径都必须在写前走同一授权检查；首次提交、维护重建、冲突保存、导出都不能旁路。首写使用 link 仅保证不替换目标，不等于保证目标位于授权目录。

## P2：上一次冲突选择被错误沿用于后一次人工修改

位置：`src/long-agents/artifacts/service.ts:563` 附近；消费者 `frontend/components/LongAgentDeliverablesSettings.tsx:201`、`:206`。

步骤：文件改成 edit one → 维护发现冲突 → 用户选择 generated；随后文件改成 edit two → 再维护。

结果：新的 conflict.content 是 edit two，但 conflictResolution 仍为 generated。UI 显示已选择生成版本，并隐藏两个处理按钮，用户不能正常选择保留这次新的修改。两份内容仍保留，因此不把这项描述成数据丢失。

修复要求：决定绑定冲突 contentHash/身份（并保护 expected revision）；冲突来源或内容变化时清除过期决定并重新展示处理按钮。不能按整个产物永久记一个 generated 标记。

## 本地复跑

证据：`.data/verification/la4-review-round4/{probe.log,regression.log,la4-round4-probe.test.mjs}`。

把探针复制到 `test/long-agents/la4-round4-probe.test.mjs` 后：

```bash
node --import ./scripts/typescript-test-loader.mjs --experimental-strip-types --test --test-timeout=15000 test/long-agents/la4-round4-probe.test.mjs
```

运行后移除测试目录中的临时副本。建议一次性核对 B 新增的所有写入入口：首次提交、已完成记录刷新、修订、冲突处理、导出，使授权、版本保护与目标归属一致。修复后先跑确定性门禁，再验收浏览器冲突交互。LA5/LA6 不计入本轮缺陷。
