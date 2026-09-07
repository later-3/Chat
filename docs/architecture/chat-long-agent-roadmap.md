# Chat Long Agent路线图与续接任务账本

## 1. 用途与当前状态

本文保存Chat Long Agent从产品设想、架构决定到后续任务的完整上下文，供未来继续开发时恢复目标和范围。当前发布只收口“Project专属长期同事会话 + Chat Pi运行时 + NanoClaw Channel/Agent Group/OKF Memory + Web管理”；后续能力记录在本文，但不阻断当前版本发布。

状态基线：2026-09-07。代码版本目标为Chat `0.1.0`、Frontend `0.3.0`、NanoClaw `2.4.0`；Pi本期未修改。

## 2. 最初产品目标

Chat服务用户的学习、工作和娱乐。Chat Web与IM只是不同入口，底层共享Project、Session、Agent、Workflow、Memory和资源治理：

```text
用户
  ├── Chat Web：主动进入Project，使用普通Session、Workflow或长期同事
  └── IM Channel：随时联系长期同事，接收主动消息
             ↓
Project → Chat Session → Pi Agent Runtime
             ↑
NanoClaw Agent Group：身份、Channel、Mailbox、Workspace、OKF Memory与生态能力
```

Workflow和Long Agent不是竞争关系：Workflow组织一次确定性或多阶段执行；Long Agent提供持续身份、长期上下文、多入口和主动协作，并可以把适合的任务交给Workflow。

## 3. 已确认的用户场景

### 3.1 日常使用

用户没有更具体项目时进入系统管理的`daily` Project，在Chat Web或Telegram联系某个长期同事。两个入口映射到`daily + longAgentId`的同一个专属Chat Session，历史在Web可见，回复由同一Pi Runtime生成。

### 3.2 项目协作

用户进入具体Project后，可以继续使用普通Session和Workflow，也可以打开该Project下某个长期同事的唯一专属主Session。长期同事读取当前Project上下文和授权资源，但不能从消息参数伪造Project或跨Project访问。

### 3.3 长期身份与记忆

每个Chat Long Agent映射一个NanoClaw Agent Group。Agent Group的名称、Standing Instructions和OKF Markdown Memory构成运行身份与Agent私有记忆；Chat显示别名只是UI元数据。Personal/Project Mem0保存多个Agent共享的用户与项目事实，两类Memory不自动复制。

### 3.4 多长期同事

一个NanoClaw Host承载多个Agent Group和多个Telegram Bot/Channel Wiring。每个长期同事拥有独立身份、Workspace与Agent Memory；不为每个Agent启动独立NanoClaw进程。

### 3.5 可靠会话

一个`Project + Long Agent`只有一个稳定Chat Session。每次消息只创建一次User/Assistant事实；Pi `AgentSession`是按Turn恢复的执行对象，不是新的产品Session。Channel重试、Chat或NanoClaw重启不能重复执行同一Turn或重复投递回复。

## 4. 当前版本已经落地

| 能力 | 当前实现与验收边界 |
|---|---|
| Project-first与Daily | 所有普通Session、Long Agent Session和Workflow都归属Project；`daily`使用同一合同 |
| Web信息架构 | 侧边栏在“会话 / 长期同事”间切换；普通Session布局不被Long Agent占位干扰 |
| 专属Session | 每个Project Long Agent创建或恢复唯一主Session，Web和Channel共享其历史 |
| 统一Runtime | Chat Backend通过Pi运行Agent；NanoClaw `chat-pi`模式关闭自己的Provider/容器Session Runtime |
| Channel可靠性 | NanoClaw耐久Inbox/Event Outbox，Chat耐久Ingress、幂等Turn、Delivery和Ack |
| Agent Group身份 | NanoClaw提供名称、Standing Instructions、Workspace安全摘要和Revision；Chat按Turn装配 |
| Agent Memory | NanoClaw OKF Markdown为事实源；Web可管理，Pi具备`agent_memory_search/read/write` |
| Shared Memory | Chat现有`memory_search/memory_record`继续访问Personal/Project Mem0 |
| 配置管理 | Web区分Chat运行策略、NanoClaw Agent Group和Agent Memory三个事实源 |
| 审计与恢复 | 配置/Memory写入进入Chat审计；Turn记录Group/Core Revision并可恢复不可变Snapshot |
| 安全边界 | 浏览器只访问Chat Backend；服务Token、Nano数据库、Socket和绝对路径不对前端开放 |

## 5. 当前版本明确不扩张的范围

以下目标从本期发布范围移出。现有文档和接口不得把它们展示为已经可用：

