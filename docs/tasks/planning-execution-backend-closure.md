# 工作流后端闭环任务书：规划、确认、执行与正式提交

| 项目 | 内容 |
|---|---|
| 状态 | 任务书草案已按用户反馈修订，待最终检视 |
| 任务类型 | 跨阶段后端纵向任务组；不是一个开发任务或一个巨型PR |
| 主要结果 | 用户从现有Chat输入框发送消息后，后端用一个Workflow完成真实规划、人工决定循环、真实模型执行和正式结果提交 |
| 实现顺序 | 先完成并调通后端，仅对现有聊天发送框做最小接线；计划审核、工作流进度等前端适配后续单独完成 |
| 交付方式 | 7个顺序子任务；每个子任务使用独立Git worktree、独立分支和独立PR |
| 当前基线 | 当前仓库只有P0合同骨架和P1.1前端；尚无业务Store、Workflow Definition或pi Adapter |
| 开始条件 | 当前P1.2独立PR先完成；本任务组不得混入P1.2 worktree或PR |
| Provider | 阿里云百炼按量付费或业务空间API，真实模型`qwen3.7-plus` |
| 当前存储 | 版本化JSON Product Store；单实例、单写者，后续可替换为数据库 |

## 1. 先回答：完成后用户能做什么

本任务组只证明一条纵向链：

```text
用户在现有Chat输入框发送消息
-> Chat服务端保存原始消息和Product Run
-> 启动唯一PlanningExecutionWorkflow
-> pi使用百炼qwen3.7-plus生成Plan v1
-> 后端保存Plan Revision和Approval Request并暂停Workflow
-> 调试客户端提交“修改计划”
-> 同一Workflow用真实模型生成Plan v2
-> 调试客户端批准Plan v2
-> 同一Workflow用真实模型逐步骤执行
-> 确定性验证候选结果
-> Product Commit生成正式Message或Artifact
-> JSON会话存储和Trace中可以复核完整结果与路径
```

这一阶段用户可以从现有对话框发起工作，但修改、批准、拒绝和查看完整运行细节仍通过Chat API或仓库调试客户端完成。现有工作流运行区、计划审核界面、执行进度界面和手机端工作流交互不在本任务组修改。

## 2. 背景与当前缺口

仓库当前已有TypeScript Workspace、Hono健康检查、React工作空间、共享合同骨架和领域Run状态基础，但还没有：

1. 可保存Session、Message、Product Run、Plan、Approval和Decision的产品Store。
2. `PlanningExecutionWorkflow`定义、Step或Decision Hook。
3. Chat到冻结pi源码的`PiRuntimePort`实现。
4. 百炼真实Provider配置和`qwen3.7-plus`模型验证。
5. 从现有聊天输入框向Chat Message Command发送请求的正式接线。
6. 能按一次Run重建完整时间线的结构化Trace。
7. 可一键启动、固定端口、先清理旧进程的VS Code调试配置。

本任务组补齐这些缺口，但不把后续Workflow前端、Memory、BMAD、经验规则或真实外部Tool夹带进来。

## 3. 已确认的产品决定

1. 一次用户输入创建或幂等返回一个Product Run，并私下对应一个`PlanningExecutionWorkflow` Run。
2. pi规划、等待、修改循环、批准、pi执行、验证和Product Commit都位于同一个Workflow Run。
3. 用户修改不会覆盖旧Plan；每次都生成新的Plan Revision并重新等待确认。
4. 规划修订第一版最多5轮，达到上限后失败关闭并提示调整目标后重新开始。
5. 第一版`pi.execute`不开放真实外部副作用Tool。
6. 当前使用JSON保存产品会话及本闭环所需产品事实。
7. 端到端验收必须调用真实百炼Provider和真实`qwen3.7-plus`，不能用可控模型或固定回答冒充完成。
8. 现有聊天输入框必须真实触发Message Command和Workflow；其余前端功能后续适配。
9. Trace和VS Code可重复调试属于完成条件，不是可选开发便利项。

## 4. 范围与非范围

### 4.1 允许修改

