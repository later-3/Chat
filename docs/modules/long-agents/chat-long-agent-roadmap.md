# Chat Long Agent 实施状态与迁移要求

## 1. 当前交付范围

2026-09-20 校正。P1–P4 已实现公共装配、每轮协作项目、每日 Session 与共同聊天反馈；P5 完成情况与验收证据以[开发计划](../../development/agent-unification-plan.md)及其阶段审计为准。这里记录能力边界，未提交工作区不等于已部署版本。

| 能力 | 实现事实 | 限制 |
|---|---|---|
| 身份与配置 | 稳定 Friend ID、独立 definition、Web 配置与有效模型查询 | Chat 运行定义与 Nano Group 身份仍按现行管理合同分域 |
| Workspace / Project | Home 与协作项目分离，每条消息冻结规则和工具目标 | 自然语言切换入口绑定服务尚未交付，不把模型说“已切换”当成程序状态 |
| Pi 装配 | Workflow/Friend 复用 createChatPiAgentSession | explicit 策略不会偷偷增加资源；重启无法恢复旧资源版本时明确失败 |
| 每日会话 | 每 Friend、IANA 日期一条直接交流 Session，换日总结/交接 | 不支持同一 Friend 同时写多个直接交流 Session；显式 Workflow 子任务另行隔离 |
| 实时展示 | 普通/Friend 共用事件消费、消息、工具与终态 | Workflow 暂无引导/后续队列；Friend 按实际能力提供 |
| Channel | 耐久 Event、私聊授权、同日排序、Delivery/Ack 重试 | 真实外部收发验收须单独记录；不支持群聊接入私有每日历史 |
| 调度 | 既有 Nano schedule 事件接入 Chat Pi，默认日常任务可管理 | 完整主动工作、订阅和任务产品仍未交付 |
| Memory | Chat Personal/Project Catalog 与 Nano OKF Agent Memory | 物理根统一迁移（旧 S5b）仍未实施，不自动互相复制 |
| 历史升级 | 旧数据、渠道上下文、归属、精确链接与可重试标记 | v1 已删除且没有备份的数据不能凭空恢复 |
| Docker | chat-pi 不依赖原生 Agent 容器 | 受控工具/脚本/MCP Docker 环境仍待设计实施 |
| Social / 多 Agent | 既有动态阅读与单 Agent 管理 | 群聊、多人共享、跨 Agent 参与和动态写入不在此次 P1–P5 内 |

## 2. 已取代的旧设计

2026-09-07～10 文档中的“共享 daily 是默认交流容器”“每业务 Project 建 Friend 主 Session”“启动迁移立即创建当天 Session”“把旧 Agent Catalog 合入 Personal”“同一个 Friend 可开多条直接交流主题”不再作为现行施工要求。

最新用户定义是：Friend 稳定存在，用户与它协作项目；切项目不换 Friend/当日 Session，只影响下一轮上下文。普通项目仍可以自行创建多个 Workflow Session。旧历史保持原生事实，不为了表现统一而改写来源。

## 3. 迁移边界

- Home 采用 `long-agents/<id>/`；新普通 Session 保留用户 Project 归属。
- 旧 Project、JSONL、Memory 和配置不删除；有明确归属的旧 Friend 会话只读，新交流定位今天。
- 旧 Nano 地址与目的地保留，业务 contextProjectId 在迁移中固定；新来信统一进入 Home 日历，不继承 Web 选择。
- 未完成迁移不发布完成标记；备份不随重试覆盖；文件/定义冲突明确失败。详细操作见[Friend 升级手册](../../operations/friend-migration.md)。
- 旧版本回退必须停服务并恢复一致的数据副本；已有新消息时向前修复，不用旧 state 覆盖新历史。

## 4. 后续能力的实施前提

下面是保留的未来方向，并非本轮已授权开发：

1. Agent 身份与资源的完整单源管理、公共自我管理 Skill 的发布和生效证据。
2. 统一可见项目概览、活动查询、受授权的历史发现与共享认知。
3. 任务/职责/订阅/自主工作及受控 Docker 工具环境。
4. Agent 间协作、群聊和多用户参与，先定义身份、受众、历史权限和消息/工作关联。

按[机制合同](./chat-long-agent-mechanism-contract.md)识别扩展层级，并核对[实施前基线](./chat-long-agent-engineering-baseline.md)的原生接缝、Skill 生效、Session 扩展、资源权限及验证门槛。不能通过新建模型 Runtime、直接读 Nano 数据库或全域共享 Memory 快速拼接功能。

## 5. 验收与交接

现行生命周期规范见[Long Agent 架构](./chat-long-agent-architecture.md)，配置见[能力模型](./chat-long-agent-capability-model.md)，协议接缝见[Nano/Pi 集成](./chat-nanoclaw-pi-integration.md)。P1–P5 的 S01–S12 是本轮验收范围；更广的[长期场景](./chat-long-agent-scenarios.md)仍需后续合同与实施，不能一起宣称完成。
