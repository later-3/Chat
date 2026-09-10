# Chat Long Agent 管理实体与隔离架构

## 1. 文档地位与状态

本文定义 Long Agent 作为一级管理实体的身份、隔离、目录、资源共享与生命周期合同。

**状态：2026-09-09 用户确认的架构决策，属于目标合同，不是已发布能力。** 当前实现差距见第 8 节与[实施状态](./chat-long-agent-roadmap.md)；实施按第 7 节切片推进，每片落地后回写本文与 roadmap。资源作用域的基础协议仍以[Context与Resource统一模型](./chat-context-resource-model.md)为准，本文是它的 Long Agent 领域扩展；目录布局与[定义与配置模型](./chat-long-agent-capability-model.md)§5 一致，冲突时以本文的已确认决策为准。

## 2. 已确认的核心决策

1. **Long Agent 是与 Project 同级的一级管理实体。** 它比照 Project 管理模式建设：稳定 ID、身份文件、索引、独立数据根和完整的创建/修改/归档/删除生命周期，而不是 Registry 文件里的一段内联配置。
2. **按 longAgentId 全量隔离。** 身份、配置、Session、Memory、任务（todo）、日志与活动记录、Daily Project 和 Workspace 全部按稳定 `longAgentId` 隔离；一个 Agent 的故障、归档或删除不波及其他 Agent 的数据。
3. **共享只通过明确规定的共享位置。** 任何跨 Agent 共用的资源必须放在规定的共享目录并遵守其治理规则；不允许因为一个文件"恰好"在某处就被多个 Agent 隐式共用。
4. **存在 ≠ 默认使用，生效必须来自配置。** 资源可发现（在共享目录中）不等于默认生效；只有写入该 Agent 配置（默认条目或显式选择）的资源才生效。属主级资源由属主的默认配置引入，跨域资源必须显式点选——点选是授权动作，可撤销、有记录、按版本冻结。
5. **每个 Long Agent 拥有独立 Daily Project 与 Workspace。** 不再共用普通 Chat 的 `daily`；日常主 Session 按日轮换的目标不变。

## 3. 身份与目录合同

镜像 Project 管理（`project.json` 身份文件 + `projects/registry.json` 索引 + `projects/<projectId>/` 数据根）：

```text
<CHAT_HOME>/
  long-agents.json                    # 索引：longAgentId → 根路径、状态、NanoClaw 绑定；不再是配置事实源
  long-agents/<longAgentId>/          # 每个 Agent 的独立根（配置事实源，同时是它的日常项目）
    definition.json                   # 能力定义：模型引用、System Prompt、Tool/资源策略
    prompts/  skills/  extensions/    # 自有资源
    workspace/                        # Agent Workspace，同时就是它的日常项目根（cwd）
    sessions/                         # 按天轮换的会话（项目 id 即 longAgentId）
    memory/                           # Agent Memory 的唯一可写位置
    environments/  tasks/
  workspaces/longagentshare/          # 公共 Long Agent 资源共享空间（原共享 daily；不默认打开）
  projects/<projectId>/               # 只有用户自己的真实项目
```

- 公共 Long Agent 资源共享空间是 `longagentshare`（原共享 `daily` 归一而来），不默认打开，也不属于任何用户项目。
- 业务 Project 保持原位，Agent 参与不搬运项目文件；Agent Workspace、Daily Workspace、业务 Project 根和运行时 cwd 是不同概念。
- `runtime/` 继续只放派生快照与执行状态，不升级为配置事实源。

## 4. 资源归属与生效矩阵

统一规则：**可发现（共享位置）→ 默认生效（属主默认配置）→ 跨域生效（显式点选 = 授权）**，三级都必须可解释、可撤销、有版本记录。

| 层级 | Owner | 位置 | 默认生效条件 | 跨域使用 |
|---|---|---|---|---|
| Chat 系统 | Chat（Personal） | `~/.chat/agent/{skills,extensions,prompts}` | 写入该 Agent 的默认配置 | 所有 Agent 可发现，须配置后生效 |
| Project | 某个 Project | `<project-root>/.chat/{skills,extensions,prompts}` | 该 Project 上下文中的 Agent 默认配置 | 其他 Project/Agent 须显式点选并记录授权 |
| Workflow | 某个 Workflow | `src/workflows/<wf>/agents/<agent>/{skills,extensions}` | 该 Workflow 的 agent.json 默认引用 | 其他 Workflow 须显式点选；Workflow 私有资产保持代码归属，引用按版本冻结 |
| Long Agent | 某个 Long Agent | `long-agents/<longAgentId>/{skills,extensions,prompts,...}` | 该 Agent 自己的 definition 默认配置 | 其他 Agent 须显式点选并记录授权 |

- 跨域引用使用统一地址（ResourceAddress 扩展），冻结引用时的版本，记录发起 Agent、时间和理由；源资源更新不隐式波及引用方，删除时引用方得到可诊断的失败。
- 引用共享资源不改变其 Owner，也不复制到引用方目录。
- 同名冲突必须按"自有 → 当前 Project → Workflow → 共享"的显式优先级解释，不能按磁盘遍历顺序覆盖。
- 当前 Pi `inherit` 语义的自动目录发现是过渡实现；目标是以配置为唯一生效来源，自动发现只用于"可发现"清单。

## 5. 生命周期合同

