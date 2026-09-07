# Project 管理 Skill 与 Tool

状态：实现于当前工作区；部署运行版本由父仓库发布决定。本文是 Project 管理能力的技术合同，[配置说明](../configuration.md#project-管理-skill-与-tool)为使用入口。Skill 正文唯一源码为 [project-management/SKILL.md](../../src/resources/builtin-skills/project-management/SKILL.md)。

## 1. 所有权与调用链

Project 是学习、旅行、研究、开发等专项事务的持久边界。用户无需预建代码仓库或选择模型即可创建普通托管 Project。

```text
Long Agent / Workflow Agent
  → Pi Skill（工作方法）+ 六个选中的系统 Tool（动作）
  → src/projects/ 管理服务
  → 现有 Registry、ProjectContext、Chat 配置和 Agent 私有配置
```

Provider 位于 `src/tools/builtins/project-*/`，由统一 Tool Registry 发现，通过 `createChatPiAgentSession()` 的 `customTools` 装配。服务采用延迟导入，避免 Tool 与 Workflow Registry 的初始化环。HTTP 与 Tool 配置写入共用原有服务的文件锁；没有第二套 Agent Runtime 或配置库。

Skill 不注册 Tool。安装文件与选择 Tool 是两件事；只有实际装配的 Tool 能执行。

## 2. 发布、安装与发现

- Skill 以 Nitro `builtin-skills` Server Asset 随 Backend 构建发布。
- Backend 初始化调用 `ensureProjectManagementSkill()`，安装到 `<CHAT_HOME>/agent/skills/project-management/SKILL.md`。它是普通 Personal Skill，不属于 `runtime/skills`，也不是 NanoClaw Group 私有 Skill。
- `<CHAT_HOME>/runtime/builtin-skills/project-management.sha256` 只记录最后安装内容的 hash。升级仅覆盖未被用户修改的托管副本；同名用户文件和用户改动保留。中断后若目标已经等于新版本，可以补写收据。
- Long Agent 的默认 Definition 包含六个 Project Tool 地址；已有显式 Definition 不自动改写。`resources.mode=inherit` 的 Agent 按正常 Pi 规则发现个人 Skill；explicit 必须选中该路径。
- 下一 Turn 重新装配时发现本地最新资源。正在运行的 Turn 不热切换。新增 Backend Tool 代码需要发布并重启 Backend，单纯安装 Markdown 不会让旧 Backend 获得 Tool。
- 未选中 Tool 时 Skill 必须说明缺失，不能通过 Shell 手写 Registry 或配置绕过。

## 3. 创建的最小内容

```text
<CHAT_HOME>/workspaces/<projectId>/
  .chat/project.json     # schemaVersion、稳定 id、中文 name、description
  .chat/config.json      # 默认仅 { "schemaVersion": 1 }

<CHAT_HOME>/projects/<projectId>/
  sessions/ memory/ prompt-resources/ workflows/
```

ID 由 Backend 生成，不要求模型翻译中文或拼装路径。托管项目仍是普通 Project，只有保留 ID `daily` 具有默认角色。配置默认继承，不自动安装额外资源或选择模型。

名称与用途存 Manifest；计划、笔记、行程是工作目录里的普通内容；事实记忆用现有 Memory Tool；可复用约束走既有 Rule 合同。创建不自动生成 AGENTS.md、提醒、Channel Binding、长期 Agent 或整套模板目录。

## 4. Tool 合同

所有地址为 `system:tool/<name>`。输入由 TypeBox Schema 校验，拒绝未知字段；源码合同位于 `src/projects/management-contract.ts`。

| 名称 | 参数概要 | 行为 |
|---|---|---|
| `project_search` | query?、cursor?、limit? | 名称／简介检索，省略 query 列表；返回稳定 ID、可用性与当前项目标记 |
| `project_read` | projectId?、view?、workflowId?、agentId?、cursor? | summary、configuration 或 capabilities |
| `project_create` | name、description?、requestId | 创建托管项目；同请求重试返回 existing |
| `project_open` | path、requestId | 打开已经通过前端登记授权的精确目录；本身按路径幂等 |
| `project_update` | projectId?、expectedRevision、changes | 只改 name／description，禁止改 ID 和路径 |
| `project_configure` | projectId?、target、expectedRevision、operations、validateOnly? | 修改一个配置目标或恢复继承 |

省略 projectId 表示当前 Project，显式目标经 Registry 解析。来源 Project、Session、Agent、Turn 来自宿主，不接受模型伪造。

名称 1～120 字符，简介最多 4000 字符，查询最多 200 字符；列表默认 20、最多 100 项；每次配置最多 20 个操作。数字 cursor 是本次列表偏移，失效时重新查询；名称不是唯一键，搜索结果不能代替身份。

### project_read

- summary 返回资料、Manifest revision 和导航。路径不可用时仅返回缓存摘要，不伪造配置可读。
- configuration 返回 Personal、Project 原始覆盖、Project effective 默认和 Project 文件 revision。workflowId/agentId 必须成对提供，返回对应私有配置及独立 revision；不存在的文件用 `absent`。
- capabilities 复用 Workflow Registry、系统 Tool Catalog、Pi Skill 发现和 ModelRuntime，分页返回候选；模型只返回已有认证的安全字段。Skill 列表不加载 Extension 代码。Tool 的 grantable 指当前调用者是否拥有对应系统地址。

Project effective 默认不是当前 Session/Turn 的最终配置。Long Agent Definition 是 Personal 配置，Project Tool 不修改它。

### project_open

当前没有可信的 Agent 新宿主目录授权票据，因此只接受 Registry 中已经打开的精确根目录。首次目录由现有前端项目选择器打开。位于已授权目录的子目录不自动成为新 Project 授权，符号链接规范化后仍按精确根检查。已有 Manifest 损坏或身份不匹配时失败，不重建身份、不回退 Daily。

requestId 用于调用方关联；此操作不分配新项目身份，幂等性来自同一规范化路径与原 Manifest。与 create 的持久幂等键语义不同。

### project_configure

```text
target = { kind: "project" }
       | { kind: "workflow-agent", workflowId, agentId }
operations = [{ op: "set", path: [字段段...], value },
              { op: "unset", path: [字段段...] }]
```

project 目标使用现有 ChatConfigOverride，支持默认 Workflow、Agent Prompt/Tool/资源选择和 Session 保留期。workflow-agent 目标使用现有私有配置，支持 model、thinkingLevel、tools。模型不能放入 Project 根 config 的非法位置。

path 是字段段数组，不是文件路径；禁止数组索引、重复／父子冲突路径和原型污染键。数组整体替换，unset 删除本层覆盖。删完私有 Agent 配置时移除文件，恢复继承。validateOnly 只解析检查，不写目标配置。

Workflow/Agent/Prompt 引用经现有 Resolver 校验；模型需存在且有认证，Skill 路径需存在。新增系统 Tool 不得超出调用者实际选中地址；新增显式 Tool 名必须来自已有选择或宿主授权名称。新 Extension/Plugin 代码资源仍须通过配置入口授权，不能由管理 Tool 自行启用。默认资源继承继续遵守原有 Project/Personal 规则。

## 5. 版本、并发与恢复

revision 是文件内容 SHA-256 或 absent，不改变 Manifest schemaVersion。锁内读取、比较 expectedRevision、应用修改、完整校验、原子替换。网页配置写入、保留期修改与 Tool 修改共用锁；网页整份替换仍保持原有最后写入语义，不宣称旧 HTTP 合同具有用户版本 CAS。

Project summary 和配置读取在对应锁内获取内容与 revision。私有 Agent 配置的多个写入口共用同一文件锁。部署仍是单 Backend 进程；外部编辑器不参与服务锁，不承诺跨进程事务互斥。

创建涉及多文件，不把 rename 当成跨文件事务：

1. 对可信来源 Session + requestId 派生标记 ID，串行写入 `<CHAT_HOME>/runtime/project-operations/<hash>.json`，保存分配 projectId、参数摘要和 pending 状态。
2. 幂等初始化本操作目录、Manifest 和最小配置，拒绝身份冲突与符号链接越界。
3. 经原 openProject 登记，再标记 completed。
4. 同键同参数恢复原项目，同键不同参数报冲突；不通过重试分配新 ID，不自动删除失败目录。

完成标记长期保留作幂等凭据，未实现短期 TTL 回收。记录与用户内容不进入源码。Skill 安装收据是独立的资源版本记录，不复用创建事务。

Tool 抛出 JSON 错误文本，由 Pi 生成原生 `isError=true` ToolResult；不能仅在返回对象上加 isError，因为 Pi 不消费该字段。可识别错误包括版本冲突、项目不可用、路径拒绝、无效配置、资源不可用和持久化不完整；已写入但后续审计／收据失败明确报告 applied，不谎称回滚。

审计复用 `audit.jsonl`，保留 Source、Target、Tool 地址版本、请求 revision、结果 revision 与配置变更字段，不记录完整配置／Credential。Long Agent 不需要伪造 Workflow 身份。

## 6. 会话衔接与用户场景

创建／读取／打开返回 `navigation: { projectId, action: "new-session", url }`。url 复用前端现有 `/?cwd=<编码后的后端规范化项目路径>` 合同，由 Backend 已解析路径生成；不是另建按 project 参数猜测的路由。打开链接后前端仍调用 Project API 校验。

创建不修改来源 Session 的 projectId 或当前执行 cwd，也不修改 Telegram 绑定。IM 返回入口后由用户进入对应项目；没有公网基址时不得猜域名。当前会话里不能声称已切到新 Project。

- “创建学习道德经项目”：搜索候选，用户确实要新建时创建名称和用途摘要，默认继承；不要求先选教材或学习节奏。
- “创建国庆云南旅游规划，预算8000元，两个人”：保存已知目标，不猜年份和天数；创建项目不触发预订或提醒。
- “这个项目改模型”：明确 Workflow/Agent 后写其私有配置；当前是 Long Agent 时说明 Personal 边界，不冒充项目级模型修改。

## 7. 验证入口

- `src/projects/management.test.mjs`：创建重放与恢复、精确路径授权、字段校验、并发 revision、继承恢复、资源授权、Skill 安装保护及 Pi 装配。
- `src/long-agents/long-agents.test.mjs`：同一 Long Agent 主 Session 中读取 Skill 并执行全部六个 Tool，不改变来源项目。
- `scripts/project-management-runtime-fixture.mjs`：本地假模型真实调用 Skill/read 与六个 Tool。
- `scripts/built-server.test.mjs`、`scripts/dev-server.test.mjs`：同一场景经过生产和 Nitro 开发 Workflow/Step/Pi 链。

交付运行 `pnpm verify`、`git diff --check`、`git -C frontend diff --check`。部署需另按部署文档执行，不因源码实现完成就宣称当前生产 Agent 已更新。