1. `packages/contracts`：Session、Message、Run、Plan Revision、Approval、Decision、Execution Contract、Trace和错误Schema。
2. `packages/domain`：状态机、Hash绑定、修订上限、非法转换和产品不变量。
3. `packages/application`：命令协调、事务、幂等、Outbox、候选发布、决定提交、验证和Product Commit。
4. `packages/workflows`：单个`PlanningExecutionWorkflow`、Step、Hook、循环和恢复适配。
5. `packages/pi-runtime`：百炼Provider配置、pi Planner/Executor、候选收集和事件归一化。
6. `packages/realtime`：后端Trace和未来公开运行事件需要的最小记录；不实现新的前端运行区。
7. `packages/testing`：JSON Store、Workflow、pi、Provider和API场景工具。
8. `apps/api`：正式Query/Command、组合根、健康检查和仅开发环境使用的诊断入口。
9. `apps/web`：仅允许把现有聊天输入框接到Message Command，并让模型标签与实际`qwen3.7-plus`一致。
10. `.vscode/`、根脚本、`.gitignore`和`docs/`：固定端口调试、进程清理、环境合同和执行证据。

### 4.2 禁止修改或实现

1. 不把Plan、Approval、Decision或执行进度接入现有工作流运行区。
2. 不重做对话区、导航、PPT、白板、代码区或移动端布局。
3. 不让浏览器直接调用Vercel Workflow、pi或百炼。
4. 不向浏览器返回Workflow Run ID、Hook Token、pi Session ID或Provider请求身份。
5. 不实现发送邮件、修改仓库、写日历、删除、扣费等外部副作用。
6. 不实现Memory、BMAD、经验规则选择、Workflow编辑器或多Runtime平台。
7. 不选择正式生产数据库，不宣称JSON Store支持多实例或生产级并发。
8. 不在弱服务器安装依赖、编译、运行测试或现场修改代码。

## 5. 总体架构与状态所有权

```text
Web聊天输入框
-> Hono Message Command
-> Application Coordinator
   -> JSON Product Store提交Message/Product Run/Outbox
   -> 事务外启动一个PlanningExecutionWorkflow

PlanningExecutionWorkflow
-> pi.plan（真实百炼qwen3.7-plus）
-> Application发布Plan Revision + Approval Request
-> Decision Hook暂停

Decision Command / 调试客户端
-> Application校验Principal/revision/Hash/commandId
-> JSON Product Store提交Decision + Resume Outbox
-> 后端使用私有Hook Token恢复同一Workflow

request_revision -> 再次pi.plan
reject           -> Product Run取消
approve          -> 生成不可变Execution Contract -> pi.execute

pi.execute候选
-> 确定性结构与成功标准验证
-> Application Product Commit
-> JSON Product Store中的正式Message/Artifact和Run终态
```

所有产品修改必须经过Application Coordinator。Hono Router、Workflow Step和pi Adapter都不得直接修改JSON文件。

## 6. JSON Product Store方案

### 6.1 存储内容

当前使用一个版本化快照文件：

```text
.data/chat-product-store.v1.json
```

至少保存：

1. Product Session。
2. 用户和Assistant正式Message。
3. Product Run及`status + phase + revision`。
4. Plan Revision及内容Hash。
5. Approval Request和Decision。
6. Execution Candidate、验证结果及Artifact引用。
7. `commandId`幂等结果。
8. Product Run与Workflow/Hook的后端私有映射。
9. Transactional Outbox及派发状态。

Product Store必须保存Trace所引用的对象及其全部revision（Plan各revision、Decision、Execution Candidate等），不能只保留不可追溯的最新值；否则历史回放无法精确重建。

文件顶层必须包含`schemaVersion`和`storeRevision`，启动读取和每次提交都使用Zod校验。

### 6.2 写入规则

1. 一个API实例拥有唯一写队列，所有产品事务串行提交。
2. 每次事务先在内存副本运行领域规则和CAS，再生成完整新快照。
3. 新快照写入同目录临时文件，完成`fsync`后使用原子`rename`替换正式文件。
4. 提交失败保留旧快照，不允许出现半写JSON或部分对象已经更新。
5. 文件损坏、Schema未知或校验失败时启动失败关闭，不自动覆盖或删除原文件。
6. JSON文件、临时文件、备份和运行时映射都位于`.data/`，不得进入Git、Trace或PR附件。
7. Workflow、Router和pi不直接打开该文件；只通过Application Port访问。

### 6.3 当前保证边界

本任务保证正常提交后的Session、Message、Plan、Decision和正式结果在API进程重启后可以重新读取。

本任务仍不保证：