| 操作 | 语义 | 边界 |
|---|---|---|
| create | 一次 provisioning：独立根（agent.json + definition.json + 资源目录）→ 独立 Daily Project 与 Workspace → NanoClaw Agent Group 绑定 → 索引登记 | 任一步失败整体回滚，不留半注册实体 |
| update | 修改 definition 或身份字段，版本化；下一次执行重新解析 | 受管字段只有一个可写定义（Chat 文件配置），不双写 NanoClaw |
| archive | 停止新工作与触发，保留全部数据，可恢复 | Channel 绑定保留但拒收新任务；历史 Session/Memory 只读可见 |
| delete | 两阶段：先 archive，显式确认后才删数据 | 不删除该 Agent 参与过的业务 Project 历史与共享资源；删除 NanoClaw 绑定走管理 API |

生命周期操作与 Project 管理一样只由 Backend 服务执行，Frontend 与 Agent 管理 Tool 共用同一 API；不允许直接手改文件来"创建"Agent。

## 6. 与 NanoClaw 的边界

- 一个 Chat Long Agent 仍对应一个 NanoClaw Agent Group；创建/归档/删除通过版本化 Management API 同步，Chat 不读写 NanoClaw 数据库。
- NanoClaw 保留 Channel 路由、身份绑定与（迁移完成前的）Markdown Memory 事实；Agent 自有资源以 Chat Home 独立根为目标唯一位置，不与 `groups/<folder>/` 双向同步。
- Memory 迁移必须只有一个可写事实位置；迁移顺序与回滚见[实施状态](./chat-long-agent-roadmap.md)§5。

## 7. 实施切片

每片独立交付、可验证、可回滚；顺序固定，后续片不得绕过前片的事实源。

| 切片 | 内容 | 验收要点 |
|---|---|---|
| S1 配置根 | `long-agents/<id>/agent.json` + `definition.json` 落地；`long-agents.json` 降级为索引；存量 Agent 一次性迁移（带备份） | 读写路径全部切换；无行为变化；回归现有配置 API 测试 |
| S2 生命周期 | create/update/archive/delete 服务与 API、审计、前端管理入口、公共管理 Skill + Tool（与页面同源） | 创建全量 provisioning 可回滚；归档可恢复；删除两阶段；Agent 可通过 Skill+Tool 完成同一组操作 |
| S3 独立 Daily Project | 新 Agent 默认 `daily-<longAgentId>`；存量 Agent 迁移归属，历史 Session 不搬运 | 两 Agent 同开 Daily 互不污染 cwd、Session、Memory |
| S4 自有资源与四级矩阵 | `long-agents/<id>/skills/` 等接入公共装配（additionalSkillPaths 通道）；前端"当前生效"只读区与跨域点选 | 检查与执行解析到同一份定义；跨域点选有授权记录 |
| S5a 日常主 Session 按日轮换 | Agent 独立 Daily Project 的主 Session 按本地日期轮换，历史原位保留 | 换日开新 Session，旧 Session 可读；非 Daily 绑定不受影响 |
| S5b Memory 迁移 | 本地 OKF Memory 服务（`long-agents/<id>/memory/`）、一次性从 NanoClaw 迁入、agent_memory_* Tool 与注入链切换到本地事实 | 只有一个可写事实位置；NanoClaw 侧成为只读遗留快照；迁移可回滚 |

## 8. 实现差距与进展（2026-09-09 第二轮）

已落地（S1～S5a、归一）：

- `long-agents/<id>/` 独立配置根：`definition.json` 承载能力定义，`long-agents.json` 降级为索引；存量内联 definition 带备份幂等迁移（`runtime/migrations/long-agent-definition-split/`）。
- 每个 Agent 独立 Daily Project（`daily-<longAgentId>`）与 Managed Workspace；存量共享 `daily` 的 Agent 在配置读取时一次性迁移归属，历史 Session 不搬运。
- 自有资源目录（`skills/` 等）接入执行与检查装配，Skill 归属新增 `agent` 分类；Skill 树与 Agent 配置页可见。
- 生命周期：create（全量 provisioning 可回滚）/archive/unarchive/delete（两阶段）服务 + HTTP API + 前端入口 + `long_agent_manage` 系统 Tool（特权，不默认授予）+ 公共管理 Skill `long-agent-management`。
- 日常主 Session 按本地日期轮换（绑定记录 `sessionDate`），非 home 绑定不受影响。
- **归一（2026-09-10）**：Agent 日常项目并入它自己的根（`long-agents/<id>/{workspace,sessions,...}`，项目 id 即 longAgentId，kind=agent）；共享 `daily` 改名为 `longagentshare`（kind=share）；旧共享空间里属于 Agent 的历史会话按 turn marker 迁回各自 Agent；遗留 catalog 记忆归并到 Personal；记忆 Target 层禁止系统容器（Agent home / 共享空间）产生 Project Memory。幂等迁移带备份与完成标记（`runtime/migrations/agent-home-normalization/`）。

剩余差距：

- Agent Memory 事实仍在 NanoClaw `groups/<folder>/`，经窄 API 访问；迁入 Chat Home 本地 OKF 服务是 S5b，合同见第 6 节。
- 资源生效仍靠 Pi `inherit` 自动发现；“配置为唯一生效来源”与跨域授权记录（第 4 节矩阵的完整落地）在后续切片。
- 换日后的近期历史/未完成事项注入（“换日不失忆”的上下文恢复）未实现；Agent 时区配置未实现（当前按服务器本地日期轮换）。

差距的逐项状态与迁移约束以[实施状态](./chat-long-agent-roadmap.md)为准；本文第 2–6 节是已确认决策，实施争议回到本文评审，不另起事实源。
