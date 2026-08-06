# Chat Agent Memory选型决定

> 2026-08-05后续状态：保留为Python/FastAPI/MAF前提下的历史选型证据，最终集成决定已重新打开。
> 原评分有15%直接评价旧后端边界；TypeScript/pi方向会改变该项，因此须在RP-01完成后重新评分，
> 未经新审核不得按本文新增memmy-agent生产依赖或部署。
>
> 日期：2026-08-05
>
> 状态：历史技术选型已完成；最终集成决定因TypeScript/pi方向变化重新打开
>
> 当时结论：在Python/FastAPI/MAF前提下选择`memmy-agent`作为有界派生Memory引擎；该结论不再直接约束目标TypeScript/pi系统

## 1. 这次要选择的到底是什么

Chat需要的不是另一个Project Store，也不是一个替代MAF的Agent Runtime。本次选择对象是一个可被Chat后端调用的
**派生Memory引擎**，用于完成4个核心场景：

1. 把已经存在的历史聊天按可恢复的批次导入Memory处理链。
2. 在每个新回合开始时，按当前用户、会话和候选Project召回相关历史信息。
3. 在回合或长任务阶段完成后，先可靠保存最小观察事实，再异步提炼Episode、经验、策略或Skill候选。
4. 下一轮返回带来源的召回结果，供Chat装配`ContextPackage`并记录实际采用情况。

无论选择谁，以下事实继续只由Chat拥有：Identity与Scope、Product Session与Message、Project/Work/Plan/Action、
Approval、Accepted Memory、Evidence、Artifact、完成状态和Result Commit。外部Memory输出只能是观察事实、派生资产或候选上下文。

## 2. 候选与证据范围

| 候选 | 固定提交 | 许可 | 本次评价范围 |
|---|---|---|---|
| TencentDB Agent Memory | `f3df79326dfd763f45199c441e2129d780467949` | MIT | L0-L3、Skill、Metadata、Asset/ACL/Binding、Loadout、Proxy和真实14回合Session实验 |
| MemOS | `027dc8975836c066a7d1dd80c78c3da5c0fa084e` | Apache-2.0；应用可能另有许可 | Local v2 Hook/Episode/L1-L3/Skill链，以及不同合同的Python MOS/API主线 |
| memmy-agent | `211d521b310fc23c63dd3d9ca848941173981c5e` | MIT | Agent Hook、公共HTTP、SQLite事务、Worker、L2/L3/Skill/Trial、召回与失败修复 |

本决定复用2026-08-01已经收口的固定版本源码、测试和实跑证据，不重新扩大参考集，也不以项目宣传材料代替运行合同。

## 3. 选择标准

以下评分是针对Chat当前场景的**决策评分**，不是通用产品排名。每项按1—5分评价，再按权重换算为100分。

| 标准 | 权重 | TencentDB Agent Memory | MemOS | memmy-agent |
|---|---:|---:|---:|---:|
| 历史导入与实时回合接入适配度 | 15 | 3 | 3 | 3 |
| 召回质量、来源血缘与采用可追踪性 | 15 | 4 | 4 | 5 |
| Episode、经验、策略与Skill演化能力 | 15 | 4 | 5 | 5 |
| 最小原子提交、幂等、重试与失败恢复 | 20 | 1 | 3 | 4 |
| 与当前Python/FastAPI/MAF后端的服务边界匹配度 | 15 | 2 | 2 | 5 |
| Identity/Scope、删除、失效和多租户治理 | 10 | 1 | 2 | 2 |
| 运维复杂度、可替换性和退出成本 | 10 | 2 | 3 | 4 |
| **加权总分** | **100** | **49** | **64** | **82** |

三个候选都没有可直接满足Chat要求的通用历史会话导入器，也都没有完整达到Chat的Identity/Scope、删除传播和
Accepted Memory治理要求。因此，选择结果不是“原样安装即可”，而是选择最适合放在Chat Adapter之后的处理基座。

## 4. 最终选择：memmy-agent

选择`memmy-agent`，但严格限定为独立的Memory Sidecar/API服务，不让它成为Chat产品事实库。

### 4.1 为什么是它

1. **接入形态最匹配当前技术底座。** 它已经把`session.open`、`turn.start`、`turn.complete`和search暴露为公共HTTP合同。
   Chat的Python后端可以通过一个受控Adapter调用它，不需要把TypeScript Agent插件嵌入MAF，也不需要共享SQLite。
2. **写入时机适合长任务。** `turn.complete`的成功语义是：RawTurn、初始L1、Episode关联、Processing、Job、Change、
   Idempotency和Artifact完成同事务最小提交；L2/L3/Skill再由Worker异步深化。Chat可以在每个回合或阶段边界提交，
   不依赖“累计N轮才记忆”的隐藏阈值。
3. **失败语义最接近产品要求。** 它提供持久幂等、请求Hash冲突、Job lease/retry/dead-letter和Processing状态。
   Embedding连续失败时RawTurn与L1仍保留，修复通过新Job完成，旧dead-letter不被伪装成成功。
4. **召回可对账。** `turn.start`会形成RecallEvent，并能返回`searchEventId`、hits、`sourceMemoryIds`、预算丢弃和状态。
   这些信息可以继续映射成Chat自己的Context Candidate与Adoption Ledger，而不是只得到一段来源不明的Prompt文本。
5. **替换成本最低。** Chat通过HTTP Adapter交互并继续拥有所有Product事实；以后更换Memory引擎时，迁移的是派生资产和
   Adapter，而不是Project、Work、Approval、Evidence或Conversation主数据。