1. 多API实例同时写同一文件。
2. 网络文件系统、跨主机共享或高并发吞吐。
3. 机器断电、磁盘损坏后的备份与灾难恢复。
4. 所有进行中Workflow在任意Worker崩溃点的生产级接管；这仍属于P3。

JSON Store必须实现明确Port，后续更换数据库时不改变Domain、Application、Workflow或API合同。

## 7. Trace与日志方案

### 7.0 Trace的职责与数据来源分工

Trace不是会话副本，也不只是零散代码日志。它负责记录一次工作经过了哪些系统边界、状态如何变化、调用关系是什么、哪里失败、耗时和统计数据是多少。完整历史回放由以下数据组合完成：

| 数据来源 | 保存内容 |
|---|---|
| Product Store | 用户消息、Assistant消息、Plan各revision、Decision、Execution Candidate、正式结果、Artifact等正文和产品事实 |
| Trace | 时间线、调用关系、状态转换、步骤、Attempt、耗时、重试、错误、对象引用、Hash和统计 |
| Workflow Store | Workflow运行状态、Checkpoint、Hook等待与恢复状态 |
| 版本证据 | Git SHA、Workflow Definition版本、Prompt模板版本、模型配置版本 |
| Replay Assembler | 按Trace引用读取对应产品对象和运行版本，组装完整回放视图（B7实现） |

必须遵守：

1. 用户正文、Plan正文、模型候选正文、Prompt、Provider请求和响应正文只保存一次，不复制到Trace。
2. Trace通过`对象ID + revision + sha256`引用这些内容。
3. Trace必须足以还原系统路径，但不能成为第二份产品事实源。
4. 永远不保存模型隐藏推理。
5. “历史回放”和“重新执行”分开：历史回放读取当时保存的对象和Trace，可以精确重建；真实模型重新执行不保证生成相同文本，必须创建新的Run Attempt，不能覆盖原运行。

### 7.1 目标

对任意`productRunId`，开发者必须能够重建：

```text
HTTP命令
-> 产品事务
-> Workflow启动
-> pi规划调用
-> Plan发布
-> Hook等待
-> Decision提交与恢复派发
-> pi执行
-> 验证
-> Product Commit
-> 正式终态
```

不能依靠散落的`console.log`猜测发生了什么。

### 7.2 Trace事件格式与合同

Trace使用一行一个JSON对象的JSONL文件：

```text
.data/traces/chat-trace-YYYY-MM-DD.jsonl
```

Trace事件合同是以`eventName`为判别字段的严格联合（`z.discriminatedUnion` + 每层`.strict()`），不存在`attributes`/`metadata`/`details`等任意`Record<string, unknown>`内容通道；未声明字段在根部与任何嵌套层都失败关闭，不做“写入后脱敏”。合同实现与事件清单见`packages/contracts/src/trace.ts`。

公共关联字段：

```text
schemaVersion
eventId
timestamp
level
eventName
traceId
spanId
parentSpanId?
requestId?
productSessionId?
interactionId?
productRunId?
attemptId?
commandId?
workflowDefinitionVersion?
promptTemplateVersion?
modelConfigVersion?
durationMs?
outcome
```

对象引用使用严格结构：

```text
{ objectType: message|plan|decision|execution_contract|execution_candidate|context_package|artifact,
  objectId, revision?, sha256? }
```

事件专属字段约束：

1. HTTP事件只记录method、route template、status code；不记录请求Body、Query正文或可能携带用户内容的原始URL。
2. 产品事务与状态转换记录事务类型、原/目标状态、phase/revision和输入输出对象引用。
3. Workflow事件记录稳定step key、step attempt、是否replay、Definition版本和后端私有映射引用；不记录Hook Token。
4. Provider事件只记录Provider（`bailian`）、模型（`qwen3.7-plus`）、Endpoint host、百炼请求ID、HTTP状态、耗时和Token Usage，以及context/input manifest的引用或SHA-256；不记录API Key、Authorization Header、Cookie、Prompt、消息数组、工具Payload、原始响应或隐藏推理。
5. 错误信息只记录稳定`errorCode`、错误类型名、`stackFingerprint`和必要的仓库相对安全Stack Frame；不保存可能含用户正文或Provider响应的原始`Error.message`。
6. 所有字符串字段受限：ID使用项目ID Schema，状态/Provider/模型使用枚举或受限Schema，Hash固定SHA-256，自由字符串有明确长度与语义边界。

用户消息和模型候选属于Product Store内容。Trace只保存对象引用、长度、Hash和可观察结果，不复制完整正文。

