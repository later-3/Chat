# pi Agent Tool 使用与运行手册

## 1. 当前实现

Chat把pi coding agent作为同一Product Run中的受治理`ToolExecution`，由持续协作主Workflow
v1.8.0中的确定性Executor启动。它不是第二个用户Workflow，也不是把一条Shell命令当成“Tool成功”：

```text
用户在主Workflow中批准pi_readonly RunSpec
-> execution_route选择pi_readonly
-> pi_readonly_dispatch启动pi JSONL RPC子进程
-> pi准备Provider请求
-> Chat Provider Gate生成完整ModelCallDraft并暂停
-> 用户查看、修改、保存新Hash并批准
-> Chat按批准字节调用真实Provider
-> pi提出内部只读Tool调用
-> Chat按HITL策略自动继续或暂停
-> Chat-owned Tool Gateway执行read/grep/find/ls
-> 下一次Provider请求再次审批
-> pi完成，确定性Result Assembly核对Result Hash
-> Product Run、ToolExecution与最终消息提交终态
```

前端入口有2个：

1. 持续协作主Workflow的设计者工作台：查看执行路由、pi节点结果、模型/Tool子活动和治理事实。
2. `Tool -> pi coding agent`：配置Provider、模型、工作目录、内部Tool、Thinking、调用上限、超时和System Prompt，并查看执行统计。

旧`governed-pi-agent`只保留为不可选诊断/回归合同，不再要求用户切换根Workflow。

## 2. 为什么选择JSONL RPC

源码检出与运行基线统一为pi自定义分支提交`10e99ae9914cd34f622633fac42f9a90714e9cf4`、
`@earendil-works/pi-coding-agent 0.82.1`；Chat私有配置直接指向该源码树编译出的
`packages/coding-agent/dist/cli.js`。Node使用`--enable-source-maps`启动，因此可附加调试器进入
TypeScript源码；该提交基于官方`fdbedcad8aeb7c1e2ebd3b85f16e60e5fab0b2c3`，当前只新增独立
pi工作区的VS Code调试配置，没有修改`packages/**`运行时代码。全局安装包不再是Chat的运行入口。

| 接入方式 | 结论 | 原因 |
|---|---|---|
| 每次执行`pi -p` | 不采用 | 适合一次性文本输出，但跨多轮审批时必须反复重建进程和状态，难以关联结构化Tool事件 |
| 进程内TypeScript SDK | 不采用 | Python后端需要引入Node侧常驻服务和自定义RPC合同，增加第二套部署与升级边界 |
| pi官方JSONL RPC | 采用 | `rpc-entry.ts`、`rpc-mode.ts`和`rpc-types.ts`提供长期子进程、结构化命令、事件、用量和状态，能在一个pi回合内多次暂停/继续 |

当前实现通过显式Node路径启动pi的`dist/cli.js --mode rpc`，每次执行使用隔离的临时Agent目录、
模型配置和治理扩展；不会读取或改写用户全局pi配置。SD2同时使用`--no-builtin-tools`、
`--no-context-files`、`--no-skills`和`--no-prompt-templates`：

1. pi不能沿工作目录祖先隐式加载`AGENTS.md`或`CLAUDE.md`，避免越过已批准Repository Binding。
2. Project、Work、Plan、Context revision、治理规则与用户批准范围由Chat编译为有来源的StepInput。
3. 每个ToolExecution显式创建新的`chat-*` pi Session，保存在`~/.pi/agent/chat-sessions/`；终态
   冻结为只读，可由pi-web查看和导出。
4. 新执行从不选择或加载旧pi Session；保留转录不等于跨进程续跑、Workflow恢复或第二事实源。

## 3. 两道治理门

### 3.1 Provider Gate

pi的`before_provider_request`扩展事件不适合作为安全门。固定源码`core/extensions/runner.ts`会捕获该处理器异常并继续运行，因此不能提供“审批服务失败就绝不发送”的fail-closed保证。

Chat改用本机Provider网关：pi模型配置只指向Chat生成的短期本地网关地址；网关收到请求后创建正常的`ModelCallDraft`，绑定Provider、协议、完整Body和Hash。只有当前Approval批准后，网关才把同一份规范请求字节转发给真实Provider。每一次后续模型调用都会重新进入该门。

