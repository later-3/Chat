# Pi Coding Executor Service As-built

> 日期：2026-08-23
>
> 运行来源：`later-3/pi@codex/later-custom`；包内上游基线为`pi-coding-agent`、`pi-agent-core`、`pi-ai` `0.84.2`
> 产品事实源：Chat Product Store；Pi Operation、Pi Session和Tool Journal都不是产品终态。

## 1. 结论

Chat不再用单轮`pi-agent-core + submit_execution_result`模拟Executor。批准后的每个Execution Step由独立`apps/pi-executor`进程中的真实`AgentSession`执行，具备Pi的多轮Provider/Tool loop、Session JSONL、Compaction能力以及`read/grep/find/ls/edit/write/bash`内建工具。Planning Execution Step继续按批准的Execution Contract显式隔离Pi自动资源；Direct的`pi_cli_default`则直接继承真实Pi CLI的System、初始Tools与资源发现。两者都只接收Application授权并冻结的Chat输入。

没有使用`pi` CLI做进程协议，也没有采用仍缺少operation幂等、cursor replay和Tool执行前栅栏的实验性`pi-server`。集成面是Chat拥有的窄HTTP Operation协议；Pi由`later-3/pi`受管分支维护通用运行接缝，Chat产品身份和终态仍不写入Pi源码。

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

Pi外部Extension本质是任意本机代码，能绕过Tool白名单并读取进程秘密。Planning Coding Executor当前设置`noExtensions/noContextFiles/noSkills/noPromptTemplates=true`，只加载Chat内联Journal Extension，避免已批准Contract之外的能力进入执行。Direct的`pi_cli_default`不设置这些`no*`开关，也不传显式Tools；它与真实Pi CLI走同一公共服务构造路径。用户需要限制Direct时，必须选择或创建不可变AgentVersion，由版本精确冻结System、Tool子集和四类资源开关。

两条路径都由Pi Executor从真实AgentSession投影System与Tool Schema，再通过带Runtime Key的私有只读接口交给API的Agent设置；API与Workflow不加载完整Pi Coding Agent，也不在Prompt Catalog中手抄上游内容。Agent Profile Query可携带受权`workspaceRootId`，Executor内部才把它解析为canonical cwd；全局与scoped投影都不跨请求缓存。Planning路径的真实System顺序是`Pi按批准Tools/cwd生成的默认基线 → Chat固定Executor运行约束 → Application冻结的Agent/Workflow/Run追加层`；Direct默认路径保持Pi Runtime默认，再合入Chat正式会话上下文。真正的逐字节结果仍以Provider前Prompt Review为准。若要让Planning Executor开放第三方Extension或自动发现，必须先交付独立进程凭据隔离、固定来源/Hash和Capability审核。

当前一个批准Step对应一个AgentSession。各Step仍按Approved Plan依赖顺序执行；依赖输出以只读输入传给下一Step。AgentSession不能修改Plan、Capability或Product终态。

## 4. 完整可观察事件

Chat内联Extension注册在`DefaultResourceLoader`中。执行前的`tool_call` hook失败会传播回Agent loop并阻止真实Tool边界；
固定Pi `0.84.2`会捕获`before_provider_request`、`tool_result`、`message_end`、Turn与Compaction等其他handler异常并继续。
因此除Tool Intent外的当前Journal只能作为观察证据，不能作为fail-closed授权栅栏，也不能保证限额或Journal失败时一定阻止请求。
受管Pi Fork已经提供Extension链外、异常直接阻断Provider fetch的`providerRequestGate`，Direct Operation用它实现逐请求审核、一次性派发许可和等待态恢复；当前交互与组装事实见[Prompt Studio](./prompt-studio-as-built.md)。Planning Executor原有事件仍保持以下观察语义，不能因Direct Gate已经交付而把旧hook描述成安全栅栏：

