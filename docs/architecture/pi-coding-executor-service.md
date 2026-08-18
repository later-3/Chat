# Pi Coding Executor Service As-built

> 日期：2026-08-18
>
> 运行工件：`@earendil-works/pi-coding-agent@0.84.2`、`pi-agent-core@0.84.2`、`pi-ai@0.84.2`
> 产品事实源：Chat Product Store；Pi Operation、Pi Session和Tool Journal都不是产品终态。

## 1. 结论

Chat不再用单轮`pi-agent-core + submit_execution_result`模拟Executor。批准后的每个Execution Step由独立`apps/pi-executor`进程中的真实`AgentSession`执行，具备Pi的多轮Provider/Tool loop、Session JSONL、上下文文件、Skills、Compaction以及`read/grep/find/ls/edit/write/bash`内建工具。

没有使用`pi` CLI做进程协议，也没有采用仍缺少operation幂等、cursor replay和Tool执行前栅栏的实验性`pi-server`。集成面是Chat拥有的窄HTTP Operation协议；Pi上游保持可升级依赖，Chat产品身份和终态不写入Pi源码。

## 2. 进程与所有权

```text
Vercel Workflow Step
  -> PiExecutorServiceClient
     -> POST operation（稳定pio_*，202/幂等复用）
     -> GET events?afterSequence=N
     -> GET operation terminal snapshot
        -> apps/pi-executor (127.0.0.1:43115, Runtime Key)
           -> API authorize-executor-operation（Product Store权威回查）
           -> Operation Store (.data/pi-executor/operations)
           -> AgentSession
              -> Pi Session JSONL (.data/pi-executor/sessions)
              -> Provider
              -> approved tools in configured Workspace Root
  -> Execution Candidate
  -> deterministic Validation
  -> Product Commit
```

| 对象 | 所有者 | 用途 |
|---|---|---|
| Product Run / Run Attempt / Execution Contract | Product Store | 权威用户意图、批准能力、Workspace引用与终态 |
| Workflow Run / Checkpoint | Vercel Workflow | 耐久编排、暂停与恢复 |
| Pi Operation `pio_*` | Executor Service | 一次执行请求的幂等、状态与事件cursor |
| Pi Runtime Session `pis_*` | Pi `AgentSession` | 对话、工具结果、Compaction与Session恢复素材 |
| Operation Journal | Executor Service | 安全可重放的边界事件；不是产品正文 |
| Chat Trace | Realtime Trace Sink | Operation Journal的严格安全投影 |

`executionAttemptId -> piOperationId`是确定性映射。同一Operation ID和同一请求Hash返回原状态；同一ID换请求返回冲突。浏览器不会获得Operation ID、Pi Session ID或Runtime Key。

Runtime Key只证明调用方是内部进程，不授予Workspace能力。Start请求进入Operation Store前，Executor Service必须调用API的`authorize-executor-operation`；Application会回查尚在运行的Execution Attempt、Contract ID/Hash、Step、Input Manifest和依赖血缘，并返回权威Contract与Context正文。服务忽略Workflow提交的Contract/Context正文，并重算每个依赖Step Result的Hash；任何偏差都在创建AgentSession或解析Workspace路径前失败关闭。

## 3. Execution Contract与工具能力

Planner只能从以下四种Capability请求能力，用户批准Plan后Application再次校验并编译不可变Contract：

| Capability | Pi工具 |
|---|---|
| `markdown_text_compose` | 无Workspace工具 |
| `workspace_read` | `read`、`grep`、`find`、`ls` |
| `workspace_write` | 读工具 + `edit`、`write` |
| `shell_execute` | 读工具 + `bash`；必须标记`high`风险 |

任何非纯文本能力都必须绑定Planning时冻结的Project Context，并解析出唯一活动`ProjectResource`。Product Store只保存`projectId/projectResourceId/rootId/revision`；Executor Service用服务端`CHAT_PROJECT_ROOTS_JSON`把`rootId`解析为canonical path。canonical Host路径不会进入Product Store、Workflow checkpoint或Operation HTTP请求；Pi工具实际使用的模型可见相对路径会作为已脱敏、有界执行证据进入Journal/Trace。

`read/grep/find/ls/edit/write`在awaited `tool_call`栅栏中拒绝`..`、Root外绝对路径与symlink逃逸；被拒绝的调用记录参数Hash、已脱敏显示输入和稳定错误码。`bash`与Pi CLI一样是本机用户权限下的高影响能力，不是文件系统或网络沙箱：它固定以Workspace为`cwd`，但命令本身仍可访问Host。为避免把Provider/Runtime秘密暴露给Shell，Executor只传递PATH、Locale、时区、终端和临时目录等白名单环境，并使用独立HOME；需要SSH、Git Credential或其他外部凭据时必须再引入显式Credential Provider，不能继承父进程秘密。

Pi外部Extension本质是任意本机代码，能绕过Tool白名单并读取进程秘密；当前`noExtensions=true`，只加载Chat内联Journal Extension。Project/Agent Skills和AGENTS上下文仍按Pi规则加载，但只能使用已批准工具。若要开放第三方Extension，必须先交付独立进程凭据隔离、固定来源/Hash和Extension Capability审核；不能把“完整AgentSession”偷换成无条件执行本地插件。