本机网关使用独立`X-Chat-Pi-Token`绑定当前进程内pi执行，不复用模型SDK的`Authorization`。后者
仍属于Provider认证语义，可能由pi配置或SDK生成、合并和替换；混用会让本机网关把有效执行误判为
401。网关保留规范化Bearer兼容路径，但独立Header一旦存在就不会降级绕过，比较采用常量时间函数，
日志只记录脱敏指纹与活动执行数。

### 3.2 Tool Gate

pi固定源码`core/agent-session.ts`和`core/extensions/runner.ts`在真实Tool执行前触发`tool_call`；
处理器可阻止调用，并允许修改参数。Chat为每个pi进程注入Custom Tool Extension；Extension只声明
`read/grep/find/ls`，真实读取通过短期Bearer令牌的本机Gateway回到Python后端。每次调用重新验证
Snapshot、路径、symlink、Protected Source和结果上限，pi的cwd和内置Tool不构成授权边界。

Tool名称只能来自服务端目录；前端不能输入`new_tool`或改名。低风险只读Tool默认可在HITL系统下限内
自动继续，用户仍可按作用域改成每次确认。SD2上限是6次模型调用、24次只读Tool、600秒和64KiB
单Tool结果；拒绝或放弃不会制造Tool成功或Assistant成功。

SD3在同一Gateway边界新增受管Execution Workspace中的单文件精确`edit`。每次编辑先形成不可变
Tool Operation和bounded diff，绑定路径、参数、Workspace、Snapshot及pre/post Hash；一次性授权
被消费后才能落盘。`write/bash/commit/push`仍不开放，活动仓库不会被直接修改。

## 4. 配置

pi的配置分成3层，三层解决的问题不同：

| 配置层 | 事实所有者 | 负责内容 | 生效方式 |
|---|---|---|---|
| pi RPC运行时 | 私有`backend/config.json` | Node/pi入口、合同版本、允许工作根目录、本机Gateway | 后端启动时读取；修改后重启 |
| Provider与模型目录 | 私有`backend/config.json` | Provider协议/地址/密钥、可选模型和模型能力 | 后端启动时读取；修改后重启 |
| pi Tool Profile | Product DB中的`pi_agent`配置Revision | 本次以后pi执行采用的Provider/模型、工作目录、Tool、Thinking、调用上限和总超时 | 在配置中心保存后，只影响随后创建的执行 |

这3层不能互相替代：Provider目录里存在K3，不等于pi已经选中K3；页面保存Tool Profile，也不能扩大
后端允许的工作根目录或凭空新增Provider。每个Product Run开始执行pi时会冻结Tool Profile Revision，
运行中再次修改配置不会偷换旧Run。

### 4.1 配置与运行文件路径速查

当前开发机上的实际路径如下。这里特意把“Chat调用的pi”和“个人终端里直接运行的pi”分开，避免改了
文件却没有影响目标运行环境：

| 文件或目录 | 当前路径 | 用途与修改方式 |
|---|---|---|
| Chat私有启动配置 | `/Users/xulater/Code/Chat/backend/config.json` | **Chat调用pi时真正读取的主配置文件**；`pi_agent`保存Node、源码、Session和调试路径，`providers`保存Provider、模型与密钥。权限为`0600`且被Git忽略，修改后必须重启后端。 |
| 脱敏配置样例 | `/Users/xulater/Code/Chat/backend/config.example.json` | 只用于查看字段结构和提交安全默认值；不含真实密钥，也不会覆盖私有配置。 |
| pi Tool Profile持久化 | `/Users/xulater/Code/Chat/backend/.data/chat.db`中的`tool_configurations`表、`id='pi_agent'`记录 | 保存前端配置中心里的Provider、模型、工作目录、Tool、Thinking和调用上限。应通过`配置 -> Tool -> pi coding agent`修改，不直接编辑SQLite。 |
| pi源码根目录 | `/Users/xulater/Code/opc-os/pi` | 自有pi分支的源码、构建和VS Code断点归属。 |
| Chat实际启动的pi入口 | `/Users/xulater/Code/opc-os/pi/packages/coding-agent/dist/cli.js` | 源码编译产物；由`backend/config.json`的`pi_agent.cli_path`固定，不能手改`dist`代替修改TypeScript源码。 |
| Chat专属pi Session | `/Users/xulater/.pi/agent/chat-sessions/` | 每次ToolExecution生成一个`chat-*` JSONL转录；供pi-web只读查看，不是配置文件。 |
| 单次执行临时Agent目录 | `${TMPDIR}/chat-pi-*/`，其中包含`models.json`和Chat治理扩展 | 后端启动pi子进程前动态生成，并通过`PI_CODING_AGENT_DIR`传给该进程；包含本轮本机Gateway投影和短期令牌，执行结束自动删除，不能作为人工配置入口。 |
| 个人终端pi配置 | `/Users/xulater/.pi/agent/settings.json`、`models.json`、`auth.json` | 只服务于个人直接运行的pi。Chat子进程使用隔离的临时`PI_CODING_AGENT_DIR`，不会读取或改写这3个个人文件。 |
| 项目级pi配置候选 | `/Users/xulater/Code/Chat/.pi/settings.json` | 当前不存在，也不是Chat产品的配置入口；不要为了配置Chat调用的pi而新建它。 |