- `before_provider_request`：当前先尝试保存请求序号和Payload Hash；该hook异常会被上游吞掉，不能据此宣称请求一定被阻止；
- `message_end`：保存消息角色、正文Hash、Stop Reason和Token Usage；Assistant可见文本经脱敏和32K上限后保存，隐藏推理不保存；
- `tool_call`：先耐久保存Tool名称、Call ID、参数Hash及脱敏/有界显示输入，再执行工具；
- `tool_result`：尝试保存结果Hash、脱敏/有界显示结果、成功/失败和耗时；handler失败会被上游吞掉；
- `turn_start/end`、`session_before_compact/session_compact`：保存Turn和Compaction边界。

Operation Journal中已经成功持久化的事件使用从1开始连续递增的`sequence`。Workflow按`afterSequence`轮询；
发现传输或读取造成的序号缺口会进入`outcome_unknown`。但被Extension Runner吞掉的handler写入失败不会占用sequence，
所以不能依靠序号缺口发现这类缺失事件。Executor因此在内存与耐久Journal两侧同时保留未闭合Tool：
`tool_result`只有在`tool.completed/tool.failed`成功追加后才删除内存Intent；即使上游吞掉该handler异常，
Operation终态提交仍会重新读取耐久Journal。发现任一`tool.intent_persisted`没有闭合事件时，`complete()`先耐久追加
`tool.outcome_unknown`和`operation.outcome_unknown`，再以稳定`executor.tool_result_persist_failed`拒绝成功；随后普通
失败处理不能把它降级成`failed`。同一Operation内的`toolCallId`是Intent身份而不是可复用槽位：Tool Intent必须先耐久追加成功，随后才能写入内存Result关联；第二次持久化同一ID会以
`executor.tool_call_id_reused`在真实Tool前失败，不能覆盖首个Intent的内存元数据。固定Pi会把`beforeToolCall`异常转换为普通Tool Error并继续loop，因此Executor另有不可恢复fatal latch；发送候选前必须把Operation耐久收敛为同一错误码的`outcome_unknown`。Tool Result必须与唯一开放Intent的`sessionId / turnIndex / toolCallId / toolName / inputSha256`全部相等，旧Result不能借同名ID闭合另一个Intent。Operation一旦进入
`succeeded / failed / outcome_unknown`任一终态就保持单调；迟到的`complete()`只能幂等读取既有成功，或以稳定冲突拒绝，
不能把未知/失败改写为成功。重启扫描复用同一闭合逻辑，重复启动不会追加第二组未知事件。

唯一的`validatePiExecutorOperationJournal`同时供Store append后的原子持久化、Store启动扫描与Executor Client终态消费使用；它为`queued / running / succeeded / failed / outcome_unknown`定义完整合法矩阵，并验证文件名（Store边界）、Record/Request/全部Event Operation身份、真实Request Hash、连续sequence、非倒退时间、Session/Turn/Provider/Compaction/Tool身份与顺序、唯一terminal及Record字段组合。Assistant Evidence只允许发生在活动Turn与对应活动Provider内；Provider关闭、Turn完成或Session settled后出现Assistant都失败关闭。`succeeded`还要求Result正文按Execution Contract确定性投影，真实Result Hash同时匹配Record与`operation.completed`；攻击者不能通过同步伪造Result和自身Hash绕过耐久执行证据。

Journal代际的optional字段矩阵如下；“可缺省”只服务首次即没有v2标记的真正历史v1，字段一旦存在仍必须匹配对应Intent/正文：

| 合同字段/证据 | 旧v1只读兼容 | `full-operation.v2` |
|---|---|---|
| Snapshot `integrityVersion` | 首次缺省，并在本次Client消费中始终缺省 | 首次为`full-operation.v2`，后续Snapshot必须逐次相同 |
| Snapshot完整`request` | 可缺省，Client使用本次提交请求验证身份 | 每个Snapshot都必须存在且Hash精确匹配 |
| `tool.completed.inputSha256` | 可缺省；存在时匹配唯一Intent | 必须存在并匹配唯一Intent |
| `tool.failed.inputSha256` | 可缺省；存在时匹配唯一Intent | 必须存在并匹配唯一Intent |
| `provider.failed.inputSha256` | 可缺省；存在时匹配`provider.started` | 必须存在并匹配`provider.started` |
| `session.settled` | 历史成功记录可缺省 | 成功记录必须唯一存在，且在Turn/Provider关闭之后 |
| 最终Assistant `visibleTextSha256` | 可缺省；存在时匹配Candidate正文 | 必须存在并匹配Candidate正文 |