### 7.3 必须记录的边界

1. `http.command.received/accepted/rejected/completed`。
2. `product.transaction.started/committed/failed`。
3. `product_run.created/transitioned`。
4. `workflow.start.requested/started/failed`。
5. `workflow.step.started/completed/failed`；事件中的`stepAttempt`取自Workflow SDK的真实Step metadata。
6. `plan.candidate.received/rejected/published`。
7. `approval.created`、`decision.committed/rejected`。
8. `workflow.hook.waiting/resume_dispatched/resumed/resume_failed`。
9. `provider.request.started/completed/failed`。
10. `pi.node.started/completed/failed`。
11. `execution.validated/rejected`。
12. `product_commit.started/committed/failed`。

Provider Trace可记录Provider、模型、Endpoint host、响应状态、百炼请求ID、耗时和Token Usage；不得记录API Key、Authorization Header、Cookie、完整Prompt、完整响应、完整Provider Payload或隐藏推理（由严格合同结构性排除，而非黑名单过滤）。

Workflow命中已完成Checkpoint时不会重新执行Step代码，因此Chat不能在Step内部伪造
`workflow.step.replayed`。真实重放证据由Workflow Store/World与保存的Step attempt共同提供；
合同中的`workflow.step.replayed`只保留给未来由World事件投影生成的证据或旧数据兼容，不属于当前Step必发事件。

### 7.4 Trace调试入口

仓库提供可复制命令按`productRunId`读取、校验并按时间排序Trace，例如：

```text
pnpm debug:trace --run run_xxx
```

输出只含严格合同校验通过的事件。Trace读取失败不能修改原始JSONL文件。

### 7.5 历史回放设计（B2纵向闭环已实现）

“历史回放”和“重新执行”分开：回放读取当时保存的对象与Trace精确重建；重新执行真实模型必须创建新的Run Attempt，不覆盖原运行。

`RunReplayAssembler`按`productRunId`完成：

```text
读取Trace
-> 按引用加载Message/Plan/Decision/Execution Candidate等产品事实
-> 校验revision与SHA-256
-> 加载Workflow、Prompt模板、模型配置和代码版本证据
-> 生成RunReplayView
```

Replay结果必须标出：引用对象缺失、revision不存在、Hash不一致、Trace事件缺口、Workflow或版本证据不可读取。

两个不同入口：

1. `pnpm debug:trace --run ...`：只看脱敏系统时间线（B1已提供）。
2. `pnpm debug:replay --run ...`：在本地授权环境组合Product Store和Trace查看完整历史。

导出到PR、CI附件或截图的证据默认不包含正文；完整正文只能在本地回放视图按需读取。

## 8. VS Code固定端口调试

### 8.1 固定端口

本任务冻结本地调试端口：

| 用途 | 地址/端口 |
|---|---|
| Web HTTP | `127.0.0.1:43110` |
| Chat API HTTP | `127.0.0.1:43111` |
| Workflow本地运行时 | `127.0.0.1:43112` |
| API Node Inspector | `127.0.0.1:43120` |
| Workflow Node Inspector | `127.0.0.1:43121` |

这些端口在任务书编写时没有监听者、没有`/etc/services`登记，并低于当前macOS动态端口起点49152。Vite和服务端必须启用`strictPort`或等价失败关闭，禁止端口冲突后自动换号。

### 8.2 启动前清理

`.vscode/launch.json`的主Compound必须先执行`preLaunchTask`：

1. 读取`.data/debug/pids.json`并向上次Chat调试进程组发送`SIGTERM`。
2. 有限等待后，仅对仍存活的本项目进程使用`SIGKILL`。
3. 再检查43110～43112和43120～43121。
4. 如果端口仍被当前Chat工作区或其已记录子进程占用，清理后重新检查。
5. 如果端口被未知应用占用，禁止杀掉未知进程；调试启动失败并报告端口、PID和进程名。
6. 端口全部释放后才能启动新调试会话。

不得使用`pkill node`、`killall`或按模糊名称终止系统中其他Node、VS Code或用户应用。

### 8.3 调试入口

仓库提交：

