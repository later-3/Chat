---
name: long-agent-management
description: 理解 Chat 长期助手的身份、实际工具、私有与共享记忆、每日归档和生命周期；需要了解自己的能力、使用记忆或管理长期助手时阅读。
---

# Long Agent management

管理 Chat 长期同事的生命周期。配套 Tool：`long_agent_manage`（list / get / create / archive / unarchive / delete）。只使用本轮实际提供的 Tool；没有该 Tool 时向用户说明当前未获授权，不要声称已完成操作。

## 概念与边界

- 每个长期同事是独立管理实体：拥有自己的配置目录（`<CHAT_HOME>/long-agents/<id>/`）、独立 Agent Home（Project ID 为 Agent ID）、Memory 与任务。共享资源只能放在明确规定的共享位置。
- 身份、配置、Session、Memory、任务和日志按 Agent 隔离；操作一个 Agent 不影响其他 Agent。
- 运行身份名称与长期职责由 NanoClaw Agent Group 的 name 和 standingInstructions 决定；本 Tool 不修改它们。
- 创建、归档、删除都会写入审计日志。

## 操作规则

- **list / get**：随时可用。创建或修改前先 get 目标，确认当前状态。
- **create**：需要 id（小写字母/数字/连字符）、name。创建会配齐独立配置目录、专属日常 Project（ID 即 Agent ID）和 NanoClaw Agent Group；已有 Group 的迁移可显式提供 nanoclawAgentGroupId。Host 必须已启动并配置服务认证，Channel 绑定可之后补。名称与用途按用户请求确定；创建失败保留相同 ID、名称与描述重试，不连续换 ID。
- **archive / unarchive**：归档停止新工作并保留全部数据，可恢复；恢复后继续工作。
- **delete**：两阶段——必须先归档。删除会移除登记、配置目录与头像资产；不删除该 Agent 参与过的业务 Project 历史，Daily Workspace 文件保留在磁盘。删除不可逆，执行前必须向用户明确确认。

## 能力与记忆入口

本轮 Tool 清单是当前可执行能力，历史中“尚未上线”的描述不是当前状态。Tool 存在也不代表服务在线，实际调用失败要保留原因。不要猜测 `~/.pi`、NanoClaw 数据目录或原生容器路径；本 Skill 不能授予未选择的工具或其他 Agent 的权限。

| 要保留或查询什么 | 使用实际提供的入口 |
|---|---|
| 自己的工作方法、关系史、开放事项与长期知识 | NanoClaw 私有 OKF Markdown：`agent_memory_read` 不传 path 列目录，传相对 path 读取；`agent_memory_search` 搜索；`agent_memory_write` 写入 |
| 多 Agent 共享的用户偏好、项目事实 | Chat `memory_search` / `memory_record`，显式区分 Personal 与 Project；没有本轮项目时不能把 Agent Home 冒充 Project Target |
| 当前会话的要点 | `session_memory`，不等于完整历史或跨会话私有记忆 |
| 某天发生的会话、任务和独立总结 | `summary_manage` 的 day/session/read/list/search/write |

修改 Markdown 前先读取正文与 revision，保留 frontmatter 和未知元数据；写入携带精确 expectedRevision。新文件才用 null，冲突后重新读取并合并；维护相关 index.md 链接。不把 Nano Memory 自动复制到共享 Catalog，也不将工具返回的错误解释成空库。核心 index.md 和 system/definition.md 是每轮注入的快照；其他文件按需读取，实时读取结果可能比本轮快照更新。

## 冲突与失败

- 返回冲突或找不到时，先 list/get 读取最新状态再决定下一步，不盲目重试。
- 失败时向用户报告 Tool 返回的真实原因，不猜测状态。

## 每日工作与连续性

每个启用的 Agent 有独立的每日总结任务，默认按任务时区次日 00:10 总结前一天，任务页可调整、暂停或取消。通过实际授权的 `summary_manage` 查询 day 目录，逐页读取 session，覆盖私聊、独立工作、定时/事件任务、职责及当前授权群活动；区分失败、跳过、进行中与完成。读取已有总结的 revision 后，write 使用 expectedRevision 原子保存当天独立 summary.md；未落盘不能声称完成。源 Session 与任务仍保留原位置，用稳定 ID 关联。

总结是自身记忆，不属于用户会话，不向渠道或朋友圈发送。新日自动加载昨天总结；更早的总结和会话用 read/list/search/session 按需读取。缺失总结不阻断正常交流，也不能编造。任务执行被中断时先核对历史与文件，不盲目重放。没有 summary_manage 权限时明确报告能力缺失，不自行扩大授权。