新Operation写入`full-operation.v2`完整性标记，并按`provider.started → assistant message.completed → provider.completed/failed → turn.completed → session.settled → operation.completed`闭合成功证据。Executor Client把首次Start Snapshot的`integrityVersion`钉为不可变化身份；v2后续删除标记、完整Request或必需证据不能借用v1矩阵，会以`executor.journal_integrity_invalid`和`outcomeUnknown=true`失败关闭，绝不返回Candidate。旧v1虽可缺少上表新证据，但Request、Operation、Session、Turn/Provider因果顺序、terminal、Result与Tool身份从不降级。Store遇到矛盾旧记录同样拒绝启动。所有新追加Tool Result仍必须携带真实输入Hash并通过五字段精确匹配，兼容读取不能放宽写入门。

新Result的第五字段来自固定Pi `tool_result`事件携带的真实`input`重新Canonical Hash，而不是复制内存Intent Hash；真实输入与Intent不等时先触发fatal latch，再把Operation耐久收敛为`executor.tool_result_intent_mismatch / outcome_unknown`。

只有耐久状态为`succeeded`、Workflow客户端已经连续读取全部事件且共享完整状态机Validator通过时才返回Candidate。`outcome_unknown`没有Candidate，
因而不能进入Validation或Product Commit。正式fail-closed保证由Provider Gate、执行前Tool Intent栅栏以及上述终态耐久
复核共同构成。

Pi Operation Journal事件会投影到独立Run Activity Journal；Debug Trace可同时保存诊断事件，但公开Session轨迹不再反向读取Trace。

Direct Operation还在首次真实`bindExtensions`后钉住Resolved Runtime Manifest SHA，内容覆盖System Hash、活动Tool名称/Schema Hash和资源清单Hash。恢复必须命中同一个SHA；不一致时在Provider前收敛为`direct_executor.runtime_manifest_mismatch`。P0修复前的旧Operation若完全没有该证据，只允许在首次恢复时补钉一次。

绑定AgentVersion的新Direct Assembly还冻结Run创建时的scoped Runtime Profile Hash和Workspace Root Grant Hash。API在每次Operation授权时重新读取实时Profile并比较；Executor随后把Root Grant与实际canonical cwd比较，再进入Runner。绝对路径不进入Product Store、Operation或公开API。这一门处理Run创建后、首个AgentSession之前的Settings/Extension/Tool/资源或Root映射漂移；Resolved Runtime Manifest继续处理Session绑定后的实际清单及审核恢复漂移。

Trace和Operation事件不保存Prompt、Provider Payload、API Key或隐藏推理。为满足Pi CLI/Web同等级执行可观察性，它们保存经过边界脱敏且最多32K的Assistant可见文本、Tool输入和Tool结果；命令、模型可见文件路径、输出、状态与耗时因此可复核。完整Provider正文、Pi隐藏上下文和未裁剪Workspace内容仍分别留在Pi Session、Workspace与Product Store。旧v1 Trace没有显示字段时Reader继续兼容，并明确投影为legacy缺失，而不伪造内容。

### 4.1 DSH原生轨迹

API的轨迹Query读取Product事实、Run Activity与Workflow Runtime证据。Bridge通过DSH公开Conversation contribution
把远端Pi活动显示为Workflow树，但不把它伪造成DSH实际执行的工具调用。原生Pi Session/Operation Journal继续拥有
完整执行与恢复证据，DSH Session只记录DSH真正执行的事件。详见[Session与轨迹架构](./session-architecture.md)。

## 5. 故障与恢复

