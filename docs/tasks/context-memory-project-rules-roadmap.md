# C1 任务书：Memory、Project 与用户规则纵向建设

> 状态：待用户审核，未授权实现  
> 架构依据：[长期上下文架构](../architecture/context-memory-project-rules.md)  
> 基线：`main` @ `7daaf5a`

## 1. 总目标

在不破坏现有 B2 真实闭环的前提下，逐步交付以下完整用户结果：

1. 用户可在发送消息前选择真实 Memory 后端；规划 Workflow 按需查询并显示采用来源。
2. 用户可把明确选择的会话内容导入真实 Memory 服务，并看到 accepted/materialized/failed/outcome_unknown 的真实状态。
3. 用户可建立项目、维护阶段/Work/文档清单，并让本轮规划使用精确的项目上下文。
4. 用户可管理带标签和场景范围的个人规则，主动选择或让系统合理选择，并看到规划实际采用的版本。
5. 页面刷新、API/Workflow 重启和历史回放后，产品事实、上下文来源与运行终态一致。

这不是 Memory Demo、BMAD 文档复制或 Prompt 偏好拼接。任何能力必须从 React 入口贯穿公开 API、Application、Product Store、Workflow/Adapter、Trace 和查询恢复，才算完成。

## 2. 全局约束

1. 每个实现任务使用独立 worktree、`codex/` 分支和 Draft PR；只从前一任务已合并的 `main` 创建，合并后删除临时分支和 worktree。
2. 一个任务只增加一个主要用户能力，但必须是纵向结果；不得按 DTO、表、Port 等技术层拆成等待型 PR。
3. TypeScript strict；所有网络、配置和外部响应运行时校验；Domain 不依赖 React/Hono/Workflow/pi/Memory SDK。
4. 代码中文注释解释状态所有权、幂等、失败语义和“为什么”，不为显而易见的语句逐行注释。
5. Router、Workflow Step 和 React 组件不直接改 Product Store；Application 用例拥有事务与不变量。
6. 不建立万能 Context Service、万能 Repository、任意 attributes 或 `Record<string, unknown>` 扩展口袋。
7. 真实 Memory 与真实百炼 E2E 不得 Skip、不得替换为假服务/假模型；普通单元测试使用确定性 fake，控制费用和时长。
8. 凭据复用已存在 pi 配置读取器或环境变量，禁止输出、记录、提交；不得再把“请用户提供已配置 Key”作为默认阻塞。
9. 固定调试端口，启动前安全释放本项目登记进程；未知占用只报告不杀。服务器不编译。

## 3. 任务依赖

```text
M1 Memory 查询纵向链
  └─ M2 Memory 导入纵向链
       └─ M3 Tencent 第二后端与多后端证明

P1 Project 基础与 BMAD 模板
  └─ P2 Project Context 与推进节点

R1 规则管理与标签
  └─ R2 规则选择与规划注入

M3 + P2 + R2
  └─ X1 组合真实 E2E 与收口
```

P1/R1 可以在 M2 合并后与 Memory 后续设计并行准备，但同一 Product Store Schema 变更仍按合并顺序串行 rebase，避免多份迁移冲突。

## 4. M1：memmy 真实查询进入规划

### 4.1 用户结果

用户在对话发送区打开“上下文”，选择 memmy 和可选标签后发送消息。同一个 `PlanningExecutionWorkflow` 先查询真实 memmy，再用精确命中规划；规划面板展示“使用 memmy N 条”及安全来源摘要。刷新后结果不丢。

### 4.2 实现范围

1. 新增 `MemoryBackendProfile`、`MemoryQuery`、`MemoryResultSnapshot`、`MemoryAdoption`、`ContextPackage` 与 v1→v2 Product Store 迁移。
2. 新增窄 `MemoryBackendPort`、服务端 Registry、memmy HTTP Adapter；公开 API 只能提交 backendId、标签、层、预算和 required/optional。
3. `submitMessage` 原子保存 Context Request；Workflow 在 `compilePlanningInputStep` 前增加 query/persist 节点。
4. Planner 输入模板使用 ContextPackage 的精确快照，并把 package Hash 纳入 Input Manifest。
5. 前端增加响应式 Context 选择器和本轮来源摘要；保持现有对话、PlanPanel 与手机布局风格。
6. Trace 增加严格 query/context 事件，不保存 Memory 正文。

