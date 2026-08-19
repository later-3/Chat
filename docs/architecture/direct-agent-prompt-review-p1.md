# Direct Agent逐次提示词审核 P1

> 日期：2026-08-19  
> 状态：单节点P1纵向与DSH首版审核界面已实现  
> 真实付费Provider：未调用

## 1. 用户结果

Chat新增独立系统Workflow“执行 Agent（逐次提示词审核）”。它不复用Planning的Plan、
Approval或Execution Contract，用户可见结构固定为一个Execution Agent节点：

```text
agent.direct（Provider Request Review Hook：manual）
    running ⇄ waiting_human
```

每次Pi即将向Provider发送模型请求时，执行层先停止并把最终请求发布为Prompt Review产品事实。
用户批准后只允许发送这一个冻结版本；拒绝时该次Provider调用数为0。Tool Result产生下一次模型请求时，
必须创建新的Review和新的Workflow Hook，不能复用上一轮批准。

## 2. P1边界

P1包含：

1. `direct_agent` Product Run、Direct Attempt、Prompt Review Request/Decision、Direct Candidate和v13存储迁移。
2. 单节点Direct Workflow、节点内部每轮独立耐久Hook、Decision Outbox恢复与Runtime Binding。
3. 独立Pi Direct Executor Operation、真实`AgentSession`、Extension链外fail-closed Provider Gate、等待态进程恢复。
4. 公开Prompt Review Query/Decision Command与私有Application/Executor合同。
5. 不调用真实Provider的确定性合同、状态机、Store、Workflow和Executor测试。

P1不包含：

1. Prompt差异对比与编辑能力；当前已提供原始请求、按区域拆分且带源码来源定位的易读视图、批准/拒绝和刷新恢复。
2. 真实百炼/付费模型端到端；这些属于P3并需要届时明确授权。
3. Workspace写入、Shell、第三方Extension、Memory或Workspace Instructions。V1固定`read_only`，使用隔离空Workspace。

## 3. 最终请求与可读投影

`canonicalPayloadJson`定义为Pi Provider Adapter完成模型、messages、system、tools和参数组装后，
在认证Header/API Key注入前的最终JSON对象。它必须满足：

- canonical JSON，UTF-8至多1 MiB；不允许截断后声称完整；
- 不含HTTP Header、Credential或隐藏推理字段；
- `payloadSha256`由Application与Executor分别重算；
- Product Store只保存一份正文，Workflow Checkpoint、Runtime Binding、Trace和Pi Journal只保存ID、revision和Hash。

`prompt-readable.v1`由Domain对同一canonical JSON作确定性投影；公开Query另按消息、消息附加字段
（包括Tool Call/Tool Result身份）、工具定义和请求参数生成结构化区块。每个区块的`content`只来自原始
Payload，来源定位独立放在`sources`，明确标记为审核界面注释且不会发送。来源覆盖Pi基础System Prompt、
Chat Direct追加指令、DSH用户输入链、Pi AgentSession历史、工具Schema和Pi AI Provider Adapter的源码路径。
投影不调用模型、不概括或省略字段，也不是第二份持久化正文；易读正文不再加入“模型请求提示词”等容易
被误认为真实发送内容的装饰标题。

## 4. 运行时序

```text
Message Command
  → 原子提交Message + direct_agent Run + Workflow Attempt + RunSpec + workflow_start Outbox
Workflow
  → BeginDirectAgentAttempt（冻结Message/RunSpec/read_only/版本/预算Hash）
  → 启动唯一Pi Direct Operation
Executor AgentSession.providerRequestGate（Pi公开fail-closed接缝）
  → 规范化Payload + 导出0600 Session checkpoint
  → Application发布PromptReviewRequest，Run进入waiting_human/prompt_review
Workflow
  → 为该prr创建并绑定唯一Hook，等待Product Decision
User Decision Command
  → 原子提交Decision + Run状态 + workflow_resume Outbox
Runtime
  → 校验prr/revision/reviewSha，恢复对应Hook
Workflow
  → 只读重载Decision，再通知同一Pi Operation
Executor
  ├ reject：取消Operation，绝不取得Provider正文
  └ approve：以稳定commandId原子消费一次性dispatch permit
       → 首次返回Product Store冻结正文
       → 重放只返回already_claimed，不再返回正文
       → Provider请求完成后提交Review dispatched
       → Tool Result后的下一次onPayload重新开始一轮审核
最终输出
  → Executor持久化Direct Candidate
  → Workflow用稳定commandId Product Commit为正式Assistant Message
```