1. Executor收到Start后先原子提交`operation.accepted`，再异步启动AgentSession；Workflow连接断开不会取消运行。
2. 每次Tool执行前先原子提交`tool.intent_persisted`，成功后才更新内存Map；同一Operation重复`toolCallId`在真实Tool前被拒绝，并由fatal latch穿透真实AgentSession的普通Tool Error恢复。进程重启发现未闭合Tool时，先追加`tool.outcome_unknown`，再把Operation收敛为`operation.outcome_unknown`。
3. Tool Result只有与耐久Intent五字段精确匹配时才能闭合；持久化失败或匹配冲突时，即使Agent loop继续返回，Operation也不能提交成功。同一进程终态检查与重启恢复都会保守收敛为结果未知，且迟到的`fail()`或`complete()`都不能覆盖已有终态。
4. 服务启动时先扫描Operation事件Hash、身份和状态顺序；矛盾的历史`succeeded`记录直接拒绝启动。随后也不会自动重放`queued/running` Operation。读工具理论上可安全重跑，但`edit/write/bash`可能已生效；当前统一保守进入人工对账，避免猜测性重复副作用。
5. Provider自动重试在Executor专用Settings中关闭。Turn数、总Completion Token和总时限由Execution Contract冻结；越界形成稳定失败。
6. Product Commit仍使用稳定Command ID幂等重试，绝不因为提交失败再次调用Pi。
7. 正常关闭会停止接受HTTP、Abort活动AgentSession并等待Operation收敛；异常退出由下一次启动执行结果未知收敛。

Direct Operation另有一条更窄的恢复政策：`preparing_prompt_review/waiting_prompt_review`尚未越过Provider边界，
可以从审核前checkpoint恢复同一未完成Turn；`dispatching`重启一律收敛为`outcome_unknown`。批准正文只由Application
一次性交付，重放返回`already_claimed`且不再返回正文。

## 6. 上游采用与退出路径

- 当前直接链接`later-3/pi`的稳定集成分支`codex/later-custom`下`packages/agent`、`packages/ai`和`packages/coding-agent`源码构建；三者来自同一个Fork工作树，包内上游基线仍为`0.84.2`。Fork公开`providerRequestGate`、`resumePendingTurn()`和运行时能力标记，其余继续使用`createAgentSession`、`DefaultResourceLoader`、`SessionManager`、`ModelRuntime`和Extension API。
- ModelRuntime直接读取Pi标准`models.json/auth.json`配置链；当前固定选择`dashscope-coding/qwen3.7-plus`并校验百炼HTTPS Host。命令型`apiKey`只在Pi Provider边界解析，Chat不读取、复制或持久化密钥明文。
- Pi源码权威维护面是公开`later-3/pi`的`codex/later-custom`及功能分支；官方remote只读。Chat本地开发按根`AGENTS.md`登记的同级checkout直接链接稳定分支，启动时验证能力标记。
- 两个窄接缝都保持通用：Gate只传最终Payload/Model并传播拒绝，Resume只恢复AgentSession生命周期；Pi Fork不包含Chat Product ID、审核、权限或UI，Chat仓库不再维护等价Pi patch。
- 替换Pi时保留Operation协议、Capability政策、Journal、Trace投影和Candidate Port，替换`AgentSessionPiCodingAgentRunner`即可。

## 7. 当前完成门

自动测试覆盖Operation幂等冲突、cursor事件完整性、脱敏显示证据、Tool未闭合的重启收敛、Service Client以及现有Workflow Candidate→Validation→Product Commit链。完整AgentSession真实百炼门`pnpm test:provider:bailian:coding`已于2026-08-18经用户明确授权通过：从Pi标准配置链调用`dashscope-coding/qwen3.7-plus`，在临时Workspace真实验证`read/write/bash`和连续Journal。`pnpm --filter @chat/dsh-web test:e2e:trajectory-real`同时通过真实rc.6 DSH Host/Session/Agent loop的intent先到、result后到和最终回复恢复。
