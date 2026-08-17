# Chat 项目上下文

## 1. 产品定义

Chat 是以对话为入口的个人操作系统。用户与一个长期协作的Agent团队持续推进生活、工作、项目和兴趣；系统负责规划、人工决定、耐久执行、知识沉淀、证据、交付与治理。

Chat不是一个聊天页面，也不是某个Agent Runtime的外壳。外部开源项目提供成熟界面或能力，Chat只维护自己的产品对象、Workflow和必要Adapter。

## 2. 当前产品链

```text
DeepSeek Harness Web
  -> LifeOS Bridge（展示与命令适配）
  -> Chat Hono API（公开Query / Command）
  -> Application + Product Store（权威产品事实）
  -> Vercel Workflow（耐久流程与暂停恢复）
  -> pi-agent-core（Planner / Executor节点）
  -> Product Commit（正式结果）

Code Workbench（独立code-server）
  <- LifeOS Web Gateway（虚拟Host隔离、HTTP/WebSocket代理）
```

DSH保存的会话日志只用于原生界面与运行恢复，不替代Chat Product Session、Message、Run、Plan、Approval或Decision。浏览器和DSH Client插件都不能直接调用Workflow或pi。

## 3. 开源复用原则

Chat的核心不按行数定义，而按责任所有权定义。Product Store事实、Domain/Application规则、权限、事务、幂等、Decision、Workflow编排、Planner/Executor业务节点和Product Commit必须由Chat自己拥有。这些是产品最核心的代码，但不应为了显得“完整”而扩张成全能平台。

文件、编辑器、Terminal、Git/Diff、Browser、Memory、前端宿主和通用Agent loop等能力，默认复用质量高、持续维护、许可证可接受的完整产品或模块。能作为独立服务运行的能力，不拆成自研React组件；上游暂时不用的功能可以不挂载，不因此拆解上游源码。

Adapter只负责身份/namespace映射、外部Credential与资源Scope、Principal传递、生命周期、协议、严格校验、失败归一和产品投影；产品对象访问权与高影响动作授权仍由Application决定。“最小适配”指最小上游修改面和最窄稳定边界，不是省略适用的安全、恢复、对账或测试；外部写副作用才要求幂等、`outcome_unknown`与对账，持久格式变化才要求迁移。上游必须固定来源与工件，保留升级合同和退出路径，默认不在本仓库复制或Fork上游源码。

### 当前能力所有权

| 能力 | 复用来源 | Chat只开发什么 |
|---|---|---|
| 会话、消息、Composer、布局与插件宿主 | 固定DeepSeek Harness Web | LifeOS Bridge中的Session映射、Query/Command适配、HITL投影和受控Surface |
| Files、Editor、Terminal、Git/Diff、扩展宿主 | 固定code-server/Code OSS | 固定工件、Workspace范围、生命周期、Gateway隔离和DSH入口 |
| 耐久步骤、Checkpoint、重放和Worker恢复 | Vercel Workflow | 不可变RunSpec、Chat Workflow定义/节点、产品级暂停/恢复命令、Binding、对账与终态政策 |
| Agent loop、模型与通用Tool运行 | `pi-agent-core`/`pi-ai` | Planner/Executor输入、Prompt、能力白名单、Candidate校验和产品结果提交 |
| Memory引擎 | memmy、Tencent MemoryCore | Port/Adapter、选择与采用、来源、幂等/对账和产品事实 |
| Browser（下一纵向） | 待选独立Provider | Browser Session与Product Run的身份/权限映射、人机共用表面和审计 |

不是所有能力都要成为DSH插件。完整应用可作为Hosted App，本地能力可作为Sidecar，远程能力可通过REST/WebSocket/SSE/MCP Provider接入；DSH只承载需要的前端入口和投影。

## 4. 主要产品对象

Product Session、Interaction、Message、Product Run、Run Attempt、Project、Stage、Milestone、Work、Action、Resource、Observation、Evidence、Context Package、Workflow Definition、Plan、Approval、Decision、Tool Execution、Artifact、Memory与Trace。

这些对象不等同于DSH Session、Workflow Run、Checkpoint、pi Session或Provider请求。

## 5. 已冻结边界

- DeepSeek Harness Web是唯一前端；本仓库不维护第二套Chat UI。
- code-server是可替换Hosted App；它拥有编辑器/终端运行状态，不拥有Chat产品事实。
- Hono只终止协议、建立认证上下文和校验DTO。
- Application拥有用例、权限、事务、幂等和状态转换。
- Product Store拥有产品事实。
- Vercel Workflow拥有耐久控制流与Checkpoint。
- pi拥有Agent loop、模型和Tool运行，不拥有产品完成事实。
- 高影响动作必须先形成可读、可修订、版本绑定的Decision。
- 失败不能产生假成功；未知副作用必须查询、对账或人工处置。

当前实现与下一步分别见[PROJECT_STATE.md](./PROJECT_STATE.md)和[PROJECT_PLAN.md](./PROJECT_PLAN.md)。