1. `.vscode/launch.json`：API、Workflow、Web Browser和“Chat：完整后端闭环”Compound。
2. `.vscode/tasks.json`：清理、启动、健康等待和停止任务。
3. 项目脚本：记录PID、清理进程树、检查固定端口和等待Health Ready。
4. `postDebugTask`：停止本轮启动的进程并释放端口。
5. `.env.example`：只包含变量名和安全示例，不包含真实Key、Workspace ID或私有地址。
6. `.gitignore`：只放行共享的`.vscode/launch.json`和`.vscode/tasks.json`，继续忽略用户自己的VS Code设置、缓存和本地覆盖。

主调试入口启动顺序固定为：

```text
清理旧进程
-> 启动Workflow运行时
-> 等待Workflow Ready
-> 启动Chat API
-> 等待/api/healthz和依赖Ready
-> 启动Web
-> 打开浏览器
```

启动失败必须自动停止本轮已经启动的进程，不能留下半套服务继续占端口。

## 9. 百炼真实Provider与模型

### 9.1 固定选择

1. Provider：阿里云百炼后端服务API。
2. API形态：百炼OpenAI兼容Chat Completions，通过pi的OpenAI兼容Provider能力接入。
3. 模型ID：`qwen3.7-plus`。
4. 默认华北2（北京）Base URL：`https://dashscope.aliyuncs.com/compatible-mode/v1`。
5. 生产或专属空间可通过`DASHSCOPE_BASE_URL`使用业务空间专属域名。
6. API Key环境变量：`DASHSCOPE_API_KEY`。

Token Plan和Coding Plan专用Endpoint不得用于Chat后端服务。冻结pi源码内置的`qwen-token-plan-cn`Provider不能直接作为本任务的后端Provider；`packages/pi-runtime`必须建立Chat拥有的`bailian`Provider配置，并复用pi已经核验的OpenAI兼容流和Qwen thinking格式能力。

### 9.2 凭据规则

1. 启动只检查`DASHSCOPE_API_KEY`是否存在，不打印、回显、持久化或进入Trace。
2. `DASHSCOPE_BASE_URL`只允许HTTPS，并在启动时校验host与允许的百炼域名合同。
3. `.env`、VS Code本地覆盖、Provider响应原文和密钥不得提交Git。
4. Web不得接收API Key、Base URL或Provider身份凭据。
5. Provider调用由后端pi Adapter统一发起。

### 9.3 真实模型完成门

单元测试仍可在不调用网络的情况下验证纯状态机、Schema和失败分类，但任何以下能力不得由替身证明：

1. pi能够通过百炼调用`qwen3.7-plus`。
2. Planner能够真实调用`submit_plan_candidate`并产出合法Plan。
3. Revision Input能够让真实模型形成新Plan Revision。
4. Executor能够依据Approved Plan产出合法执行候选。
5. Provider事件、Token Usage、超时和错误能够进入脱敏Trace。

提供显式命令，例如：

```text
pnpm test:provider:bailian
pnpm test:e2e:workflow:real
```

缺少真实凭据时这两个命令必须失败并说明配置方法，不能静默Skip。任务组不能在没有一份真实Provider脱敏证据的情况下宣称完成。

Provider调用设置明确turn、timeout和token上限。pi规划和执行Step禁用Workflow自动重试；认证失败、限流、超时、连接中断和候选无效分别进入稳定错误族，不能盲目再次产生付费调用。

## 10. pi Planner与Executor边界

### 10.1 Planner

Planner只得到：

1. 用户原始Message引用及正文。
2. 当前上下文引用。
3. 上一版Plan和本轮文字修改意见。
4. `submit_plan_candidate`内部结果收集工具。
5. 模型、turn、timeout和token限制。

第一版“修改计划”只接受文字`revisionInstruction`，不接受浏览器直接覆盖Plan JSON。模型每次产生新Plan Candidate；Application验证并发布为新revision。

### 10.2 Executor

Executor只得到Application生成的不可变Execution Contract，其中绑定：

1. Approved Plan revision和Hash。
2. Approval Decision引用。
3. 按顺序执行的Plan Step。
4. 允许的Chat内部无副作用Capability。
5. 时间、turn和token限制。

Executor不能自行新增步骤、修改批准版本、获得外部副作用Tool或直接写Product Store。

## 11. Query与Command API

至少实现：

```text
POST /api/sessions/:sessionId/messages
GET  /api/sessions/:sessionId/messages
GET  /api/runs/:productRunId
GET  /api/runs/:productRunId/plans
GET  /api/runs/:productRunId/approvals
POST /api/runs/:productRunId/decisions
```

要求：