## 5. 身份、Hash与一次性发送

一次Product Run只拥有一个Workflow Run、一个Direct Attempt、一个Pi Operation和一个Pi Session；
每次Provider请求拥有新的`prr_*`、`prd_*`和Hook Token。浏览器只能看到产品ID，不能看到Workflow Run ID、
Hook Token、Pi Operation ID或Pi Session ID。

Decision同时绑定：

- `productRunId`和`promptReviewRequestId`；
- 不随状态变化的`requestRevision`；
- `reviewSha256`与`payloadSha256`；
-完整Decision的`decisionSha256`。

批准Decision本身不直接授权Provider。Executor必须再消费Product Store中的一次性dispatch permit；
只有首次事务返回冻结正文。若首次响应丢失，稳定命令重放返回`already_claimed`并收敛为`outcome_unknown`，
宁可停止人工核对，也不再次扣费。

## 6. Pi接缝与恢复

固定Pi `0.84.2`的Extension Runner会吞掉`before_provider_request`异常，因此它仍只用于观察，
不能承担安全暂停。Chat维护的Pi分支在`createAgentSession()`公开`providerRequestGate`：它位于
Extension变换之后，异常不被Extension Runner吞掉并直接阻止Provider fetch。Chat当前以固定pnpm窄补丁
消费这份通用源码差异，待分支发布固定工件后可删除补丁并切换到同一来源的版本化Artifact。

P1通过pnpm窄补丁为固定工件增加通用`AgentSession.resumePendingTurn()`。它从恢复的User或Tool Result尾部继续，
并复用AgentSession的post-run、queue、retry/compaction处理、bash flush、settled和idle生命周期；补丁不包含Chat产品ID。
每次审核前使用公开`exportToJsonl()`生成0600 checkpoint并记录文件Hash/Session/leaf身份。
当前证据覆盖进程退出与重启；Pi导出没有提供显式文件/目录`fsync`合同，因此P1不宣称突然断电后的同等级耐久。

V1显式关闭thinking、Provider自动重试、Compaction、Branch Summary和外部Extension。
关闭thinking保证后续工具回合不会把`reasoning_content`带入需要持久化的审核正文；其余开关确保
不存在绕过统一Gate的第二条模型调用路径。

每个Attempt最多允许16个Prompt Review和16次Provider发送。循环是同一个Execution Agent节点的
内部运行状态，不创建第17个Workflow节点或额外人工节点。

## 7. 故障政策

1. `open`审核前失败：Review取消，Run失败；Provider调用数为0。
2. 已批准但permit尚未消费：Review可取消并保留原approve Decision，Run失败。
3. `dispatching`后任何普通失败：Review与Run都强制收敛为`outcome_unknown`，不得降级为可重试失败。
4. 等待审核时Executor重启：从同一checkpoint重建Payload；Hash漂移立即失败关闭。
5. Provider请求已发出但响应丢失：不自动重发。
6. 中途拒绝：不发送下一次模型请求；此前只读Tool证据保留。V1没有写入副作用需要回滚。
7. Product Commit失败：Candidate与成功Direct Attempt已经持久化，只重试稳定Product Command，不重新调用模型。

## 8. 当前完成证据与后续

P1的普通测试不访问外网，覆盖合同、Domain、v12→v13迁移、真实JSON Store Application纵向、
一次性permit响应丢失、等待态重启、同一Operation多轮审核、Runtime Binding、Workflow循环和Candidate→Message提交。

DSH首版在`@chat/dsh-lifeos-bridge`提供原始请求/易读视图双Tab、批准/拒绝、刷新恢复、
旧revision/Hash冲突和结果未知提示。前端仍只调用Chat公开Query/Command，不直连Workflow或Pi。