### 4.2 选择它不代表什么

1. 不直接把memmy-agent数据库接到Chat Product Store，也不允许Chat绕过HTTP调用其SQLite fallback。
2. 不把RawTurn、Episode、L1/L2/L3、Skill或Trial当作Project、Work、Accepted Memory、Protocol或完成事实。
3. 不直接采用它当前缺失对象级Scope校验的公共HTTP作为生产安全边界；Principal与Scope必须由Chat验证并显式传递。
4. 不把`turn.complete`成功解释成所有异步Memory均已生成；UI和Trace必须区分最小提交、处理中、失败和已深化。
5. 不因本次选型批准正式依赖、Schema、Worker部署、网络拓扑或字段合同；这些属于下一步总体架构审核。

## 5. 为什么不选另外两个作为接入基座

### 5.1 MemOS：保留为经验演化算法参考

MemOS对Episode、Reflection/Reward、L2 Policy、L3 World Model、Skill/Trial和分层召回的表达最完整，最适合回答
“系统如何从回合观察逐步形成可复用经验”。但它的Local v2是TypeScript Agent生命周期插件，Python MOS/API是另一套
公开合同，两者的入口、对象和恢复保证不能互相背书。当前Chat若把Local v2嵌入MAF，会增加Runtime耦合；若只接Python
服务，又得不到Local v2完整的Turn幂等、Episode和Recall合同。因此本轮不把它选作集成基座，但在后续架构中吸收其
Episode、Reward、Policy/World Model和Trial设计原则。

### 5.2 TencentDB Agent Memory：保留为Loadout与治理参考

TencentDB Agent Memory的Content/Governance/Loadout三平面、Asset/ACL/Binding和Agent/Task Loadout很有启发，真实Session
实验也证明了L0-L3、Skill、Metadata、FTS召回和Proxy注入链能够运行。但固定提交的研究累计确认32项问题，其中16项为Bug；
关键路径存在JSON/向量写入失败仍返回成功、失败后Cursor或生成标记继续前进、真实28消息在JSONL降级链丢失最早消息、
ACL/身份传播和多Store一致性不足等问题。它当前的可靠性与治理缺口会把大量修复成本压到Chat核心链，因此不作为本轮基座。

## 6. 仍然必须由Chat补齐的能力

1. **History Backfill Adapter**：读取既有Conversation/Message，按稳定`sourceId + revision + contentHash`分批重放；支持断点、
   幂等、隔离坏记录、进度和重跑。三个候选都没有可直接使用的通用导入器。
2. **Memory Gateway**：在Chat中统一Principal、Scope、Project候选、预算、超时、脱敏、错误投影和熔断；禁止路由直接调用Sidecar。
3. **Recall Adoption Ledger**：记录哪些候选被召回、注入、丢弃、用户修正和实际采用；memmy的RecallEvent只作为上游证据。
4. **用户治理合同**：补齐Feedback、纠正、失效、删除、来源撤权传播和查询处理状态的公共API；不能依赖memmy内部Service。
5. **更强的Job/Attempt语义**：评估增加不可变Attempt、lease epoch/fencing和跨进程对账，避免只靠Job累计attempts。
6. **Accepted Memory门**：L2/L3/Skill自动结果只能提出Chat Memory/Protocol候选，必须经过现有规则或用户审核才能生效。

## 7. 给总体架构设计的直接输入

下一步总体架构不再假设一个抽象的万能Memory，而应围绕以下已知约束设计：

1. 拓扑采用`Chat Backend → Memory Gateway/Adapter → memmy-agent Sidecar`，Product Store与Memory Store物理和逻辑分离。
2. 新回合先由Chat保存原始Message，再并行/有超时地调用召回；Memory不可用不得阻止Conversation事实落盘。
3. 回合或执行阶段结束时，Chat先提交自己的Product事实，再通过Outbox向Memory提交观察；两者不做跨库伪事务。
4. 历史导入和实时写入复用同一标准化Observation合同，但使用独立Backfill Job、游标和速率限制。
5. memmy返回的Recall与派生资产进入Context Candidate/Memory Candidate，不能直接进入权威Project或执行授权。
6. 架构必须补齐权限、删除/失效传播、Sidecar不可用、重复提交、异步失败、版本升级和退出迁移场景。

## 8. 证据入口

- 总路由：`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/Agent-Memory-MemOS-memmy-agent-总入口.md`
- memmy-agent运行合同：`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/memmy-agent/用户学习/S6-完整架构心智模型/05-输入处理输出运行合同.md`
- MemOS运行合同：`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/memos/用户学习/S6-完整架构心智模型/05-输入处理输出运行合同.md`
- TencentDB真实Session实验：`/Users/xulater/Code/opc-os/agent_knowledge/project-studies/tencentdb-agent-memory/用户学习/S6-完整架构心智模型/07-真实Session全链Trace与处理机制报告.md`

## 9. 决定边界

本次已经完成“选哪个、为什么、采用到哪里、哪些能力仍缺失”的技术选择。下一步进入总体架构设计时，仍需由用户审核：

1. Sidecar部署与替换边界。
2. 实时回合、长任务阶段和历史Backfill的完整正常/失败时序。
3. Chat与memmy之间的最小公共合同。
4. Identity/Scope、删除传播、Accepted Memory和Recall Adoption的责任划分。
5. 分阶段交付、验证门与退出方案。
