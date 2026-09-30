# Chat Long Agent 实施状态与迁移要求

## 2026-09-27 统一执行补充

当前开发分支的新 Friend 日常、独立后台工作、Topic 节点轮次，均经原有受理/排序/身份冻结后进入 `startChatWorkflow` 与同一 Workflow SDK。Frontend 可在原 Pi Session 内选择下一轮 Workflow，历史与存储 Home 不变。旧无 workflow 字段的请求保留兼容执行；群聊专用调度不在这次单聊统一范围。精确合同与进程中断语义见[模块合同](../../architecture/chat-module-contracts.md#三类会话的统一执行与导航2026-09-26)，导航读取与失效见[性能文档](../../development/session-navigation-performance.md)。本条为未发布开发分支事实，不意味着正式服务已升级。

## 1. 当前交付范围

2026-09-30 校正。P1–P4 已实现公共装配、每轮冻结项目、每日 Session 与共同聊天反馈；P5 完成情况与验收证据以[开发计划](../../development/agent-unification-plan.md)及其阶段审计为准。这里记录能力边界，未提交工作区不等于已部署版本。2026-09-28 起统一项目合同生效：全产品只有一个项目上下文（UI 文案"项目"），每轮执行项目按入口唯一确定并受理冻结；LA6-A 的 per-Friend `interaction.json` 关联已整体移除（见[机制合同 §10](./chat-long-agent-mechanism-contract.md#10-已退役la6-afriend-协作项目关联--统一项目合同)）。

| 能力 | 实现事实 | 限制 |
|---|---|---|
| 身份与配置 | 稳定 Friend ID、独立 definition、Web 配置与有效模型查询 | Chat 运行定义与 Nano Group 身份仍按现行管理合同分域 |
| Workspace / Project | Home 与本轮冻结项目分离，每条消息冻结规则和工具目标；项目目标由顶栏"项目"选择器逐轮提供 | 自然语言切换入口绑定服务尚未交付，不把模型说“已切换”当成程序状态 |
| Pi 装配 | Workflow/Friend 复用 createChatPiAgentSession | explicit 策略不会偷偷增加资源；重启无法恢复旧资源版本时明确失败 |
| 每日会话 | 每 Friend、IANA 日期一条直接交流 Session，换日总结/交接 | 不支持同一 Friend 同时写多个直接交流 Session；显式 Workflow 子任务另行隔离 |
| 独立后台工作（LA1） | 同 Friend 独立 Session、按 Session 排队、持久句柄与冻结项目、侧栏和 friend_work Tool | 当前固定最多 4 条活跃后台 Session；任务、职责、产物、本地群聊已分别由 LA2–LA5 接入，各阶段验收范围见开发计划 |
| 实时展示 | 普通/Friend 共用事件消费、消息、工具与终态 | Workflow 暂无引导/后续队列；Friend 按实际能力提供 |
| Channel | 耐久 Event、私聊授权、同日排序、Delivery/Ack 重试 | 真实外部收发验收须单独记录；不支持群聊接入私有每日历史 |
| 调度 | Nano 触发、任务修订、Occurrence、独立 Work、职责及产物闭环已接入 | 真实外部平台和至少 24h 自然运行必须独立验收；日终归档本次工作区改动不等于正式服务已更新 |
| Memory | Chat Personal/Project Catalog 与 Nano OKF Agent Memory | 物理根统一迁移（旧 S5b）仍未实施，不自动互相复制 |
| 历史升级 | 旧数据、渠道上下文、归属、精确链接与可重试标记 | v1 已删除且没有备份的数据不能凭空恢复 |
| Docker | chat-pi 不依赖原生 Agent 容器 | 受控工具/脚本/MCP Docker 环境仍待设计实施 |
| Social / 多 Agent | 任务产物幂等发布、本地单 Backend 群聊与多 Friend 策略已实现 | 外部平台群投递、跨进程写入与完整 LA6 联合验收不能由本地通过推断 |

## 2. 已取代的旧设计

2026-09-07～10 文档中的“共享 daily 是默认交流容器”“每业务 Project 建 Friend 主 Session”“启动迁移立即创建当天 Session”“把旧 Agent Catalog 合入 Personal”“同一个 Friend 可开多条直接交流主题”不再作为现行施工要求。

最新用户定义是：Friend 稳定存在，用户在统一项目上下文下与它协作；切项目不换 Friend/当日 Session，只影响下一轮冻结的项目。普通项目仍可以自行创建多个 Workflow Session。旧历史保持原生事实，不为了表现统一而改写来源。

## 3. 迁移边界

- Home 采用 `long-agents/<id>/`；新普通 Session 保留用户 Project 归属。
- 旧 Project、JSONL、Memory 和配置不删除；有明确归属的旧 Friend 会话只读，新交流定位今天。
- 旧 Nano 地址与目的地保留，业务 contextProjectId 在迁移中固定；新来信统一进入 Home 日历，不继承 Web 选择。
- 未完成迁移不发布完成标记；备份不随重试覆盖；文件/定义冲突明确失败。详细操作见[Friend 升级手册](../../operations/friend-migration.md)。
- 旧版本回退必须停服务并恢复一致的数据副本；已有新消息时向前修复，不用旧 state 覆盖新历史。

## 4. 后续能力的实施前提

LA0–LA5 已形成分阶段验收记录，范围与限制以[Friend 功能计划](../../development/long-agent-functionality-plan.md)末节和所链接审计为准；[LA5](../../history/reviews/2026-09-21-long-agent-la5-acceptance.md)仅覆盖本地单 Backend 群聊。LA6-A 旧项目关联后来已退役，不能把其历史验收作为现行项目合同证据。仍需后续实施或独立验收的方向：

1. Agent 身份与资源的完整单源管理仍需后续切片。公共 `long-agent-management` Skill 已进入内置资源发布链；是否对某个 Agent 生效仍以资源策略、解析检查和本轮实际装配为准，不能由源码存在推断。
2. 统一可见项目概览、活动查询、受授权的历史发现与共享认知。
3. 现有任务/职责/产物之外的完整自主工作与订阅场景，以及受控 Docker 工具环境。
4. 现有本地群聊范围之外的外部真实群投递、多用户/多进程协作和长期联合运行。

按[机制合同](./chat-long-agent-mechanism-contract.md)识别扩展层级，并核对[实施前基线](./chat-long-agent-engineering-baseline.md)的原生接缝、Skill 生效、Session 扩展、资源权限及验证门槛。不能通过新建模型 Runtime、直接读 Nano 数据库或全域共享 Memory 快速拼接功能。

当前仍有项目合同差距：新 IM 绑定及旧 schedule 兼容路径在 `bridge.ts` 中读取 `defaultProjectId`，已有绑定保留 `contextProjectId`；它们尚未全部收敛到目标的“IM/定时在 Agent Home 执行”。UI 中“新建渠道交流的默认项目”反映现行实现，不代表已满足统一项目目标。修复须一并处理既有绑定、已受理事件和任务迁移，不能只删除表单字段。见[2026-09-30 专项排查](../../history/reviews/2026-09-30-configuration-capability-audit.md)。

## 5. 验收与交接

现行生命周期规范见[Long Agent 架构](./chat-long-agent-architecture.md)，配置见[能力模型](./chat-long-agent-capability-model.md)，协议接缝见[Nano/Pi 集成](./chat-nanoclaw-pi-integration.md)。P1–P5 的 S01–S12 是本轮验收范围；更广的[长期场景](./chat-long-agent-scenarios.md)仍需后续合同与实施，不能一起宣称完成。

LA2 已实现任务定义、修订、一次性/周期/可信事件触发、独立执行历史及旧 Nano 任务单所有者迁移，具体合同见 [Friend 任务](./tasks.md)，验证范围见 [LA2 验收](../../history/reviews/2026-09-20-long-agent-la2.md)。