1. Message Command携带`commandId`；重复提交返回第一次的Message和Product Run，不重复启动Workflow。
2. Decision Command携带`commandId`、`expectedRevision`、`planRevision`和`planHash`。
3. `request_revision`还携带非空`revisionInstruction`。
4. Query只返回Chat产品对象和允许的状态，不返回Runtime私有身份。
5. 错误使用Problem Detail，至少区分版本冲突、Hash冲突、过期、越权、重复冲突、Provider失败和内部故障。
6. Router只校验HTTP和DTO并调用Application Coordinator。

## 12. 现有聊天输入框的最小接线

只允许修改发送链：

1. `handleSend`不再创建`localOnly`成功消息，而是调用Message Command。
2. 同一次发送尝试生成并保留稳定`commandId`；网络结果未知后的手动重试使用同一个ID。
3. 只有服务端接纳后，使用服务端返回的正式用户Message更新对话区。
4. 请求失败保留草稿并显示可执行错误，不生成成功消息或Product Run假状态。
5. 服务端固定使用`bailian/qwen3.7-plus`模型配置；不信任浏览器提交的模型名称。
6. 对话区不能继续显示GPT等与实际运行不一致的模型标签；本阶段只显示不可切换的“百炼 Qwen3.7 Plus”或等价真实标签。
7. 不读取Plan Query、不显示Approval、不提供修改/通过/拒绝按钮、不接入执行进度。

用户从Web触发后，后续修改和批准通过调试客户端完成。完整前端适配是下一阶段。

## 13. 7个顺序子任务与PR

### B1：可重复调试与Trace基线

**主要结果**：从VS Code一键清理旧Chat调试进程，以固定端口启动空服务，并能产生、查询结构化Trace。

范围：`.vscode`、安全进程管理脚本、固定端口、Trace Schema/Sink/Reader和Health Ready。

完成门：连续启动两次不会残留旧进程或改变端口；未知应用占用端口时安全失败；Trace脱敏测试通过。

### B2：JSON Product Store

**主要结果**：Session、Message、Product Run、幂等结果和Outbox可以作为一个原子JSON快照提交，并在API进程重启后读回。

范围：Store Port、单写队列、Zod快照、原子写入、损坏文件失败关闭和存储测试。

完成门：重复commandId、CAS冲突、并发写入、写入失败、重启恢复和损坏JSON场景通过。

### B3：Plan、Approval、Decision合同与领域

**主要结果**：不启动Workflow也能证明Plan修订、审批绑定、拒绝和非法决定规则完全确定。

范围：Contracts、Domain、Application用例、Execution Contract和状态机测试。

完成门：旧revision、错误Hash、重复、过期、越权、修订上限和Product Commit失败全部安全关闭。

### B4：单Workflow与Decision Hook

**主要结果**：真实Vercel Workflow运行时证明“规划候选 -> 等待 -> 修改循环/批准/拒绝”始终发生在同一Workflow Run。

范围：Workflow Definition、Step、Hook、私有映射、Resume Outbox Dispatcher和Workflow真实集成测试。

完成门：Hook暂停、同Run修订、批准、拒绝、重复Resume、Replay和提交失败场景通过。这里可以用测试Planner Port验证控制流，但不能代替B5和最终真实Provider验收。

### B5：百炼qwen3.7-plus pi Adapter

**主要结果**：真实pi Agent loop通过真实百炼Provider完成一次Planner和一次Executor调用。

范围：Chat `bailian`Provider、模型配置、Planner/Executor、结果收集工具、事件归一化、限额和Provider错误。

完成门：`pnpm test:provider:bailian`真实通过；证据包含脱敏Provider请求ID、模型ID、耗时、usage和候选Schema结果。

### B6：Chat API与聊天发送框接线

**主要结果**：用户在现有Web聊天输入框发送一条消息，服务端只接纳一次并启动唯一Workflow；其余Workflow前端保持不变。

范围：Hono Query/Command、组合根、调试客户端、Vite固定代理、对话框最小发送适配和相关组件测试。

完成门：浏览器发送成功、失败、重复和网络结果未知场景通过；API响应和浏览器状态没有Runtime私有ID。

### B7：真实后端纵向链与失败加固

**主要结果**：使用真实Hono、真实Workflow、真实pi和真实百炼`qwen3.7-plus`完成Plan v1 -> 修改 -> Plan v2 -> 批准 -> 执行 -> 正式结果。

