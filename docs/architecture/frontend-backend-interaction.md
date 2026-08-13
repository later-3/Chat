# Chat 前后端交互：当前实现

> 文档类型：当前实现（as-built）
>
> 当前传输：REST Query/Command + TanStack Query受控轮询
>
> 尚未实现：公开SSE Cursor Runtime Journal；目标合同见[技术合同](./technology-contract.md)。

## 1. 一句话说明

浏览器只向Chat API发送公开Query/Command。API校验请求后调用Application用例；Application在Product Store中原子提交产品事实、幂等Receipt和Outbox；API进程再异步启动或恢复Workflow。页面通过Query读取Run、Workflow View/Node Detail、Plan、Approval、Message、Context、Memory Import、Project Candidate和Project账本的权威投影，不从Workflow返回值或本地缓存猜测成功。

阅读和调试时按三个入口分工：

1. 本文回答“前后端传什么、对象在哪里改变、谁拥有最终状态”。
2. [本地调试与Trace](../debug/local-debug.md)回答“在哪个文件、哪个函数下断点、观察什么变量”。
3. [Workflow运行设计](./runtime-workflows.md)回答“进入耐久Workflow后有哪些节点、怎样暂停和恢复”。

## 2. 当前拓扑

```mermaid
flowchart LR
    WEB[React PWA] -->|REST Query / Command| API[Hono Public Router]
    API --> APP[Application Use Cases]
    APP --> STORE[JSON Product Store v5]
    APP --> OUTBOX[Transactional Outbox]
    OUTBOX --> DISPATCHER[API Outbox Dispatcher]
    DISPATCHER -->|私有HTTP + Runtime凭据| WFR[Workflow Runtime]
    WFR --> PI[pi Planner / Executor / Project Understanding]
    WFR --> MEM[memmy / MemoryCore]
    API --> PRJ[Project Resource Registry]
    WFR -->|私有Application Command| API
    WEB -->|1.5秒活动轮询| API
```

当前没有浏览器到Workflow、pi、百炼或Memory服务的直连，也没有公开SSE端点。Vite开发/预览服务只把 `/api` 代理到固定API端口。

## 3. 状态所有权

| 状态 | 权威所有者 | 浏览器怎样使用 |
|---|---|---|
| Session、Message、Run、Plan、Approval、Decision、Memory与Project事实 | Product Store | 通过Query读取，通过Command请求改变 |
| Workflow控制流、Hook等待和Checkpoint | Vercel Workflow Store | 不可见；只看到产品状态投影 |
| Workflow Run ID、Hook Token、Runtime Binding | Workflow Runtime私有存储 | 不进入响应、URL、localStorage或前端Bundle |
| pi会话、Provider请求和模型原始结果 | pi/Provider运行边界 | 只投影经校验的Plan、候选、使用量证据或稳定错误 |
| 草稿、主题、面板状态 | 浏览器 | 可以丢弃，不是产品事实 |
| 待重试Command ID、Session/活动Run定位 | 浏览器localStorage | 用于网络未知恢复；服务端幂等仍是最终保证 |

### 3.1 真实入口三栏工作台

`RealWorkspace`当前把同一Product Session投影为三个独立开合区域：左侧会话/项目导航、中间持续对话、右侧多标签工作区。右侧已有`工作配置 / 运行 / 项目 / 笔记 / 规则 / 设计器`六个标签；以后文件、浏览器或Artifact也应作为同一工作区中的新表面打开，不能借此创建第二个Session或新的完成事实。

原输入框中的工作流大卡片已经迁到右侧“工作配置”。中间输入区只保留当前消息用途摘要、正文和发送动作；任务、项目模式、Workflow Definition revision、节点Override、Memory选择和正文选区仍由同一份React状态组合，发送时继续形成原有严格`SubmitMessagePayload`，没有增加浏览器到Workflow的直连。

桌面三栏支持分隔条拖拽和方向键调整；导航、中间对话、右侧工作区可独立收起，收起后对应DOM退出Tab顺序。开合与宽度只写入`chat:workbench-layout:v1`浏览器偏好。760px以下不压缩为三窄栏，而是导航抽屉加“对话 / 工作”单表面切换；草稿、当前标签与公开对象定位保持不变。