### 4.3 不做

不导入 Memory，不接腾讯后端，不做 Project/Rules，不做跨后端聚合排序。

### 4.4 完成门

1. Adapter 合同：请求/响应 strict；401/403/429/5xx/超时/坏 JSON/超预算映射稳定错误。
2. Store：迁移可重复、损坏失败关闭、引用/Hash/采用不变量、重启读取。
3. Workflow：未选择不调用；required 失败关闭；optional 明确排除后继续；Workflow 重放不重复制造快照。
4. 真实服务 E2E：固定提交 `211d521…` 启动本地 memmy，预置至少 2 条可区分记忆，真实 HTTP 查询命中正确来源。
5. 真实模型浏览器 E2E：百炼 `qwen3.7-plus` 的 Plan 明确使用预置事实；无 Memory 的对照运行不能凭空知道该事实；刷新后来源与 Plan 一致。
6. 手机 390×844 和桌面 E2E 无遮挡、无横向滚动、键盘发送不回归。

## 5. M2：显式 Memory 导入闭环

### 5.1 用户结果

用户从一条会话消息或选中文本发起“导入记忆”，选择 memmy、标签和标题；页面显示真实处理状态。相同 commandId、刷新或 Worker 重启不会产生重复记忆。

### 5.2 实现范围

1. 新增 `MemoryImportIntent/Result` 状态机、公开 Command/Query、Receipt 与 Outbox。
2. 新增独立 `MemoryImportWorkflow`，内部包含 load/call/commit/reconcile Step；外部 call `maxRetries=0`。
3. memmy 使用稳定 `adapterId + requestId + requestHash`；成功响应保存 external ID/version/Hash。
4. 前端在消息和规则化选择文本上提供统一导入入口；结果状态可刷新恢复。
5. Trace 只保存 operationId、backendId、对象引用、Hash、耗时和错误码。

### 5.3 完成门

1. 发送前失败可安全重试；发送后断连进入 `outcome_unknown`，不得自动再次 add。
2. 同 commandId 同正文返回原结果；同 commandId 不同正文 409；并发导入最多产生一个外部对象。
3. 真实 memmy E2E：导入后按 ID/搜索可读；再次提交/重启后外部总数不增加。
4. 真实浏览器 E2E：导入 → 状态完成 → 新会话选择 memmy → 真实规划采用该记忆。

## 6. M3：Tencent 第二后端与多后端选择

### 6.1 用户结果

Memory 选择器同时显示 memmy 与 Tencent MemoryCore。用户能选择任一后端查询/导入，并看到两者不同的能力与完成语义。

### 6.2 实现范围

1. 实现 Tencent v3 HTTP Adapter；凭据和 team/agent/user/session 映射只在服务端配置。
2. 查询用 `atomic/search`；导入用 `conversation/add`，结果先标为 `accepted`，异步 L1 物化后才标为 `materialized`。
3. 实现 Tencent 对账：以 Chat operation/session 映射查询 L0；不得重放 `atomic/update`。
4. Registry 能力判别联合驱动 UI；不支持的标签/层参数在提交前禁用并由服务端再次拒绝。
5. 增加同一 Port 的 Adapter conformance suite，证明抽象由两个真实后端共同支持。

### 6.3 完成门

1. 固定提交 `3a9748d…` 启动真实本地 MemoryCore；BM25 查询不依赖假 embedding。
2. 两后端 conformance 全绿；隔离字段错误、Token 错误、异步未物化、坏响应和超时都有确定语义。
3. 真实 E2E 分别完成：memmy query/import、Tencent query/import/reconcile；UI 不把 accepted 显示成 materialized。
4. 后端 endpoint、Bearer、serviceId、tenant 字段不出现在浏览器、Trace、Product 正文或测试快照。
5. MemOS 仅在本任务开始时复核真实服务可用性；若没有本地依赖或云 Key，保持“候选 Adapter”并记录证据，不虚构第三后端完成。