范围：真实E2E、失败注入、Trace证据、JSON重启读取、RunReplayAssembler（§7.5）、合同冻结和前端阶段交接清单。

完成门：第15节全部通过，才能开始Plan/Decision/执行进度的前端适配。

每个子任务预计0.5～2个单人开发日。若实现前判断任一子任务超过2日，先报告并继续拆分，不把范围藏进同一个PR。

## 14. 测试策略

### 14.1 纯规则和存储测试

1. 所有网络、Hook和Provider Payload都经过运行时Schema校验。
2. Product Run、Plan Revision、Approval和Decision合法/非法转换。
3. JSON事务、CAS、`commandId`幂等、单写并发和原子替换。
4. Trace字段、事件顺序、关联ID和脱敏。
5. Provider/Workflow/Hook私有身份不能进入公开DTO。

### 14.2 真实Workflow测试

1. 一个Product Run只启动一个Workflow Run。
2. Plan v1后真实等待Hook。
3. `request_revision`恢复同一个Workflow并再次规划。
4. `approve`进入执行；`reject`不执行。
5. 重复Decision只恢复一次。
6. Workflow Replay不重复已经完成的Application提交。
7. Product Commit失败不重新调用pi执行。

### 14.3 真实百炼测试

1. 使用真实`DASHSCOPE_API_KEY`和`qwen3.7-plus`完成Provider Preflight。
2. 真实Planner调用内部结果工具并返回合法Plan Candidate。
3. 真实Planner根据文字意见产生新revision；测试不要求固定自然语言文本，但要求Hash变化和Schema合法。
4. 真实Executor只使用批准合同，产生合法执行候选。
5. Trace包含真实模型、耗时、usage和Provider结果，不含正文、密钥或隐藏推理。
6. 认证失败、429、超时、流中断和非法候选进入稳定错误族；付费调用不被自动重试。

### 14.4 API与最小Web测试

1. 浏览器输入一次只产生一个正式用户Message、Product Run和Workflow。
2. 发送失败保留草稿，不出现`localOnly`成功消息。
3. 手动重试复用commandId时不会重复执行。
4. 前端只显示真实百炼模型标签。
5. Workflow运行区和其他界面没有行为或视觉回归。
6. 公开响应、URL、localStorage和页面不出现Hook Token、Workflow Run ID或pi Session ID。

### 14.5 VS Code人工调试验收

1. 启动主Compound，确认43110～43112和43120～43121均为固定进程。
2. 不手动停止，再次启动；旧Chat调试进程先退出，新进程获得相同端口。
3. 在一个固定端口启动无关测试进程，确认调试拒绝启动且不杀无关进程。
4. 在Message Command、Workflow规划Step、Hook恢复、pi Adapter和Product Commit设置断点并分别命中。
5. 停止调试后所有本轮进程和端口释放。
6. 从`productRunId`查询到完整脱敏Trace。

## 15. 后端闭环完成门

只有以下条件全部通过，才允许进入完整前端适配：

1. Web聊天框发送真实消息并触发唯一Product Run和Workflow。
2. JSON Product Store在API进程重启后恢复正式Session、Message、Plan、Decision和结果。
3. 一个Workflow内完成真实Plan v1、修改、真实Plan v2、批准、执行和Product Commit。
4. Planner和Executor都实际使用百炼`qwen3.7-plus`，有脱敏Trace证据。
5. 旧revision、错误Hash、重复、过期和越权Decision安全失败。
6. pi、Provider、Workflow、验证和Product Commit失败都不产生假成功。
7. Product Commit失败时不重新执行已经成功的付费pi节点。
8. Workflow Replay不重复已完成Step或产品提交。
9. 调试客户端只通过Chat API，不直接打开JSON Store、调用pi或恢复Hook。
10. Trace能重建完整路径，且不包含密钥、完整正文、完整Provider Payload或隐藏推理。
11. VS Code连续启动、端口冲突、断点和停止清理场景全部通过。
12. Web与公开API不泄漏Workflow、Hook、pi或Provider私有身份。
13. 现有工作流运行区、PPT、代码、白板、主题和375px布局测试没有回归。
14. 所有7个子任务通过独立worktree和PR审核并顺序合并。

## 16. PR与Git worktree规则