三栏视觉采用“K7 AnythingLLM的对话中心 + K2 Things的明亮配色”组合：中间对话保持大面积安静留白与浮起输入框，左侧使用暖灰导航，右侧工作区使用浅层卡片与蓝色选择态。工作流节点、资源与审核策略默认收进“高级设置”，但仍保持挂载并参与发送前完整性校验；视觉折叠不能绕过服务端限定、版本Hash或安全策略。

栏位恢复与收起动作必须参与各自标题栏的正常Flex排版，不能用绝对定位覆盖会话标题或相邻动作；该约束在恢复浏览器持久化窄栏时同样成立。明暗主题只通过语义Token切换，半透明表面、Hover、阴影和浮起卡片不得写死浅色值，避免深色模式混入白色工作区。

## 4. 浏览器公开API

实际路由入口是 `apps/api/src/product-routes.ts`，浏览器客户端是 `apps/web/src/api/client.ts`，公开Schema统一从 `@chat/contracts/public` 导出。

### 4.1 健康与准备

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/healthz` | API进程存活；前端连接状态使用 |
| GET | `/api/readyz` | Product Store可读及百炼配置是否就绪的安全投影 |

### 4.2 Session、Message与Run

| 方法 | 路径 | 类型 | 当前结果 |
|---|---|---|---|
| POST | `/api/sessions` | Command | 幂等创建Session，返回201 |
| GET | `/api/sessions/:sessionId` | Query | 读取Session |
| POST | `/api/sessions/:sessionId/messages` | Command | 原子提交User Message、Product Run、Receipt和Workflow Start Outbox，返回201 |
| GET | `/api/sessions/:sessionId/messages` | Query | Cursor分页读取正式消息 |
| GET | `/api/runs/:productRunId` | Query | 读取Run的`status + phase + revision`及安全错误 |
| GET | `/api/runs/:productRunId/context` | Query | 读取本轮Memory选择、查询和ContextPackage安全摘要 |
| GET | `/api/runs/:productRunId/plans` | Query | 读取全部Plan Revision安全投影 |
| GET | `/api/runs/:productRunId/approvals/current` | Query | 读取当前仍可操作的Approval |
| POST | `/api/runs/:productRunId/decisions` | Command | 提交`request_revision/approve/reject`，返回201 |
| GET | `/api/runs/:productRunId/workflow-view` | Query | ETag支持的稳定图结构与Node Run摘要；不含正文、坐标或Runtime身份 |
| GET | `/api/runs/:productRunId/workflow-nodes/:workflowNodeRunId?include=...` | Query | 按需读取安全Manifest、状态时间线和Evidence引用；只允许公开include枚举 |

### 4.3 Memory

| 方法 | 路径 | 类型 | 当前结果 |
|---|---|---|---|
| GET | `/api/memory-backends` | Query | 返回服务端注册的安全能力投影，不返回endpoint/Token/租户映射 |
| POST | `/api/memory-imports` | Command | 创建Import Intent、初始Result、Receipt和Start Outbox，返回201 |
| GET | `/api/memory-imports/:memoryImportIntentId` | Query | 读取单次导入状态 |
| GET | `/api/sessions/:sessionId/memory-imports` | Query | Cursor分页读取Session导入记录 |
| POST | `/api/memory-imports/:memoryImportIntentId/reconcile` | Command | CAS请求只读对账，返回202 |

### 4.4 Project

| 方法 | 路径 | 类型 | 当前结果 |
|---|---|---|---|
| GET | `/api/project-roots` | Query | 返回服务端允许根及安全Adapter能力，不返回绝对路径 |
| POST | `/api/project-intakes` | Command | 原子提交Message、queued Candidate、Receipt与Start Outbox，返回202 |
| GET | `/api/sessions/:sessionId/project-candidates/current` | Query | 刷新后恢复该Session唯一未决Candidate |
| POST | `/api/project-candidates/:id/decisions` | Command | 修订/确认/拒绝建项Candidate，确认时原子创建完整Project账本 |
| POST | `/api/project-management-candidates` | Command | 从显式管理模式的正式Message确定性编译待办/决定/贡献Candidate |
| POST | `/api/project-management-candidates/:id/decisions` | Command | CAS修订/确认/拒绝；确认后只提交一种对应Project事实 |
| POST | `/api/project-advancements` | Command | 原子提交推进Message、版本绑定queued Candidate、Receipt与Start Outbox，返回202 |
| POST | `/api/project-advancements/:id/decisions` | Command | CAS修订/确认/拒绝Stage/Milestone/Update候选；确认时一次提交账本事实与Resume Outbox |
| GET | `/api/projects`、`/api/projects/:id`、`/api/projects/:id/timeline` | Query | Portfolio、Workspace与事实时间线 |
| POST | `/api/projects/:id/actions`及Action子命令 | Command | 新增、分派和状态转换，均校验对象revision |
| POST | `/api/projects/:id/resources/:resourceId/observations` | Command | 从允许根刷新只读Observation与Evidence |
| POST | `/api/project-stages/:id/transitions`、`/api/project-milestones/:id/transitions` | Command | 绑定Decision/Evidence的显式状态转换；写入严格State Transition历史 |
| POST | `/api/projects/:id/transitions` | Command | 显式暂停、恢复、完成或归档Project；完成必须绑定Evidence，完成与归档语义分离 |

### 4.5 Workflow Definition设计器

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/api/workflow/catalog`、`/api/workflow/blueprints` | 返回可公开节点表单、是否可默认跳过、固定outcome与BoundedLoop规则；不返回Executor实现 |
| GET | `/api/workflow/definitions`、`/api/workflow/definitions/:id` | 读取已发布摘要或可编辑`semanticRoot + slots + base revision/hash` |
| POST | `/api/workflow/definitions/copies` | 从精确已发布revision/hash创建用户副本 |
| POST | `/api/workflow/definitions/validate` | 无写入地执行服务端Structure、Blueprint、Catalog与Hash全校验 |
| POST | `/api/workflow/definitions/:id/drafts` | 以Command ID、expected revision和base hash保存完整语义草稿 |
| POST | `/api/workflow/definitions/:id/publish` | 发布精确草稿revision/hash；运行中的Run继续使用已冻结RunSpec |