当前一个批准Step对应一个AgentSession。各Step仍按Approved Plan依赖顺序执行；依赖输出以只读输入传给下一Step。AgentSession不能修改Plan、Capability或Product终态。

## 4. 完整可观察事件

Chat内联Extension注册在`DefaultResourceLoader`中。以下Pi hook由AgentSession等待，因此Journal提交失败会阻止真实边界继续：

- `before_provider_request`：先保存请求序号和Payload Hash，再发Provider请求；
- `message_end`：保存消息角色、正文Hash、Stop Reason和Token Usage；Assistant可见文本经脱敏和32K上限后保存，隐藏推理不保存；
- `tool_call`：先耐久保存Tool名称、Call ID、参数Hash及脱敏/有界显示输入，再执行工具；
- `tool_result`：保存结果Hash、脱敏/有界显示结果、成功/失败和耗时；
- `turn_start/end`、`session_before_compact/session_compact`：保存Turn和Compaction边界。

Operation Journal事件有从1开始连续递增的`sequence`。Workflow按`afterSequence`轮询；发现序号缺口即进入`outcome_unknown`，不会用不完整Trace宣布成功。终态Snapshot只有在客户端取完终态前的全部事件后才可返回Candidate。

Chat Trace新增Operation、Session、Turn、Message、Tool、Compaction事件，并把多次Provider请求分别投影为既有`provider.request.*`事件。Trace保存原事件`sourceTimestamp`，同时保留Sink写入时间。

Trace和Operation事件不保存Prompt、Provider Payload、API Key或隐藏推理。为满足Pi CLI/Web同等级执行可观察性，它们保存经过边界脱敏且最多32K的Assistant可见文本、Tool输入和Tool结果；命令、模型可见文件路径、输出、状态与耗时因此可复核。完整Provider正文、Pi隐藏上下文和未裁剪Workspace内容仍分别留在Pi Session、Workspace与Product Store。旧v1 Trace没有显示字段时Reader继续兼容，并明确投影为legacy缺失，而不伪造内容。

### 4.1 DSH原生轨迹

API公开`GET /api/runs/:productRunId/execution-trace`。Application先用Product Store校验Principal对Run的访问权，再由Realtime Reader把内部Trace裁剪为无Runtime凭据的cursor页。LifeOS Adapter遇到新的Pi `tool_call`时向DSH流式发出确定性的`lifeos_trace`显示调用；该工具不重跑命令，只轮询同一`toolCallId`的真实结果。DSH Agent loop因此原生落下`tool/call`和`tool/result`，固定rc.6 Trajectory可以显示pending/running、输入、输出和耗时。Bridge v4状态只保存单调显示cursor，DSH Session仍不是产品事实或授权身份。

## 5. 故障与恢复

1. Executor收到Start后先原子提交`operation.accepted`，再异步启动AgentSession；Workflow连接断开不会取消运行。
2. 每次Tool执行前先原子提交`tool.intent_persisted`。进程重启发现未闭合Tool时，先追加`tool.outcome_unknown`，再把Operation收敛为`operation.outcome_unknown`。
3. 服务启动时不会自动重放`queued/running` Operation。读工具理论上可安全重跑，但`edit/write/bash`可能已生效；当前统一保守进入人工对账，避免猜测性重复副作用。
4. Provider自动重试在Executor专用Settings中关闭。Turn数、总Completion Token和总时限由Execution Contract冻结；越界形成稳定失败。
5. Product Commit仍使用稳定Command ID幂等重试，绝不因为提交失败再次调用Pi。
6. 正常关闭会停止接受HTTP、Abort活动AgentSession并等待Operation收敛；异常退出由下一次启动执行结果未知收敛。

## 6. 上游采用与退出路径

- 直接依赖固定npm `@earendil-works/pi-coding-agent@0.84.2`，使用公开`createAgentSession`、`DefaultResourceLoader`、`SessionManager`、`ModelRuntime`和Extension API。
- ModelRuntime直接读取Pi标准`models.json/auth.json`配置链；当前固定选择`dashscope-coding/qwen3.7-plus`并校验百炼HTTPS Host。命令型`apiKey`只在Pi Provider边界解析，Chat不读取、复制或持久化密钥明文。
- 本机`/Users/xulater/Code/opc-os/pi`只用于对应版本的源码、类型和测试证据；全新克隆与CI不依赖该绝对路径。
- 当前不需要修改Pi fork。若未来缺少通用awaited hook，只向Pi分支补通用观测接缝；Chat Product ID、权限和终态继续留在Chat Adapter。
- 替换Pi时保留Operation协议、Capability政策、Journal、Trace投影和Candidate Port，替换`AgentSessionPiCodingAgentRunner`即可。

## 7. 当前完成门

自动测试覆盖Operation幂等冲突、cursor事件完整性、脱敏显示证据、Tool未闭合的重启收敛、Service Client以及现有Workflow Candidate→Validation→Product Commit链。完整AgentSession真实百炼门`pnpm test:provider:bailian:coding`已于2026-08-18经用户明确授权通过：从Pi标准配置链调用`dashscope-coding/qwen3.7-plus`，在临时Workspace真实验证`read/write/bash`和连续Journal。`pnpm --filter @chat/dsh-web test:e2e:trajectory-real`同时通过真实rc.6 DSH Host/Session/Agent loop的intent先到、result后到和最终回复恢复。