1. 本文是任务组总书，不对应一个巨型实现PR。
2. B1～B7严格顺序执行；后一个任务从前一个已合并提交创建新worktree。
3. 每个PR只包含自己的主要结果、直接测试、必要文档和证据。
4. 每个worktree开始前记录基线提交和目标分支；结束前报告实际修改文件、测试和仍不保证的边界。
5. 不在Later当前工作目录直接实现，不与P1.2 worktree混用。
6. 不使用`git add .`、`git add -A`、破坏性reset或强推。
7. PR默认先以Draft创建；自动检查通过、真实Provider证据完成后再请求检视。
8. 任一PR发现需要修改已合并合同，先在当前PR中明确迁移与兼容影响，不在后续前端偷偷猜测。

## 17. 构建、服务器与凭据

1. 开发、依赖安装、Typecheck、测试和构建在开发机或CI完成。
2. 弱服务器不运行`pnpm install`、`pnpm build`、`tsc`、Vitest或Provider测试。
3. 本任务组完成不等于获得部署授权；生产发布是单独任务和外部副作用。
4. 若后续部署，服务器只接收审核提交生成、带Git SHA和SHA-256的后端/Web产物。
5. 百炼Key、Workspace ID、私有Base URL、服务器地址和账号只通过私有环境配置提供。
6. PR、Trace、测试快照、截图和调试输出不得包含上述秘密。

## 18. 调试与交付证据

最终检视至少提供：

1. 7个PR及其基线、合并提交和worktree说明。
2. 固定端口清单与两次连续VS Code启动记录。
3. 自动测试命令、数量和结果。
4. 一次真实Web发送请求的公开响应。
5. Plan v1/v2 revision和Hash变化。
6. 同一Workflow私有映射断言；证据可证明相同，但不得公开实际Token。
7. 真实百炼`qwen3.7-plus`的脱敏Provider Trace：时间、模型、请求ID、耗时和usage。
8. Decision修改、批准以及旧版本失败记录。
9. 正式Message/Artifact和Product Run终态Query。
10. API进程重启后JSON会话重新读取结果。
11. 一份按`productRunId`导出的脱敏Trace时间线。
12. 尚未实现的前端功能和进入下一阶段需要冻结的合同清单。

## 19. 官方与源码依据

1. [百炼模型大全](https://help.aliyun.com/zh/model-studio/models)：模型ID`qwen3.7-plus`、可用区域和兼容API。
2. [百炼文本生成模型](https://help.aliyun.com/zh/model-studio/text-generation-model)：`qwen3.7-plus`支持1M上下文、Function Calling和结构化输出。
3. [百炼Base URL总览](https://help.aliyun.com/zh/model-studio/base-url)：按量付费、业务空间、Token Plan和Coding Plan的Endpoint与使用边界。
4. [百炼OpenAI兼容Chat API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)：`DASHSCOPE_API_KEY`和OpenAI兼容调用方法。
5. [Vercel Workflow Hooks](https://useworkflow.dev/docs/foundations/hooks)：Workflow暂停和外部恢复。
6. [Vercel Workflow Testing](https://useworkflow.dev/docs/testing)：真实Hook、Resume和Replay测试。
7. pi能力对照源码：`/Users/xulater/Code/opc-os/pi`提交`10e99ae9914cd34f622633fac42f9a90714e9cf4`；实际运行工件由B2合同固定为npm `@earendil-works/pi-agent-core`/`pi-ai` 0.82.1（发布基点`b4f293684bba718d59cc1157679bcf6157b3a7f5`）及pnpm锁文件SHA-512。
8. 冻结pi的`packages/ai/src/providers/qwen-token-plan-cn.ts`证明其Qwen Token Plan Provider使用OpenAI兼容API，但百炼官方限制Token Plan不能作为后端服务，因此Chat建立单独`bailian`Provider配置。

## 20. 提交给实现者前的最后检查

1. 用户提供的Key属于百炼按量付费或业务空间，不是Token Plan/Coding Plan专用Key。
2. `DASHSCOPE_BASE_URL`与Key区域、计费方案匹配。
3. P1.2已经合并，目标基线已更新为最新主分支。
4. B1的固定端口在实现开始时再次检查；若环境永久占用，先由用户批准统一改号，不能运行时自动漂移。
5. 用户明确接受真实Provider测试会产生费用和网络依赖。
6. 用户理解本阶段只有聊天输入框接线；计划修改和批准仍通过调试客户端。
7. 用户理解JSON Store是当前单实例实现，不是最终生产数据库。