设计器没有自由edge或表达式。浏览器工作副本只记录公开strict Operation：节点插入/移动/跳过/配置，以及`wrap_in_choice`、`move_into_branch`、`unwrap_choice`、`wrap_in_bounded_loop`、`update_loop_policy`、`unwrap_loop`。Choice分支只能来自Catalog outcome，Loop的continue/exit和最大次数只能来自Blueprint；拖拽、键盘按钮和手机控件都生成同一种Operation，坐标不进入草稿或Definition Hash。

浏览器的纯函数变换只用于即时预览和undo/redo。Application用同一Operation合同重新解释后，必须再执行完整Domain/Blueprint/Catalog Validator；只有服务端validate/save/publish响应能声明合法或已提交。localStorage按`workflowDefinitionId + baseDefinitionSha256`隔离，CAS冲突只从最新base顺序重放Operation，首个失效操作即停止，不做JSON猜测合并。

## 5. Command合同

所有公开写请求使用统一Envelope：

```json
{
  "commandId": "cmd_...",
  "expectedRevision": 7,
  "payload": {}
}
```

规则：

1. `commandId`是一次用户意图的稳定幂等身份；同一ID同一请求返回原结果。
2. 同一`commandId`配不同规范化请求Hash返回409，不能覆盖原命令。
3. 修改已有对象的Command携带`expectedRevision`；过期页面使用旧revision时返回冲突。
4. Decision还必须绑定Plan ID、Plan revision和Plan SHA-256。
5. 浏览器不能指定Provider、模型、endpoint、Token、Workflow ID、Hook Token或pi Session ID。
6. POST已经发送但响应丢失时，浏览器保留同一个`commandId`并只允许“使用同一命令重试”。
7. Project Candidate同时绑定自身revision/Hash；管理Candidate绑定Project revision；推进Candidate同时绑定Project、Stage、Method Snapshot的revision/Hash。任一事实变化后旧候选不能确认，但允许显式拒绝以解除Session阻塞。