按修改目的选择入口：新增Provider或换密钥，修改`backend/config.json`；调整以后新建pi执行的模型、Tool和
预算，在前端保存pi Tool Profile；调试或替换pi源码，修改pi仓库源码并重新构建；不要修改临时
`chat-pi-*`目录、Session JSONL或直接改Product DB。

### 4.2 pi RPC运行时

私有`backend/config.json`中的运行时配置使用以下结构；仓库中的脱敏样例位于`backend/config.example.json`：

```json
{
  "pi_agent": {
    "enabled": true,
    "contract_version": "0.82.1",
    "node_path": "/absolute/path/to/node-22-or-newer",
    "cli_path": "/absolute/path/to/pi/packages/coding-agent/dist/cli.js",
    "source_root": "/absolute/path/to/pi",
    "session_directory": "~/.pi/agent/chat-sessions",
    "node_debug_port": null,
    "node_debug_break": false,
    "allowed_working_roots": ["/absolute/path/to/allowed/projects"],
    "default_working_directory": "/absolute/path/to/allowed/projects",
    "gateway_origin": "http://127.0.0.1:8030"
  }
}
```

约束：

1. `node_path`和`cli_path`必须是后端可执行/可读取的绝对路径。
2. `contract_version`是运维固定并进入健康/统计投影的RPC合同版本；不能从失败后的CLI输出猜测。
3. 工作目录必须存在，并位于`allowed_working_roots`之一；前端不能扩大根目录。
4. `gateway_origin`只能是本机HTTP地址，避免把短期授权网关暴露为远程公共入口。
5. Provider密钥仍只来自服务端Provider配置，不传给浏览器，也不写入pi临时配置。
6. JSON运行配置是启动快照；修改后要重启后端。页面内Tool配置有独立Revision，只影响之后启动的Workflow。
7. `source_root`启用时，源码包版本必须与`contract_version`一致，且`cli_path`必须位于源码树内。
8. 调试时把`node_debug_port`设为`9230`；需要在第一行暂停则同时设`node_debug_break=true`。固定端口
   调试模式一次只允许1个活动pi执行。

### 4.3 源码构建与断点调试

源码调试采用两个独立VS Code窗口，不能在Chat工作区用跨仓`outFiles`代替pi源码窗口：

1. 在`/Users/xulater/Code/opc-os/pi`打开第一个VS Code窗口，先在需要的位置设置TypeScript断点，
   然后选择`Attach to Chat pi Runtime (9230)`。pi窗口会先执行自己的`npm run build:offline`，再等待
   最多300秒；Source Map、构建与断点均由pi仓库拥有。
2. 在`/Users/xulater/Code/Chat`打开第二个VS Code窗口，选择
   `Chat Full Stack (pi External Debug)`。Chat窗口只启动前后端并把私有`backend/config.json`中的
   两个调试字段临时设为`9230/true`，不编译pi，也不Attach外部源码。
