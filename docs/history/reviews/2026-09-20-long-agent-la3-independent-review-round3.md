# LA3 第三轮独立复核：两项 P1 尚未通过

2026-09-20。复核重点为到期计划交付顺序、进度 CAS、触发直达派发预算、当前指针与历史分离。本轮只审查和复现，未修改业务代码、提交或部署。

## 方法与结果

以隔离 Chat Home、测试 HTTP 模型和 Nano 投影替身运行实际职责/任务服务及公共 Pi/Tool。到期使用可控 Date，未重跑真实模型、真实浏览器或真实 Nano 扫描，不宣称任意分布式时序均已被穷举。

- 原有 22 项职责测试全部通过。
- 独立探针 14 项，12 通过、2 失败。上一轮暂停流程的旧 expectedRevision 已改为 report 后的新版本；这是合同变化的测试适配，不改变行为断言。
- 本地证据：`.data/verification/la3-review-round3/independent-final.log`、`existing.log`、`probe-source.mjs`。源码原位置 `test/long-agents/la3-round3-independent.test.mjs`，相对 import 按该位置解析；重跑需临时放回并清理。fixture 清理后的返回重试提示不计为产品缺陷。

## 已复现通过

1. 暂停恢复保留 1/3、60 tokens 与下一步；第二次执行包含原有计划。
2. 配置更新和用户进度纠错分别用同版本并发提交，均一成一败；真实注册的主聊 Tool 也能提交纠错。
3. 单职责一次性计划分别在维护先、交付先、两者并发三种顺序下交付，再维护并重复交付两次；每种均只生成一个 occurrence 和一个 work。原“到期即撤销”复现已通过。
4. 不运行维护循环，第一次执行产生 60 tokens 后，通过第二次真实 `acceptTaskTrigger` 入口触发，返回 skipped、预算 60/50，work 数仍为 1。容量等待后的派发预算复核也阻止第二次启动；排队暂停检查通过。
5. 用户纠错将当前进度设为 8、下一步 USER_NEXT，旧后台执行再报告 1/OLD_NEXT，返回 reportApplied=false；历史有两条，当前值保持 8/USER_NEXT。

## 仍需修复

### R3-1 / P1：消费判定跨职责串扰，同时间计划丢执行

位置：`src/long-agents/duties/service.ts:48`，`planConsumed`。

该函数在本 Friend 的全部 occurrence 中，只按 `sourceId = timeZone:nextCheckAt` 搜索，不核对 taskId/dutyId/计划身份。独立复现：A、B 两项 cadence=none 职责设相同时间；到期先交付 A，再维护，B 被误判已消费并暂停/换版本；随后 B 的合法触发返回 skipped、“旧任务版本已失效”，没有执行。

修复要求：消费键必须归属具体职责/任务/计划，不能以时间戳代替计划身份。补同时间多职责、旧目标同时间计划、跳过记录是否代表消费、维护与交付交错的测试。正常到期应执行一次，不能仅以零次也满足“至多一次”解释丢失。

### R3-2 / P1：主聊纠错忽略调用方 expectedRevision

位置：`src/long-agents/duties/service.ts:550`。

Web/user 分支使用提交版本，但 chat 分支用服务端刚读到的 `pre.revision` 代替调用方的 `expectedRevision`。独立复现：主聊基于 v1，用户已提交纠错为进度 8（v2）；随后主聊仍带 expectedRevision=1 提交进度 2，调用成功而不是 409。结果可覆盖用户新值。并发 user/user 通过不代表 user/chat 合同通过。

修复要求：所有交互式修改都基于调用方实际观察到的版本；只有后台执行使用冻结的接受版本进入历史归档分支。补真实 Tool 的过时请求、用户与主聊交错、冲突后重新读取再提交。

### R3-3 / P2：当前字段与历史已分离，但下一轮 Prompt 未区分未应用报告

位置：`src/long-agents/duties/service.ts:154`，`composeAdvancementText`。

独立探针确认当前 unitsDone/nextStep 不再被迟到报告改变，但该同目标报告的 STALE_CLAIM 仍被拼入下一轮“近期进度（依据）”；证据也按同目标全量收集进“已覆盖的材料”。进度条目没有保存此次是否应用到当前指针的信息，仅按 goalRevision 过滤，无法区分同目标下被用户纠错取代的后台报告。

修复要求：保留完整历史，但持久标识应用/冲突归档关系；给模型的当前依据使用有效状态，若附历史需明确其已被取代/未应用，不能不加标记地当作当前学习事实。该项探针检查指针通过，同时记录 staleInPrompt=true，不把“指针通过”当作全部输入合同通过。

## 判定

上一轮三个具体复现已通过，修复有效；本轮新增边界独立复现出两个 P1，另有 Prompt 与历史分离的 P2。LA3 仍不满足完整验收。先完成这三项及对应回归，再验证真实模型/浏览器与自然到期链路；不需要推翻现有架构。