### 5.1 主链关键数据结构

| 数据结构 | 定义位置 | 谁创建 | 作用与边界 |
|---|---|---|---|
| `PendingSend` | `apps/web/src/real/real-storage.ts` | Web | 保存尚未确认的`commandId + SubmitMessagePayload`；只用于网络未知恢复，不是正式Message |
| `CommandEnvelope` | `packages/contracts/src/command.ts` | Web / Runtime客户端 | 把幂等身份、可选CAS revision和业务payload分开；服务端按规范化请求Hash防止同ID换正文 |
| `SubmitMessagePayload` | `packages/contracts/src/product-api.ts` | Web | 只含用户文本和可选Memory选择；不能携带模型、Provider或Runtime身份 |
| `MessageDto + RunDto` | `packages/contracts/src/product-api.ts` | API Query/Command投影 | Message是正式会话内容，Run是围绕该消息的一次工作生命周期；201返回它们不代表Workflow完成 |
| `workflow_start` Outbox | `packages/contracts/src/product.ts` | Application事务 | 记录“这个Product Run必须启动Workflow”的耐久意图；与Message/Run同事务提交 |
| `WorkflowStartRequest` | `packages/contracts/src/internal-runtime.ts` | API Dispatcher | 只传`productRunId + attemptId + outboxId + definitionVersion`；不传用户正文和SDK Run ID |
| `PlanningExecutionWorkflowInput` | `packages/workflows/src/workflow-input.ts` | Workflow Runtime | 耐久Workflow的最小启动输入；完整Message、Context和Plan通过私有Application API按引用读取 |
| `PlanDto + ApprovalDto` | `packages/contracts/src/product-api.ts` | Application投影 | Plan保存候选版本和Hash；Approval把用户可决定的等待点绑定到精确Plan版本 |
| `PendingDecision` | `apps/web/src/real/real-storage.ts` | Web | 保存`commandId + expectedRunRevision + SubmitDecisionPayload`；用于同一决定的网络未知恢复 |
| `DecisionDto` | `packages/contracts/src/product-api.ts` | Application事务 | 已通过权限、CAS、Plan revision/Hash校验的正式用户决定 |
| `workflow_resume` Outbox | `packages/contracts/src/product.ts` | Application事务 | 与Decision同事务提交，只携带产品引用；Hook Token仍留在Workflow Runtime |
| `ExecutionContract` | `packages/contracts/src/product.ts` | Application | 从已批准Plan编译出的不可变执行输入；Executor无权自行扩展目标或能力 |
| `ExecutionCandidate / Validation / final Message` | Product Store合同与Application用例 | Workflow Step + Application | 模型输出先是候选，再确定性验证，最后Product Commit才形成正式Assistant Message和Run终态 |
| `WorkflowRunViewDto` | `packages/contracts/src/workflow-api.ts` | Application Query投影 | 一次Run冻结的View结构和Node Run摘要；不含React Flow坐标、Trace正文、Workflow/Hook/pi身份 |
| `WorkflowNodeDetailDto` | `packages/contracts/src/workflow-api.ts` | Application Query投影 | 按Tab惰性返回Manifest、Transition与Evidence产品引用；错误只含公开code/summary |

这张表描述的是对象角色，字段级真相仍以对应Zod Schema为准。调试时不要把DTO、持久化实体和Runtime SDK对象混成一个“Run”。

## 6. Query合同与当前轮询

前端 `useRealChain` 负责会话资源Query组合，`useWorkflowRunView/useWorkflowNodeDetail`独立负责运行图Query：

1. 首次打开没有Session定位时，以稳定Bootstrap Command幂等创建Session。
2. 活动Run期间每1.5秒轮询Run、Message、Plan、Approval和Context。
3. `succeeded/failed/cancelled/outcome_unknown`到达后停止活动轮询，并最后失效一次正式资源Query。
4. 导入处于`queued/dispatching`时轮询；MemoryCore的合法`accepted`只有限补查，不把它伪装成L1已物化。
5. 页面不可见时不在后台持续轮询。
6. Command成功后使相关Query失效，再从服务端读取权威状态。
7. Workflow View与Node Detail保存同URL的内存ETag；304只复用已经通过公开Zod合同的快照。
8. 切换Run或节点时TanStack Query把AbortSignal传入`fetch`，旧响应不能覆盖新选择；掉线时保留最后成功快照并标记陈旧。