## 7. P1：Project 基础、阶段与文档清单

### 7.1 用户结果

用户能创建项目，选择“BMAD 软件项目”或轻量模板，查看/修改当前阶段、Work 和文档清单；项目不会因为模板不同被强制成同一目录。

### 7.2 实现范围

1. 新增 `Project/ProjectMethodTemplate/Work/ProjectDocument/ProjectDecision`、v2→v3 Store 迁移与状态机。
2. 内置 `bmad-software.v1`：brief → planning → solutioning → implementation → review；映射 BMAD 的必需/可选文档和 Work 状态。
3. 内置 `lightweight.v1`：goal → active → review → done；允许自定义文档角色。
4. 新增 Project CRUD、阶段/Work/文档 Command/Query，全部带 expectedRevision。
5. 前端增加统一 Project 管理页与手机抽屉；显示当前阶段、下一门、阻塞和文档版本。

### 7.3 完成门

1. 非法跳阶段、缺少必需文档、未批准 Work 开始、旧 revision 更新均失败关闭。
2. 模板裁剪不会修改模板定义；项目固定模板版本，升级必须显式迁移。
3. BMAD greenfield、brownfield 小改动、非软件轻量项目三个场景测试通过。
4. 刷新/API 重启后阶段、Work、文档 Hash 与允许动作完全恢复。

## 8. P2：Project Context 与推进 Workflow 节点

### 8.1 用户结果

用户在对话中选择项目后，规划会使用当前目标、阶段、活动 Work、决定、阻塞和必要文档；模型提出推进或改道时，页面展示候选，用户确认后才更新项目。

### 8.2 实现范围

1. Project Context Builder 按目的、阶段和预算选择对象，写入 ContextPackage；不加载全部项目历史。
2. Planner/Executor 输出可带类型化 `ProjectChangeCandidate`，但不直接写 Project。
3. 新增 `ProjectChangeProposal` 与 HITL Command；复用版本/Hash/审批不变量。
4. Correct Course 映射为 proposal → 用户确认 → 原子 ProjectDecision/状态变更。
5. PlanPanel 展示项目来源、候选变化及其影响文档；保持现有修订/批准交互一致。

### 8.3 完成门

1. 模型不能绕过 Application 转换状态；陈旧项目版本的候选不能提交。
2. 规划 Input Manifest 能重建精确 Project Context；Trace 无文档正文。
3. 真实模型 E2E：同一项目跨两个会话恢复阶段和 Work；Correct Course 拒绝后项目不变，批准后精确变更。
4. BMAD“下一 Story”场景仅加载所需 PRD/Architecture 分片和前序经验，预算测试证明不会全量注入。

## 9. R1：规则、标签与生命周期管理

### 9.1 用户结果

用户能在 Rules 页面创建、修改、打标签、筛选、试用、启用和禁用个人规则；也能在对话中要求 Chat 提议一条规则，但提议默认只是 candidate。

### 9.2 实现范围

1. 新增 `Rule/RuleRevision/RuleTag/RuleScope/RuleDecision`、v3→v4 Store 迁移与生命周期状态机。
2. Rule Revision 保存理由、适用/不适用场景、风险、来源案例与 Hash。
3. 公开 CRUD/Query、标签筛选、生命周期 Command；所有更新使用 CAS。
4. 响应式 Rules 管理页与候选确认交互；删除采用禁用/归档语义，保留历史引用。

### 9.3 完成门

1. candidate 不能自动变 active；active 必须有用户决定或明确治理授权。
2. 修改 active 规则产生新 revision，旧 ContextPackage 仍能回放旧版本。
3. 标签重名、规则冲突提示、禁用后陈旧客户端提交、来源缺失等边界测试通过。
4. 桌面/手机 CRUD、筛选、标签和生命周期 E2E 通过。

## 10. R2：规则选择与规划注入

### 10.1 用户结果

用户在发送前可主动勾选规则或按标签筛选；未主动选择时，系统按当前项目/阶段/场景选择合适 active 规则。规划面板显示采用、排除和冲突原因。

### 10.2 实现范围