3. 从Chat发起一条实际走`pi_readonly`或`pi_workspace`的执行。新pi子进程使用
   `--inspect-brk=127.0.0.1:9230`，在用户代码前暂停；pi窗口Attach后可按F5继续，随后命中已经设置的
   TypeScript断点。没有进入pi执行分支时，不会出现Inspector进程。
4. pi窗口的`outFiles`和Source Map根都使用自己的`${workspaceFolder}/packages/**`，不会依赖Chat窗口
   临时打开外部文件。
5. 停止Chat的外部调试组合后，后端`postDebugTask`自动恢复`node_debug_port=null`和
   `node_debug_break=false`；若调试器异常退出，可在Chat窗口手工运行`chat: disable pi source debug`。
6. 普通`Chat Full Stack`仍使用最近一次编译的同一pi源码产物，但会显式关闭Inspector，不负责重新
   编译pi，也不承诺命中pi断点。

`scripts/build-local-pi.sh`仍是Chat集成验证和单一分发脚本的底层入口：脚本优先按上游流程水合模型
目录；网络不可用时，只接受本机**同版本**0.82.1数据作为回退，然后执行上游`build:offline`。日常
源码断点调试则由pi仓库自己的VS Code Task负责。

这一双窗口入口允许以后修改自己的pi源码，同时保持pi仓库是独立代码库：先在pi内构建/测试，再由Chat的
Provider Gate、Tool Gate和端到端合同验证集成行为，不能用Chat测试替代pi自身测试。

本地开发使用“同一构建、三个隔离运行环境”。执行下面的命令会先编译源码，再让全局终端pi、
Chat和pi-web的4个SDK包都解析到同一源码树；它不会合并个人pi与Chat的配置、Session或权限：

```bash
./scripts/configure-local-pi-stack.sh link
./scripts/configure-local-pi-stack.sh restore
```

`link`不会把绝对`file:`路径写进pi-web的`package.json`或lockfile；pi-web重新安装npm依赖后再次运行
即可。切换完成后应重启pi-web服务，使Next.js进程加载新的SDK；有活动pi-web AgentSession时先等待
其结束，避免把一次个人交互中断。

### 4.4 Kimi K3 Provider与模型目录

Kimi Code通过官方OpenAI兼容端点`https://api.kimi.com/coding/v1`和模型ID`k3`接入，pi仍然只访问
Chat本机审批网关。Provider密钥只存在于权限`0600`的私有`backend/config.json`，仓库样例保持空值。
当前私有目录提供`kimi-code`和`kimi6603`两条配置相同、凭据独立的Kimi Code路由；`kimi6603`是用户
用于识别第二把Key的稳定Provider ID和显示名，不表示不同模型或不同协议。
这里的“Kimi Code”是API服务与Provider名称，**没有启动或嵌套Kimi Code CLI**；真正运行的编码Agent
仍是pi，Kimi K3只承担pi背后的模型推理。

当前K3模型合同如下：

| 参数 | 当前值 | 作用 |
|---|---|---|
| Provider ID | `kimi-code`或`kimi6603` | Tool Profile和运行记录使用的稳定标识；两者凭据独立 |
| 协议 | `openai_chat_completions` | 编译为`messages`并发送到Chat Completions端点 |
| Model ID | `k3` | Kimi Code官方模型标识 |
| Context Window | `1,048,576` | pi本地上下文预算上限 |
| 内容类型 | `user/assistant/system`均为纯文本 | K3上游支持多模态，但当前pi StepInput和受治理Tool链只验证了文本，因此先声明安全子集 |
| Reasoning | `true` | pi可以向K3投影Thinking等级 |
| `store` | 固定`false` | Provider不得保存响应；用户审批时看到完整显式上下文 |
| `stream` | 默认`true` | Provider流式返回，Chat继续持久记录公开事件 |
| `max_completion_tokens` | 默认/上限`131,072` | 单次模型输出上限，不表示每次都会消耗这么多Token |
| `reasoning_effort` | `none/low/high/max`，默认`high` | K3接受的思考强度枚举 |
| 未声明参数 | 拒绝 | `allow_unknown_parameters=false`，避免把未经验证参数发给Provider |