这是一条已经实现并通过真实浏览器验证的恢复路径。未来SSE只负责活动事件和资源失效通知，不改变Query/Command合同，也不能成为产品事实源。

### 6.1 真实Run Viewer（as-built）

`RealWorkspace`把当前Run交给`WorkflowRunPanel`，Viewer只消费上述两个公开DTO：

```text
WorkflowRunViewDto
→ layoutWorkflowView（纯函数，只产生临时坐标）
→ 桌面只读React Flow / 手机linearizedWorkflowView
→ 选择Node Run
→ useWorkflowNodeDetail按当前Tab请求summary/manifests/timeline/evidence
→ Human Review概览复用唯一PlanReviewContent
→ Decision仍走useRealChain的原Command、CAS、Plan revision/Hash和pending command恢复
```

边界和失败语义：

1. `@xyflow/react`只出现在`apps/web/src/components/workflow/WorkflowCanvas.tsx`及其自定义节点适配层；公开DTO、Domain、Store和测试Fixture不导入React Flow类型。
2. 画布显式关闭拖动、连线、元素选择、重连与Delete快捷键，只保留缩放、平移、显式Reset和节点内部可访问按钮。
3. Definition/View不保存坐标；`viewHash + Node Run身份/层级/iteration`组成结构签名。只更新status、duration或summary不会自动`fitView`、改变selection或重置Inspector Tab。
4. 桌面按确定性拓扑从左到右布局；`outcomeCode`稳定分lane，`loop_back`不参与DAG排序，Composite子运行按`parentNodeRunId`展开/收起。手机使用同一拓扑的顺序列表，不依赖Canvas完成审核。
5. `historyCompleteness=legacy_limited`明确显示“旧运行·细节有限”，不会用新Node Run终态规则误判历史；`complete`投影才执行Run终态与节点状态一致性门。
6. Inspector只显示公开摘要、对象ID、revision和Hash；不执行HTML/脚本，不`JSON.stringify`未知对象，不展示Stack、Provider Payload、Credential或隐藏推理。
7. review节点的计划阅读和决定表单来自原`PlanReviewContent`，页面任何时刻只存在一个可提交实例；选择其他节点时未提交修改草稿保留在当前Run组件状态，切Run清空。
8. URL只可保存`workflowRun/workflowNode/workflowTab`公开定位，不保存正文、Token或Runtime身份。

#### React Flow依赖证据与退出路径

