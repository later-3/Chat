# Chat Session架构

本文是Chat Session语义、Workflow持久化和历史投影的约束性规范。Pi `SessionManager`是会话事实源；Workflow只能增加编排信息，不能发明第二套消息格式。

## 1. 对象边界

| 对象 | 含义 | 生命周期 |
|---|---|---|
| Chat Session | 用户看到的一条连续会话 | 跨多轮、跨Workflow持久化 |
| Turn | 一次线性交互单元，可由人或Agent先说话 | 通常对应一次Workflow Run |
| Workflow Run | 一次编排执行，包含Stage和审核等待 | 开始到完成、失败或取消 |
| Stage | 当前由哪个人、Agent、Task或Tool处理 | Workflow Run的一部分 |
| AgentSession | 某个Agent本次运行的Pi对象 | Agent Stage执行期间 |

切换Workflow、Stage或Agent不会创建新的Chat Session。当前产品只支持一条线性对话主链；如果未来增加并行分支，仍必须使用Pi的Session树和明确的分支语义，不能把并行结果塞进不透明CustomEntry冒充对话。

## 2. 三层必须分开

```text
持久化事实层：Pi SessionEntry树
  ↓
Agent上下文层：按当前Agent规则选择、转换模型可见消息
  ↓
前端投影层：把原生消息与相邻Workflow元数据折叠展示
```

持久化角色描述“事实上的说话者”，不能为了适配某个下游Agent而修改。不同Agent需要不同模型上下文时，由Agent装配时的Context Transform处理；前端需要显示Agent名称时，由Stage元数据与原生消息关联处理。

## 3. 消息硬约束

1. 人说的话必须保存为Pi原生`message.role=user`。
2. Agent说的话必须保存为Pi原生`message.role=assistant`。
3. Tool结果必须保存为Pi原生`message.role=toolResult`。
4. 一句话只能有一份会话事实。CustomEntry不能成为用户原话或Agent回复的唯一副本。
5. `custom_message`会进入模型上下文，可用于隐藏的Agent间交接或无新用户话语时的内部触发；它不能冒充用户或Agent的真实话语。
6. `CustomEntry`不进入模型上下文，只保存Workflow、Stage、Agent、配置快照、审核控制状态和原生消息引用。

Workflow/Agent身份与消息角色正交：同样是`assistant`，可以由Planner或Executor产生；同样是`user`，可以是原始请求或审核修改意见。`chat.workflow_stage`负责说明相邻消息属于哪个执行阶段。

## 4. 标准CustomEntry

| customType | 内容 | 禁止内容 |
|---|---|---|
| `chat.workflow_turn_configuration` | Workflow ID和本轮冻结的Agent配置 | 用户或Agent话语正文 |
| `chat.workflow_stage` | Invocation、Workflow、Stage、Node Kind、Agent ID | Agent回复正文 |
| `chat.workflow_agent_input` v2 | `inputEntryIds`，引用原生会话消息 | `userPrompt`、上游输出正文 |
| `chat.plan_review` | 审核ID、版本、摘要、`planEntryId`和控制状态 | 作为计划文本的唯一副本 |
| `chat.plan_review_decision` v2 | 决定、版本绑定、`feedbackEntryId` | 作为审核原话的唯一副本 |
| `chat.session_migration` | 迁移ID、源哈希、备份位置和变更ID | 会话内容 |

人工审核是`nodeKind=human`，没有虚假的Agent ID。没有人也没有Agent的确定性节点可使用`task`或`tool`元数据；只有它真的产生话语时，才追加对应的原生消息。

## 5. Planning Execution正例

下面是一条Session中的线性时间线；缩进不表示另建子会话：

```text
custom          workflow_turn_configuration(planning-execution)
custom          workflow_stage(plan, agent=planner)
message/user    原始需求                              id=u1
custom          workflow_agent_input([u1])
message/assistant 第一版计划                          id=p1

custom          workflow_stage(review, nodeKind=human)
custom          plan_review(planEntryId=p1)
message/user    审核修改意见                          id=f1
custom          plan_review_decision(feedbackEntryId=f1)

custom          workflow_stage(plan, agent=planner)
custom          workflow_agent_input([u1, p1, f1])
message/assistant 第二版完整计划                       id=p2
custom          plan_review(planEntryId=p2)
custom          plan_review_decision(approve)

custom          workflow_stage(execute, agent=pi-coding-agent)
custom          workflow_agent_input([u1, f1, p2])
custom_message  隐藏的内部执行交接
message/toolResult ...
message/assistant 最终回复
```

批准按钮是控制决定，不强行生成一条“用户说批准了”的假消息。因为批准后没有新的自然语言话语，Executor使用隐藏`custom_message`接收最终计划并触发一轮Agent执行。

## 6. Agent先发起

Agent可以先说话。正确顺序可以是：

```text
custom            workflow_stage(announce, agent=announcer)
message/assistant Agent的第一句话
message/user      人的回应
```

Session列表的“第一句话”取第一条原生`user`或`assistant`文本，不等同于标题。显式Session名称优先；Pi列表中的`(no messages)`只是内部哨兵，不能作为前端标题展示。

## 7. 反例

以下实现全部禁止：

```text
custom chat.workflow_agent_input { userPrompt: "用户原话" }
# 没有对应的原生user消息
```

```text
custom chat.workflow_message { message: <Planner AssistantMessage> }
# 没有对应的原生assistant消息
```

其他反例：

1. 等到Executor开始时才第一次写入原始用户请求，或再次写入同一请求。
2. 把审核原文只存在`plan_review_decision.feedback`中。
3. 为适配Agent B而把Agent A的持久化`assistant`改成`user`。
4. 前端长期从CustomEntry伪造user/assistant；这只允许作为未迁移活动Session的兼容路径。
5. 每个Agent、Stage或Workflow创建自己的Chat Session。
6. 把人工审核伪装成`agentId=human`。

## 8. 历史迁移

`session-native-messages-v1`负责把旧的值复制格式改成上述原生消息格式：

1. 迁移前把原始JSONL保存到`<projectDataDir>/migrations/session-native-messages-v1/backups/`。
2. 迁移在临时文件完成后原子替换源文件；失败时源文件保持不变。
3. 原有Planner消息ID保持不变，审核中的`planEntryId`仍然有效；插入用户消息时显式修正`parentId`。
4. Session末尾追加`chat.session_migration`，记录源SHA-256、备份位置和变更ID；再次执行是no-op。
5. 已符合规范的Session不改写也不创建备份。
6. 非终态Planning Run不在列表或打开路径中并发迁移，待Run终态后再迁移；迁移期读取投影只能作为兼容层。

## 9. 新Workflow检查清单

新增或修改Workflow时必须逐项确认：

1. 所有人和Agent的话语都能在原生MessageEntry中找到。
2. CustomEntry只含编排状态或MessageEntry引用，没有话语正文的唯一副本。
3. 同一UI输入不会因多个Agent消费而重复写成多条user消息。
4. Agent间交接由Context Transform或隐藏CustomMessage完成，并保留原始持久化角色。
5. Stage正确声明`agent / human / task / tool`；只有Agent节点需要`agentId`。
6. Workflow切换继续使用同一个SessionManager和Session ID。
7. 等待、恢复、重试、审核驳回和批准路径都有真实Session用例。
8. 前端刷新后从Backend和Pi Session恢复，不依赖React内存重建事实。