1. NanoClaw定时任务、Webhook和其他非Router事件触发Chat Pi。
2. Long Agent之间的Agent-to-Agent调用。
3. 完整Workspace文件Tool、Skill/Template资源快照与自我扩展审批。
4. 文件、卡片、Reaction、编辑消息和多Destination富消息。
5. 多NanoClaw Host、跨机器Gateway和每Instance独立Credential。本期Registry v1只允许一个Host。
6. Agent创建/删除、Bot Token轮换、Host重启和Channel重连的Web运维控制面。
7. Agent Memory语义向量索引、Mem0自动同步、自动总结/晋升和Telegram历史回填。
8. 一个Project下同一Long Agent的多个主会话，以及在普通Session中临时切换Long Agent。

## 6. 后续任务池

### P1：主动协作

目标场景：长期同事按计划提醒、主动检查任务，并把结果同时写入专属Chat Session和指定Channel。

任务：

1. 定义统一`TriggerEnvelope`，覆盖Channel、schedule、webhook、agent和proactive来源。
2. NanoClaw Task只生成耐久Trigger，不直接启动旧容器Runtime。
3. Chat校验Project Binding、Long Agent状态、目标Session和Delivery Policy。
4. 加入重试、取消、暂停、重复触发和跨重启验收。

验收：同一Trigger只产生一个Pi Turn；禁用或暂停的Agent不会执行；Web和IM看到同一结果。

### P2：受控Workspace与资源生态

目标场景：长期同事维护自己的工作区、技能与可复用知识，同时遵守Chat Project授权。

任务：

1. 将NanoClaw Workspace能力暴露为窄Tool，而不是挂载整个宿主目录。
2. 把Skills、Template和Plugin状态转为固定Revision的Pi Resource Snapshot。
3. 自我扩展只能生成变更提案，经过审批后形成新Revision。
4. 记录`longAgentId/agentGroupId/projectId/sessionId/turnId`和资源来源。

验收：不同Agent Group和Project不能串读写；历史Turn可解释自己使用的资源Revision。

### P3：多Agent协作

目标场景：一个长期同事把独立任务交给另一位长期同事或Workflow，并在父Session看到过程和结果。

任务：

1. 定义Agent-to-Agent目标解析、权限、Child Turn和父子Session投影。
2. 复用Workflow调用的并发、取消、状态与审计机制。
3. 防止循环调用、无限扇出和跨Project越权。

验收：每次委派有稳定ID、来源和结果；重试不重复建立Child Turn。

### P4：Channel与运维扩展

目标场景：在多个Channel和机器上安全管理长期同事。

任务：

1. 富消息与Channel能力协商。
2. 每NanoClaw Instance独立Credential并把认证身份绑定到请求Instance。
3. Agent、Wiring、Channel、Task和Host状态管理页面。
4. 将NanoClaw源码、Credential、数据库和Workspace进一步拆成稳定部署目录。

验收：不同信任域Credential不能互相冒充；升级或回滚代码不会移动或覆盖Agent数据。

### P5：Memory演进

目标场景：Agent可以积累经验，同时用户知道事实来自哪里并能审阅、纠正和删除。

任务：

1. 评估兼容OKF的全文或语义索引，不新增不透明的第三事实库。
2. 设计Agent Memory与Personal/Project Mem0之间的显式“提议复制”流程。
3. 为不可变Context Snapshot实现引用扫描GC；只删除没有任何保留Session引用的快照。
4. 增加来源、置信度、冲突和隐私管理界面。

验收：自动化不能静默污染共享Memory；删除和更正可追溯；失败Turn仍可恢复原Revision。

## 7. 未来续接时的恢复顺序

1. 从[文档索引](../README.md)和本文确认目标场景与本期范围。
2. 阅读[能力模型](./chat-long-agent-capability-model.md)、[多入口架构](./chat-long-agent-architecture.md)和[Pi集成设计](./chat-nanoclaw-pi-integration.md)。
3. 运行当前版本的Chat、Frontend和NanoClaw测试，确认不是在修复未发布工作树。
4. 从第6节只选择一个优先级主题，先补场景、合同、数据所有权和验收，再开发。
5. 不重新引入NanoClaw第二Agent Runtime；不让Frontend直连NanoClaw；不把Agent Memory与Mem0混成同一个事实库。

## 8. 当前发布剩余检查

本节只用于`0.1.0 / 0.3.0 / 2.4.0`发布，完成后可标记：

- [x] Chat完整`pnpm verify`通过。
- [x] NanoClaw最终完整测试、Typecheck和Build通过。
- [x] Agent Group与Memory最小真实CRUD、Web Turn、Telegram Turn和审计验收通过。
- [x] Frontend和NanoClaw提交已推送并合入各自长期分支。
- [x] Chat固定可公开获取的Submodule Commit并合入`main`。
- [x] 稳定Checkout完成NanoClaw私有数据迁移、服务重启和健康验收。