| 项目 | 已验证事实 |
|---|---|
| 固定版本 | `@xyflow/react 12.11.2`，lock integrity `sha512-eLAl...ld12cA==` |
| 许可证/兼容 | MIT；peer要求React/React DOM与类型`>=17`，当前React 19.2.8与TypeScript 5.9通过typecheck/build |
| 能力证据 | 官方[ReactFlow组件合同](https://reactflow.dev/api-reference/react-flow)提供只读交互开关；[Accessibility](https://reactflow.dev/learn/advanced-use/accessibility)说明键盘/ARIA边界；[Custom Nodes](https://reactflow.dev/learn/customization/custom-nodes)支持自定义节点；[Layouting](https://reactflow.dev/learn/layouting/layouting)明确布局由应用选择 |
| 构建测量 | 引入前主入口`444.70 kB / 124.65 kB gzip`；引入后主入口`469.35 kB / 131.88 kB gzip`。React Flow懒加载Chunk为`180.36 kB / 58.44 kB gzip`，其CSS为`15.41 kB / 2.56 kB gzip`；手机线性模式不渲染该Chunk |
| CSS/PWA | React Flow基础CSS与变量覆盖只在`WorkflowCanvas`懒加载Chunk；生产PWA构建和公开Bundle秘密标记扫描通过 |
| 退出方式 | 替换`WorkflowCanvas`渲染器即可；`layoutWorkflowView`、公开API、Product Store、Definition、Inspector、手机顺序列表与审核Command均不变 |

首期没有引入ELK、dagre或布局Worker。当前纯布局的六节点、choice、bounded loop、Composite、空/单节点、错误结构与多组DAG不重叠测试已经覆盖批准范围；只有真实代表图证明不足时才重新审查布局依赖。

## 7. 规划—确认—执行交互

### 7.0 函数级主链导航

以下顺序与[本地调试断点表](../debug/local-debug.md)保持一致。函数名比行号稳定；新增注释或格式化后不需要重新猜断点。

| 顺序 | 进程 | 文件与函数/入口 | 进入的数据 | 离开时应该成立的事实 |
|---:|---|---|---|---|
| 1 | Browser | `RealWorkspace.tsx`：`RealChatPane.send` | 输入框文本、Memory选择 | 只调用`chain.sendMessage`，UI没有制造成功Message |
| 2 | Browser | `use-real-chain.ts`：`sendMessage`、`sendMutation` | `PendingSend` | 先写localStorage，再用同一个`commandId`发起请求；成功后保存`activeRunId` |
| 3 | Browser | `api/client.ts`：`apiSubmitMessage`、`post` | `CommandEnvelope<SubmitMessagePayload>` | 请求和201响应都通过公开Zod合同 |
| 4 | API | `product-routes.ts`：`POST /sessions/:sessionId/messages` | URL Session、Envelope、Payload | 只完成协议校验并调用Application，不直接启动Workflow |
| 5 | API | `session-message-use-cases.ts`：`submitUserMessage` | Principal、Session、Command、Payload | 原子提交Message、Run、ContextRequest、Attempt、Receipt和Start Outbox |
| 6 | API | `outbox-dispatcher.ts`：`tick`、`dispatchStart` | 已提交`workflow_start` Outbox | 向Runtime派发或进入`outcome_unknown`；不把HTTP成功当产品完成 |
| 7 | Workflow | `runtime-server.ts`：`POST /internal/workflow/v1/start` | `WorkflowStartRequest` | Runtime先认领Binding，再启动唯一SDK Workflow Run |
| 8 | Workflow | `planning-execution-workflow.ts`：`planningExecutionWorkflow` | 最小Workflow Input | 准备Context、规划、发布Plan并等待Hook；所有产品读写走私有API |
| 9 | Workflow → API | `workflow-planning-steps.ts`：`publishPlanReviewStep` → `api-client.ts`：`publishPlanReview` → `internal-runtime-router.ts` | Plan候选、Run revision、Manifest Hash | Application提交Plan Revision、Approval并把Run推进到`waiting_human` |
| 10 | Browser | `use-real-chain.ts`的Run/Plan/Approval Query + `use-workflow-run-view.ts` + `WorkflowRunPanel.tsx` | `RunDto + WorkflowRunViewDto + WorkflowNodeDetailDto + Plan/Approval` | 页面从真实Node Run投影显示图与详情；review节点复用唯一Plan表单，不按phase猜节点 |
| 11 | Browser → API | `PlanPanel.DecisionBox` → `beginDecision/decisionMutation` → `apiSubmitDecision` → Decision Route | `PendingDecision`与Decision Envelope | Application原子提交Decision、状态变化和Resume Outbox |
| 12 | API → Workflow | `outbox-dispatcher.ts`：`dispatchResume` → `runtime-server.ts`：`POST /internal/workflow/v1/resume` | 产品Run、Approval、Decision、Outbox引用 | Runtime查私有Hook Binding并恢复同一个Workflow |
| 13 | Workflow | `loadCommittedDecisionStep`、`compileExecutionContractStep`、`runPiExecutorStep` | 已提交Decision与已批准Plan引用 | 形成不可变执行合同和结构化执行候选，尚未产品成功 |
| 14 | Workflow → API | `persistExecutionCandidateStep`、`validateExecutionStep`、`commitExecutionResultStep` | 候选、Hash、Validation引用 | Application原子提交正式Assistant Message并把Run置为`succeeded` |
| 15 | Browser | `useRealChain`终态Query失效与重新读取 | 服务端最终Message/Run/Plan | 页面显示正式结果并停止活动轮询 |

### 7.0.1 调试时应持续跟踪的身份

| 身份 | 作用域 | 能否给浏览器 | 常见误解 |
|---|---|---:|---|
| `commandId` | 一次可重试用户/内部命令 | 是 | 不是Message ID；相同意图重试必须复用 |
| `sessionId` | 用户会话 | 是 | 不是浏览器Tab，也不是Workflow Run |
| `messageId` | 一条正式消息 | 是 | 输入框草稿没有Message ID |
| `productRunId` | 用户可见的一次后台工作 | 是 | 不是Vercel Workflow Run ID |
| `attemptId` | Product Run的一次规划/执行尝试证据 | 公开DTO通常不需要 | 不是Workflow Checkpoint |
| `outboxId` | 一次跨Runtime派发意图 | 否 | 不是业务Run；用于幂等和对账 |
| `planId + planRevision + planSha256` | 用户实际审核的精确计划版本 | 是 | 只传planId不能防止批准到错误版本 |
| `approvalRequestId` | 当前人工等待点的产品身份 | 是 | 不是Hook Token |
| `decisionId` | 已提交用户决定 | 是 | Hook Payload只能引用它，不能代替它 |
| SDK Workflow Run ID / Hook Token | Workflow Runtime私有映射 | 否 | 不能作为产品授权、URL或前端状态 |

### 7.1 发送

```text
用户发送文本并选择可选Memory上下文
→ Web保存pending commandId
→ POST Message Command
→ Application原子提交Message + Run + Receipt + Workflow Start Outbox
→ API返回正式Message和Run
→ Web记录activeRunId并失效相关Query
→ Outbox Dispatcher启动PlanningExecutionWorkflow
```

浏览器收到201不代表Workflow已完成，只代表产品命令已经被接纳并耐久记录。

### 7.2 规划与人工决定

```text
Workflow生成并提交Plan Revision + Approval
→ Run进入waiting_human / plan_review
→ Web轮询Query并显示Plan与当前Approval
→ 用户修改、批准或拒绝
→ POST Decision Command
→ Application校验Principal、Run revision、Plan revision/Hash和幂等
→ 原子提交Decision + Resume Outbox
→ Dispatcher使用私有Runtime接口恢复同一Hook
```

- `request_revision`：同一Workflow回到规划循环，生成新Plan Revision。
- `approve`：编译不可变Execution Contract并执行。
- `reject`：提交Run取消终态，不进入执行。

前端从来不持有或调用Hook Token。

### 7.3 正式结果

```text
pi Executor生成候选
→ Workflow持久化候选
→ 确定性验证
→ Application Product Commit
→ 正式Assistant Message + Run succeeded
→ Web下一轮Query读取正式Message
```

Workflow函数正常返回、pi返回成功或前端轮询超时都不能独立产生成功消息。

## 8. Memory导入交互

```text
用户从正式Message选择正文范围和后端
→ POST Memory Import Command
→ Product Store提交Intent + Result(queued) + Receipt + Outbox
→ MemoryImportWorkflow建立dispatching栅栏
→ Adapter执行唯一一次外部写入
→ 提交accepted/materialized/failed/outcome_unknown
→ 必要时用同一身份执行只读reconcile
→ Web Query恢复状态
```

memmy可通过读取与搜索收敛为`materialized`；Tencent MemoryCore的L0接收可以合法停在`accepted`，不能因为L1暂未出现而重复写入。

## 9. Project建项与管理交互

```text
用户显式切换“建立项目”并选择安全rootId
→ POST Project Intake Command
→ Message + queued Candidate + Receipt + Start Outbox
→ ProjectIntakeWorkflow调用Project Understanding并观察真实资源
→ under_review Candidate
→ Web展示可编辑目标、方法、初始Work/Action与资源证据
→ 用户修订/确认/拒绝
→ 确认时原子创建Project完整初始账本 + Resume Outbox
→ Portfolio、Workspace和Timeline从Query恢复
```

普通任务消息不会被隐藏分类器改道。Provider/模型只由服务端Model Profile选择；公开Candidate没有Provider或模型字段。页面删除Candidate定位或刷新时，按Session Query恢复唯一未决候选。

项目建成后，显式“管理项目”模式把用户消息编译为待办、决定或贡献Candidate；必须再次确认才能写入账本。待办分派/状态转换与资源刷新是可见的显式Command：前两者使用对象CAS，资源刷新只观察允许根并生成Observation/Evidence。

### 9.1 Project推进交互

```text
用户显式选择Project并切换“推进项目”
→ POST /api/project-advancements
→ Message + queued Candidate + Receipt + Start Outbox原子提交
→ ProjectAdvancementWorkflow调用模型无关Understanding Port
→ Application结合当前Project/Stage/Method编译strict Candidate
→ 页面展示并允许直接修改Stage、Milestone和负责人Update
→ POST /api/project-advancements/:id/decisions
→ 确认时Decision、Stage revision、Milestone、Project Update和Resume Outbox一次提交
→ Workflow恢复；页面重新Query Project Workspace与Timeline
```

模型输出只是临时Understanding。公开Candidate不含Provider/模型；Project Update必须由当前Project的人类所有者Participant署名并由同一Principal确认。Timeline从Decision、State Transition和Project Update等产品事实组装，Trace只记录ID、revision/Hash、边界、耗时和结果，不复制Stage/Update正文。

## 10. 错误与恢复

HTTP错误统一使用Problem Detail安全投影：

```text
type, title, status, code, requestId, retryable, recoveryAction
```

前端只根据稳定`code`和`recoveryAction`处理，不解析错误字符串。主要恢复语义：

| 情况 | 前端/服务端行为 |
|---|---|
| DTO非法、未知字段或浏览器越权参数 | 400，失败关闭 |
| revision/Hash过期 | 409，重新Query后由用户再次决定 |
| 相同commandId不同请求 | 409，不执行第二次 |
| POST网络断开或2xx响应损坏 | 显示结果未知，保留同一commandId |
| 页面刷新 | 用localStorage中的公开定位ID重新Query；不恢复Runtime私有身份 |
| API重启 | 从JSON Product Store和Outbox恢复；浏览器继续Query |
| Workflow启动/恢复响应未知 | Dispatcher对账Runtime Binding，不盲目启动/恢复第二次 |

## 11. 私有Runtime接口

Workflow Step访问 `/internal/runtime/v1/*`，API Dispatcher访问Workflow Runtime的 `/internal/workflow/v1/*`。两组接口都只绑定本地服务、要求服务端Runtime凭据，并与公开Router、公开DTO和前端Bundle物理分离。

私有接口仍然经过Zod、Application用例、CAS、幂等和Trace；“私有”不等于可以绕过产品事务。

## 12. 当前实现与目标架构的差异

| 能力 | 当前 | 目标 |
|---|---|---|
| 产品读取/写入 | REST Query/Command | 保持不变 |
| 活动状态更新 | 1.5秒受控Query轮询 | Chat自有SSE + Cursor；Query仍负责Hydrate |
| Agent事件 | 只形成后端Trace和产品投影 | AG-UI兼容事件进入唯一Chat事件流 |
| Product Store | 单实例、单写者、版本化JSON v4 | 支持生产事务、多实例、备份恢复的持久Store |
| 身份 | 固定调试Principal | 正式认证、授权与租户隔离 |
| 后端部署 | 本地纵向链已验证 | 生产API/Workflow/Memory部署拓扑尚未冻结 |

不得根据目标架构中的SSE、Runtime Journal或生产数据库描述，声称当前代码已经提供这些能力。

## 13. 修改交互时必须同步验证

1. `packages/contracts`：公开Schema严格拒绝未知字段和内部身份。
2. `packages/application`：命令幂等、CAS、不变量和原子Outbox。
3. `apps/api`：路由状态码、Problem Detail、权限和秘密扫描。
4. `apps/web`：网络未知保留同一commandId、Query失效和刷新恢复。
5. 纵向场景：真实Workflow、指定真实模型、真实浏览器；Memory行为变化还要使用对应真实Memory服务。

主要测试入口见根 `package.json` 和 `docs/debug/local-debug.md`。