K3与pi Thinking等级不是同一套枚举，因此模型目录显式保存映射：`off -> none`、
`minimal/low -> low`、`medium/high -> high`、`xhigh -> max`。同时把K3的1,048,576 Context Window和
`max_completion_tokens`投影到pi临时`models.json`。如果省略映射，pi的`minimal`或`xhigh`可能成为
Kimi不接受的`reasoning_effort`；如果继续写死128K，则长上下文能力在进入Provider前已经被本地错误截断。

Kimi官方同时说明：K3的实际思考档是`low/high/max`；`none`会关闭Thinking，并可能把请求路由到
K2.6。因此当前Profile固定使用`medium -> high`以确保走K3。`off`只保留为跨Provider通用pi枚举，
不应作为K3执行配置；若用户确实要关闭Thinking，应把它理解为主动接受模型路由变化，而不是“K3无思考”。

Kimi要求兼容客户端保留真实客户端身份。Chat网关发送
`Chat-Pi-Gateway/1 pi-coding-agent/<contract-version>`，明确自己是Chat托管的pi，不伪装成Kimi CLI。
这些行为依据[Kimi Code文档](https://www.kimi.com/code/docs/)、
[模型说明](https://www.kimi.com/code/docs/kimi-code/models.html)和当前pi
`openai-completions.ts`/`model-registry.ts`合同实现。

### 4.5 当前生效的pi Tool Profile

2026-07-26当前Product DB中生效的是Revision 6：

| 参数 | 当前值 | 含义与边界 |
|---|---|---|
| 启用 | `true` | 允许主Workflow选择pi执行路由 |
| Provider / Model | `kimi-code / k3` | pi所有模型请求先到Chat审批网关，再转发K3 |
| 工作目录 | `/Users/xulater/Code/Chat` | pi进程的当前目录；不是授权边界 |
| 后端允许根目录 | `/Users/xulater/Code` | Tool目标必须留在该根内；RunSpec和Snapshot还会继续收窄 |
| Tool上限 | `read, grep, find, ls, edit` | `pi_readonly`只会得到前4项；`edit`只在受管Workspace和Operation审批后开放 |
| Thinking | `medium` | 对K3映射为`reasoning_effort=high`；兼顾编码质量与耗时 |
| 最大模型调用 | `12` | 一次pi执行的Provider总轮数上限，Tool结果后的后续调用也计数 |
| 总超时 | `900秒` | 从pi执行启动开始计算的总时限，不是单次Provider调用的独立900秒预算 |
| System Prompt | 受控编码Agent、只用已授权Tool、不得声称未验证结果完成 | 行为指导，不是权限授予；RunSpec、Provider Gate和Tool Gate仍是硬边界 |
| Provider Gate | 每次模型调用 | 每份真实Provider请求都生成独立ModelCallDraft和授权决定 |
| Tool Gate | 每次内部Tool调用 | 每次参数都重新校验；写操作还必须进入Operation Ledger |
| pi合同版本 | `0.82.1` | 与本地源码提交及其`dist/cli.js`构建产物绑定 |

这里的`allowed_tools`是能力上限，不是本轮一定可用的Tool集合。最终能力由
`后端能力上限 ∩ Tool Profile ∩ Workflow执行路由 ∩ 已批准RunSpec`决定，因此把Profile配置为包含
`edit`也不会让`pi_readonly`直接修改文件。

### 4.6 在前端使用和切换模型

正常使用路径：

1. 在顶部打开`配置`，进入`Tool`，选择`pi coding agent`。
2. Provider下拉按所需凭据选择`Kimi Code`或`kimi6603`；模型下拉只能从对应Provider目录选择
   `Kimi K3`，不能自由填写名称。
3. 按任务调整Thinking、最大模型调用次数、总超时、工作目录和允许Tool，然后保存。
4. 保存使用CAS Revision；若其他页面已经修改配置，服务端会拒绝旧Revision，刷新后再决定，不能静默覆盖。
5. 回到聊天，选择持续协作主Workflow并发送任务。意图和计划完成后，执行路由按RunSpec选择
   `answer_only`、`pi_readonly`或`pi_workspace`。
6. pi每次准备调用K3时，工作台都会出现模型调用审批；可读视图和Provider JSON来自同一Draft。
   修改任何实际请求内容都会生成新Revision/Hash并重新审批。
7. pi提出Tool调用时，查看Tool名称、参数、路径、风险和本轮权限；只读调用可按HITL策略自动推进，
   精确编辑必须在受管Workspace中形成Operation并经过对应授权。
8. 执行结束后，在Workflow运行视图或Tool执行记录中查看模型调用数、Tool调用、Token、耗时、结果Hash和失败代码；
   `metrics.pi_session.id`关联对应`chat-*`转录。
9. 打开pi-web可在Session列表看到`CHAT · 只读`标识，查看pi收到的Prompt、回复和Tool消息或导出；
   不能继续、Fork、重命名或删除该证据。

切换回其他模型时仍走同一路径。例如选择`DashScope / qwen3.7-plus`并保存后，**只有之后新建的pi执行**
使用Qwen；已经运行或完成的Product Run继续引用自己的配置Revision。Product Session顶部的“会话模型”
当前不会自动覆盖每个Workflow节点的Agent Profile，也不会替代这里的pi Tool模型选择。

### 4.7 新增Provider/模型和安全核对

新增模型时按`backend/config.example.json`的相同结构扩展私有`backend/config.json`：

1. Provider声明稳定`id`、协议、官方`base_url`、服务端密钥、默认模型和模型目录。
2. 模型声明`context_window`、是否Reasoning、pi Thinking映射，以及角色、内容类型和参数能力。
3. 不支持图片时显式把`content_types_by_role.user`设为`["text"]`；不能只写`image_input=false`后依赖通用默认值。
4. 重启后端，让Provider目录和pi Runtime取得同一启动快照。
5. 在配置中心的pi Tool Profile中选择新Provider/模型并保存；不要直接改Product DB。
6. 用下面的只读接口核对公开投影，不能打印私有配置文件：

```bash
curl -s http://127.0.0.1:8030/api/model-providers
curl -s http://127.0.0.1:8030/api/tools
```

| 修改项 | 是否重启后端 | 是否只影响新执行 |
|---|---:|---:|
| Node/pi路径、合同版本、允许工作根目录、Gateway | 是 | 是 |
| Provider地址、密钥、协议、模型和能力目录 | 是 | 是 |
| pi Tool的Provider/模型、Thinking、Tool、超时、System Prompt | 否 | 是 |
| 某次审批页里的Provider请求内容 | 否 | 只影响该ModelCallDraft新Revision |

密钥只保存在私有配置，不进入命令示例、文档、Trace、浏览器响应或Git。若密钥曾出现在聊天、终端输出
或其他不可控记录中，应在Provider控制台轮换，而不是依赖删除本地文字来恢复保密性。

## 5. 统计与恢复语义

每次执行写入`ToolExecution`记录，页面展示：

1. 配置Revision。
2. 模型调用数和内部Tool调用数。
3. 输入、输出、缓存读写Token。
4. Provider报告的成本（若Provider/pi事件提供）。
5. 总耗时、Tool事件和失败代码。

正常终态包括`已完成`、`失败`和`已放弃`。进程退出前未写终态的
`starting/running/waiting_human`记录会在下次启动收敛为`已中断 / process_restarted`，不会永久
显示假运行中。

当前增加了一层有界的在线恢复：只要后端进程和pi子进程仍然存活，即使AG-UI丢失线程级Workflow
缓存，MAF也会从持久Checkpoint重建Executor，再以`ToolExecution ID + Model/Tool Boundary ID`
重新挂接同一个Future或RPC请求。恢复不会创建第二个pi进程、第二次Provider发送或第二次Tool副作用。

这个保证不跨后端进程。Checkpoint只保存可序列化的稳定ID，不保存进程、Future或文件句柄；后端
重启后，启动对账仍把遗留`starting/running/waiting_human`收敛为
`已中断 / process_restarted`，不会自动重做模型调用或Tool调用。若同一进程中进程注册表意外丢失，
恢复失败会同时把Product Run收敛为中断、把ToolExecution收敛为失败，避免出现Run已失败但
ToolExecution仍假装等待用户的矛盾状态。

## 6. 验证

自动验证：

```bash
.venv/bin/python -m pytest backend/tests/test_pi_agent.py backend/tests/test_continuous_pi_readonly.py -q
(cd frontend && npm test && npm run typecheck && npm run build)
./scripts/verify.sh
```

自动化覆盖运行时请求草稿、真实Tool绑定、配置CAS、路径/symlink/Protected Source、64KiB结果、
精确Provider字节、Chat Completions Tool loop、两次模型审批、放弃无假成功、统计与三种非终态启动
中断收敛。主Workflow测试还会在模型审批、只读Tool审批、精确`edit`审批、第二次模型审批和后续
TurnDigest审批之间强制清除AG-UI Workflow缓存，证明每个Checkpoint都能重新挂接同一个在线pi；
另有进程注册缺失的失败关闭与双终态对账场景。

2026-07-25的主Workflow真实Dogfood使用现有私有Provider配置完成：Product Run
`58e48b4b-25fd-44b0-ac35-f099bbd8821a`产生2次模型审批、2次Chat-owned `read`，最终只读取
`README.md`与`PROJECT_STATE.md`；模型/Tool/Token/耗时、Result Hash和最终消息全部提交成功，
Repository没有Shell、文件写入或Git操作。桌面与520 CSS像素窄屏工作台均可查看节点结果和子活动，
控制台0错误。

同日使用Qwen完成另一轮主Workflow真实复验：Product Run
`8b9c72ab-f7c0-49eb-8c02-6bf8fef64e77`与ToolExecution
`85cd36e9-2303-435a-82ab-08b80bf53388`均成功；`qwen3.7-plus`经过3次逐次模型审批，实际调用
`find`与`read(offset=1, limit=1)`，读取`README.md`第一行`# Chat`并返回
`QWEN_PI_REAL_OK`。进程生命周期日志通过ToolExecution ID、进程ID和不可逆凭证指纹关联注册、
网关认证及注销，不记录原始凭据。

SD3首次真实写入复验暴露的HTTP 401来自Chat本机Gateway，已通过独立Header及自动回归修复。早期
Ark与DashScope响应流超时或断连的Product Run均保守收敛为`outcome_unknown`，没有创建Operation或
修改仓库，保留为安全失败证据。网络恢复后，DashScope `qwen3.7-plus`在干净Fixture完成完整Product
Run `0872f754-2751-4e18-948b-ce2a6c152b70`：pi执行唯一获批精确`edit`，Operation/Attempt、文件
前后Hash与Workspace Diff一致，源仓库保持干净。因此SD3真实隔离写入已经通过，但不外推为活动
仓库合入、Evidence完成门、`write/bash/commit/push`或pi跨进程恢复。

2026-07-26使用Kimi K3完成主Workflow真实只读复验：Product Run
`7118fe7a-992e-479f-ba18-c9ece68de108`与ToolExecution
`50487894-ac0e-4c54-a9e5-fa315efdac39`均成功。pi通过`kimi-code/k3`完成2次逐次审批的模型调用，
实际只执行1次`read(path=README.md, limit=20)`，记录4,385输入Token、635输出Token、3,328缓存读取
Token和84,729ms，并正确确认项目标题为`Chat`。运行前一次旧Repository Source复验被
`ContextSourceStale`在pi/K3发送前阻断；刷新正式Snapshot后新Run才允许继续，证明K3接入没有绕过
Source Freshness Guard。浏览器控制层当次受本地URL策略阻断，因此这里只声明API/AG-UI纵向闭环，
不新增视觉UI通过证据。

## 7. 已知边界

1. SD2只读模式只允许`read/grep/find/ls`；SD3隔离编辑模式额外允许受管worktree内的精确
   `edit`。`write/bash/commit/push`仍未开放。
2. 主Workflow能在同一后端进程内从持久Checkpoint重新挂接活动pi的Model/Tool边界；活动pi进程及
   其内存边界仍不能跨后端进程恢复。
3. 当前每个pi执行使用独立子进程，不提供跨Product Run共享pi Session。
4. 真实Provider的计费和Token口径以Provider/pi事件为准；缺失字段显示0，不推测成本。
5. 当前pi不自动加载工作目录及祖先的`AGENTS.md`/`CLAUDE.md`；主Workflow只传递批准的Harness
   StepInput。SD3的Execution Workspace与Tool Operation Ledger仍不能替代Evidence完成门。
