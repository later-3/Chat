---
name: project-management
description: 创建、查找和管理 Chat 项目，包括学习、旅行、研究及开发项目的基本资料与项目级配置；在用户明确要求建立或管理项目时使用。
---

# Project management

将用户的专项事务建立为持久 Chat Project。配套六个 Tool：project_search、project_read、project_create、project_open、project_update、project_configure。只使用本轮实际提供的 Tool。

本 Skill 来自 Chat 的个人资源目录；runtime/skills 是 Workflow 私有构建资源，prompt-resources 是 Rule/Experience，均不能当作已启用 Skill 清单。NanoClaw Agent Group Skill 是独立来源。

## 创建与查找

- 用户只是询问知识或行程建议时，不自动创建项目。用户明确要求创建时即可操作，信息足够时无需再次确认。
- 用 `project_search` 查找已有候选。明确是继续已有项目时复用稳定 ID；存在多个可能目标时询问；明确另建时允许同名。
- 未指定目录时用 `project_create` 创建托管项目，不要求用户提供路径。保留中文名称，简介只记录已知用途和目标；默认继承配置，不擅自选择新模型或安装资源。
- 为一次逻辑创建分配 requestId，重试保留原值。结果不明时沿同键恢复，不换键反复创建。
- 用户指定外部已有目录时用 `project_open`；路径未获授权则使用前端打开入口，不用文件工具或 Shell 绕过。

## 查看与修改

- 用 `project_read` 读取当前事实和 revision；跨项目操作使用搜索或工具返回的真实 projectId。
- 名称与用途用 `project_update`。学习计划、行程和笔记是项目内容，不塞进系统配置；事实记忆使用现有 Memory 能力并指定实际 Target。
- 配置修改先读取 configuration，需要候选时读取 capabilities。只改用户要求的字段，通过 `project_configure` 写入；恢复默认使用 unset，不清空整份配置。
- Workflow Agent 与 Long Agent 的配置作用域不同。Project Tool 不修改 Long Agent 的 Personal 模型定义。
- revision 冲突时重新读取，核对用户意图与并发修改；无法无歧义合并时说明冲突，不盲目重放覆盖。
- 不复制 Credential，不自动生成或覆盖 AGENTS.md，不因为建项目而创建提醒、Channel 绑定或长期 Agent。

## 完成与后续

- 根据工具结果报告实际项目名称、ID、创建／复用状态，以及已完成与失败的配置项；不把计划步骤说成完成。
- 返回工具提供的项目导航目标。创建不改变当前 Session 归属或 cwd；进入目标 Project 新会话后再开展该项目内容工作。
- 缺少 Tool、权限或入口衔接时说明具体缺口；不要手写 Manifest、Registry、Session 或私有配置替代受控操作。
- 配置默认值变更不保证已有 Session 立即采用；根据工具诊断说明新建会话或重置选择的下一步。

## 配置调用

`project_read` 的 `view: "configuration"` 返回 Project 覆盖与 revision；同时指定 workflowId、agentId 才返回对应 Agent 私有配置和它独立的 revision。`view: "capabilities"` 分页返回准确候选，沿 nextCursor 查找，不猜名称、路径或模型 ID。

配置 target 为 `{ "kind": "project" }` 或 `{ "kind": "workflow-agent", "workflowId": "...", "agentId": "..." }`。operations 使用字段路径段数组，例如：

```json
{
  "target": { "kind": "project" },
  "expectedRevision": "从project_read读取的revision",
  "operations": [{ "op": "set", "path": ["defaultWorkflowId"], "value": "已登记的Workflow ID" }]
}
```

Workflow Agent 的模型用 `["model"]`，值为 `{ "provider": "...", "modelId": "..." }`；恢复默认用 `{ "op": "unset", "path": ["model"] }`。项目级资源选择路径形如 `["workflows", workflowId, "agents", agentId, "resources"]`。数组整体替换；不接受任意文件路径或数组索引。

若 Tool 返回权限限制或需要外部目录授权，转到 Chat 配置／项目选择器处理。不要通过写配置文件、Shell 或自授 Tool 绕过。

创建或读取结果中的 navigation.url 使用 Chat 现有的 cwd 导航合同；呈现为相对当前 Chat 站点的“进入项目”链接，不猜公网域名或端口。