1. 实现确定性 Rule Selector：显式排除 → 显式选择 → 必需规则 → Scope 匹配 → 声明冲突处理 → 预算裁剪。
2. `submitMessage` 保存显式 Rule/Tag 选择；Workflow Context Builder 生成 `RuleSelection` 并写入 ContextPackage。
3. Planner Prompt 使用精确 Rule Revision，Input Manifest 包含 Hash；Executor 只接收计划明确需要的规则。
4. 前端 Context 选择器与 Rules 管理页复用同一查询模型，不复制第二套规则状态。

### 10.3 完成门

1. 显式选择优先于自动选择；显式排除生效；disabled/旧 revision 不得注入。
2. 冲突规则不静默覆盖，用户可在规划前或修订时解决。
3. 真实模型对照 E2E：选中规则时 Plan 遵守独特要求；未选且 Scope 不匹配时不得泄漏该规则。
4. 回放能重建当时 Rule Revision、选择原因和排除列表，Trace 无规则正文。

## 11. X1：组合闭环、质量审查与收口

### 11.1 真实用户场景

建立一个软件 Project，导入一条 Memory，创建一条带标签规则；新会话选择 Project、Memory 后端和规则标签后发送需求，完成：

```text
真实 Memory 查询
→ Project/Rule/Memory ContextPackage
→ 百炼 qwen3.7-plus 规划
→ 用户要求修订
→ 新 Plan 使用相同版本化上下文
→ 用户批准
→ 真实执行与 Product Commit
→ 页面刷新/API 重启/回放
```

### 11.2 严格 E2E

1. 两个真实 Memory 后端各至少一个查询与导入证据；无凭据或服务未启动时失败，不 Skip。
2. 真实百炼规划/执行返回真实 Provider HTTP 证据；模型固定 `qwen3.7-plus`。
3. Plan 修订默认复用原 ContextPackage；用户显式刷新选择或必需引用失效时必须产生新 ContextPackage/Input Manifest，旧 Plan 随即 superseded，不能批准。
4. 浏览器刷新和 API/Workflow 重启后恢复；重复 Command/Outbox/Workflow replay 不制造重复外部写入。
5. Replay 组装 Trace + Product Store 后无完整性错误；Trace 扫描不得出现三类正文、Token、endpoint 或私有 Runtime ID。
6. 桌面 Chromium 与 390×844 手机场景通过；无横向溢出、焦点丢失、重复提交或状态误报。

### 11.3 代码质量门

1. `pnpm build / lint / format:check / typecheck / test / audit --prod` 全绿。
2. 架构测试验证依赖方向；新增包必须说明许可证、退出方式和为何需要。
3. 对所有状态机运行正反例、并发/CAS、幂等、损坏恢复、失败注入和 Adapter conformance 测试。
4. 对公开 API 做秘密/内部 ID 泄漏扫描；对 Trace 做严格 Schema 与正文哨兵测试。
5. 完成开发者自审：删除重复抽象、无效兼容层、超长函数和无依据配置；重点代码保持短、清晰、可替换。

## 12. PR 与验证节奏

每个任务只跑与改动相关的单元/合同/集成测试，再跑一次全量质量门。真实付费模型与完整浏览器 E2E 只在 M1、M2、M3、P2、R2 和 X1 的纵向完成门运行；P1/R1 的纯管理能力使用真实浏览器但不浪费模型调用。

每个 PR 描述必须给出：

1. 基线提交、目标分支、参考源码版本。
2. 用户可见结果与明确未做事项。
3. 状态所有权、失败语义和迁移证据。
4. 单元/合同/集成/E2E 命令及数量。
5. 真实服务、真实模型的脱敏证据；不得粘贴正文或密钥。
6. 审核后才转 Ready；合并后删除分支和 worktree。

## 13. 开始与停止条件

1. 本任务书和架构说明经用户审核后，才开始 M1 生产代码。
2. 任一任务发现公共 Port 无法覆盖真实第二后端时，先在当前 PR 收窄或版本化合同，不用任意字段兜底。
3. 需要第三方云付费、服务器部署、自动写外部系统或多租户认证时停止并单独请求授权；本地已配置的百炼真实调用和本地 Memory 服务属于本任务既定范围。
