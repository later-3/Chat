---
name: long-agent-management
description: 管理 Chat 长期同事（Long Agent）的生命周期：查看、创建、归档、恢复和删除；在用户明确要求管理长期同事时使用。
---

# Long Agent management

管理 Chat 长期同事的生命周期。配套 Tool：`long_agent_manage`（list / get / create / archive / unarchive / delete）。只使用本轮实际提供的 Tool；没有该 Tool 时向用户说明当前未获授权，不要声称已完成操作。

## 概念与边界

- 每个长期同事是独立管理实体：拥有自己的配置目录（`<CHAT_HOME>/long-agents/<id>/`）、独立日常 Project（`daily-<id>`）、Memory 与任务。共享资源只能放在明确规定的共享位置。
- 身份、配置、Session、Memory、任务和日志按 Agent 隔离；操作一个 Agent 不影响其他 Agent。
- 运行身份名称与长期职责由 NanoClaw Agent Group 的 name 和 standingInstructions 决定；本 Tool 不修改它们。
- 创建、归档、删除都会写入审计日志。

## 操作规则

- **list / get**：随时可用。创建或修改前先 get 目标，确认当前状态。
- **create**：需要 id（小写字母/数字/连字符）、name、nanoclawAgentGroupId。创建一次性配齐独立配置目录与专属日常 Project（`daily-<id>`）。NanoClaw Agent Group 必须先在 NanoClaw 侧存在，否则创建失败；Channel 绑定可之后补。创建前向用户确认名称与用途。
- **archive / unarchive**：归档停止新工作并保留全部数据，可恢复；恢复后继续工作。
- **delete**：两阶段——必须先归档。删除会移除登记、配置目录与头像资产；不删除该 Agent 参与过的业务 Project 历史，Daily Workspace 文件保留在磁盘。删除不可逆，执行前必须向用户明确确认。

## 冲突与失败

- 返回冲突或找不到时，先 list/get 读取最新状态再决定下一步，不盲目重试。
- 失败时向用户报告 Tool 返回的真实原因，不猜测状态。
