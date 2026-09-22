# LA3 第四轮独立复核：新写入通过，旧数据迁移仍有缺陷

2026-09-20。按同时间多职责、user/chat 修订交错、未应用报告是否进入当前依据三个重点独立复现。未修改业务代码、提交或部署。

## 验证结果

- 原职责测试 25/25 通过。
- 独立探针 17 项：16 通过、1 失败。包括复跑第三轮全部 14 项，加两个 user/chat 正反交错场景和一个实际模型输入/旧数据迁移场景。
- 环境仍为独立 Chat Home、测试 HTTP 模型、Nano 投影替身与可控时钟。执行使用真实服务和公共 Pi/Tool 链，不是本轮真实模型或浏览器验收。
- 证据保存在 `.data/verification/la3-review-round4/independent-final.log`、`existing.log`、`probe-source.mjs`。探针原位置为 `test/long-agents/la3-round4-independent.test.mjs`，相对 imports 按该位置解析；重跑后应移除临时测试文件。

## 已确认修复

1. 同时刻 A、B 两职责：A 交付后维护，B 仍能独立 started；未再误判已消费。单职责维护先、交付先、并发和重复交付的原探针继续通过。
2. user 先改、chat 后改，以及 chat 先改、user 后改两种交错：旧 expectedRevision 均 409；重新读取当前 revision 后能成功提交。原请求同键同载荷重试不增加历史条目、不覆盖当前值。
3. 新写入的迟到后台报告保留 applied=false，当前完成量和下一步保持用户纠错值。再实际发起推进，检查送到测试模型 HTTP 服务的完整请求：未出现未应用报告的摘要 REJECTED_SUMMARY、文件路径 REJECTED_FILE.md、下一步 REJECTED_NEXT；用户 VALID_NEXT 保留。
4. 上轮预算直达、容量等待后检查、暂停连续性与配置/用户进度并发门禁继续通过。

## R4-1 / P2：迁移把历史未应用报告重新认定为有效依据

位置：`src/long-agents/duties/contract.ts:110`，`normalizeLegacy`。

独立步骤：先用真实服务产生用户纠错与迟到后台报告，确认后者 reportApplied=false、当前值为 8；将隔离存储里的 progress 恢复成上一版确实使用的格式——没有 applied 字段，保留现有 unitsDone/goalRevision/历史/修订。重新读取后，normalizeLegacy 把该条报告赋为 applied=true。当前完成量仍为 8，但摘要和证据路径重新被 composeAdvancementText 作为依据。

随后实际创建第三次推进，捕获公共 Pi 链发送给测试模型的请求，再次确认 REJECTED_SUMMARY 和 REJECTED_FILE.md 均进入模型输入。不是仅凭静态检查推断，也不是页面历史展示误报。

原因：注释假定所有缺 applied 字段的旧条目都曾写入当前指针；第三轮前的代码已支持 reportApplied=false 的历史归档，只是没有将该标记保存进条目。这个迁移假定不成立。

修复要求：不能把缺失的应用状态默认为可信当前依据。优先从可验证的冻结版本、修订或关联记录恢复；无法可靠判定则保留历史并明确未核验，不能进入当前学习依据。保留当前指针，迁移需要可重复并同步旧数据展示/合同，不能通过删历史解决。补旧版本同目标迟到记录、普通有效旧记录以及重复加载/重启后的输入测试。

## 判定

第三轮指出的新数据问题均已独立验证修复，质量有明显改善。但用户要求“任何形式进入当前依据”的范围还包括升级读取上一版数据，R4-1 尚未通过。LA3 完整验收仍待此迁移修复；不要求推翻方案或重复修改已通过部分。修复后重点复验旧数据及实际模型输入，再补真实运行验收。
