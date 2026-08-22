# Prompt Studio 与系统级 Prompt Assembly As-built

> 状态：会话Prompt管理、独立Agent Profile、Workflow节点Agent配置与本次Session/Run临时覆盖、全局/Workspace Markdown版本、统一发送前完整Prompt预览、DSH→Bridge与Bridge→Chat调试审核、Workflow Prompt Assembly v3、Direct Prompt Assembly v2、近期正式会话历史和Direct Provider前逐次审核均已打通。完整Agent版本管理的唯一事实源见[Chat Agent管理](./agent-management-as-built.md)；Provider逐请求人工审核仍只由Direct节点开放。

## 1. 用户结果

1. DSH「设置 → 提示词」是会话/项目上下文的长期管理面。它展示Context Region、Git内置Markdown与来源，支持创建全局或指定Workspace的组件、派生副本、追加不可变Revision、归档与恢复；它不管理Agent身份。
2. 每个会话的Composer配置栏有「本次 Prompt」统一入口。发送前在全局与当前Workspace两个Scope中选择会话上下文Revision；同一面板的完整预览同时展示当前Workflow每个Agent节点的有效System Prompt、Runtime固定层、Tools和当前User输入。Workflow配置仍由Workflow入口管理，不把“生成计划/执行计划”伪装成Prompt区域。
3. 「提示词配置预览」只回答当前会话Region怎样组成；「预览完整 Prompt」调用`POST /api/prompt-turn-previews`，与正式Submit Message共用Application的Workflow预编译和Prompt编译路径，再附加DSH请求与Bridge→Chat命令映射。它是只读预发送模型，不创建Session、Message、Run或执行授权，也不是最终Provider请求。
4. Composer的「调试审核」面板有两个独立开关：DSH→Bridge审核真实`GenerateOptions`；Bridge→Chat审核筛选后将实际交给`fetch`的完整Command Plan。两项关闭时自动发送；开启时必须依序批准。第二道批准前Chat Session/Message写入数为零。
5. Message Command在创建Run的同一事务中冻结Prompt Assembly：Pi-backed节点明确冻结`piSystemPrompt=inherit|replace`；`inherit`由Pi使用自己的默认动态System，`replace`把用户/Workflow/Run选出的完整正文作为Pi `customPrompt`。只有显式受限或专用Workflow声明的Chat Runtime Contract才会追加，本轮会话上下文则按Assembly继续进入System。Direct v2另冻结正式Messages、Tool选择模式、资源策略和Request Options；多节点Workflow用v3冻结每个节点的同一解析结果。配置随后被修改、归档或页面刷新，都不能改变该Run。
6. Planner、Coding Executor与Note Extractor只接收Application从同一冻结v3 Assembly授权出的节点Prompt；节点Hash进入Planning/Execution Input Manifest，不从当前Bridge草稿或文件重新推导。
7. Pi Agent仍负责单次节点内的Agent/Tool Loop。Direct的`pi_cli_default`直接继承Pi真实Context Files、Skills、Prompt Templates与Extensions发现；用户派生的受限Version可逐项关闭。Planning Coding Executor仍按已批准Execution Contract隔离这些自动来源；显式选择的Chat会话Prompt组件继续由Prompt Assembly进入请求。
8. Direct Provider Gate在每次真实模型请求前暂停。Raw是Provider Adapter将发送的Canonical Payload；Friendly只增加来源、区域、Revision、Hash、Scope和JSON Pointer，不添加模型可见正文。Planner、Executor与Note当前使用已冻结Prompt，但没有新增Provider人工审核语义。
9. 前端提供三层Chat配置：DSH「设置 → Agent」为已经完成执行消费纵向的Direct Agent管理Principal不可变AgentVersion；Workflow配置页精确绑定Version ID/Hash；发送前还可为当前DSH Session形成结构化临时配置，并在每次Run创建时冻结。选择Workspace Scope或打开会话配置时，页面按受权`workspaceRootId`重新读取Pi Settings、Extension、Tool与资源目录。Pi-backed Agent的无覆盖默认值直接引用Pi真实运行时基线，不复制成Chat Fragment；自定义正文完整替换Pi基础System，Tools精确冻结，四类资源当前按类别继承或关闭。Project Bootstrap、Coding Executor等未完成逐字段Version消费的Agent只读显示真实基线，不提供假保存入口。系统Workflow保存时派生个人版本，个人Workflow保存时原子发布下一Revision；任何Prompt文字都不能增加Tool或Workspace授权。
10. DSH→Bridge、Bridge→Chat和Direct Provider Prompt Review不再挤在Composer卡片里；三者复用右侧全高审查面板。只有中间正文区域纵向滚动，标题/状态和决定操作固定，Raw与易读正文不再制造第二个纵向滚动区。

## 2. 事实所有权

```text
prompts/catalog.json + prompts/**/*.md
  └── Git PromptCatalog（内置组件唯一事实源，只读）

<Chat>/.data/prompts/global/**/*.md
<Workspace>/.chat/prompts/**/*.md
  └── 用户Prompt正文与人可读版本文件

Product Store v18
  ├── PromptFragment（owner/scope/status/current/CAS）
  ├── PromptFragmentRevision（不可变元数据、内容Hash、MD路径/文件Hash）
  ├── AgentVersion（完整配置、Scope、来源版本与Hash，不可变）
  ├── Workflow Definition/Revision（节点精确AgentVersion引用与兼容Prompt差异）
  └── PromptAssembly（一次Run冻结的有效Agent Prompt与会话上下文投影、来源、版本、预算与Hash）

DSH Bridge State v12
  └── 每个DSH Session的未发送选择草稿、两个调试审核开关与请求冻结引用

Bridge进程内Review Coordinator
  └── 两道调试审核的Raw正文与决定等待；关闭/重启不把正文变成长期事实

PromptReviewRequest
  └── 一次真实待发Provider Payload；Workflow/Trace/Pi Journal只保存Ref/Hash
```

Git 内置组件不复制进 Product Store。用户组件正文不隐藏在 Product Store JSON：全局版本位于 Chat 的`.data/prompts/global`，Workspace版本位于对应根的`.chat/prompts`。Product Store只拥有身份、权限、版本链、Scope、Hash、文件引用及每次运行的冻结证据。

## 3. Catalog、Workspace 与文件边界

- Manifest：`prompts/catalog.json`
- Region说明：`prompts/regions/catalog.md`
- 内置正文：`prompts/fragments/**/*.md`
- Catalog Adapter：`apps/api/src/prompt-catalog.ts`
- 用户文件 Adapter：`apps/api/src/prompt-file-library.ts`

Catalog Adapter从`import.meta.url`推导仓库根，拒绝绝对路径、`..`、越界symlink、缺失文件、重复ID/Region/Order和SHA-256漂移。

Bridge按`CHAT_PROJECT_ROOTS_JSON`把DSH当前打开目录映射为Chat `rootId`。平台Chat根的精确`AGENTS.md`投影为全局`workspace_instructions`组件；目标Workspace根的精确`AGENTS.md`只在该Scope可见。系统不递归发现父级、子目录或其他Agent文件，也不自动选择这些组件。

本机“打开文件”能力支持白名单应用，并重新校验文件必须属于以下边界之一：Git Catalog、Chat全局Prompt目录、当前登记Workspace的`AGENTS.md`或`.chat/prompts`、Chat `pi-runtime/src`，以及受管Pi Fork的`coding-agent/src/core` TypeScript源码。Agent设置按真实构造来源逐文件展示，优先提供“用 VS Code 打开”，不会把由多个文件生成的Pi System Prompt伪装成单一配置文件。

服务器模式可以装配同一Host能力，但HTTP边界只向精确loopback Host/Origin投影可用应用；公开域名请求固定得到空应用列表，打开命令固定拒绝。这样同一台Mac通过`127.0.0.1`使用VS Code时不被公开域名配置误伤，远端浏览器仍不能启动服务器本机应用。

## 4. Product Store、Markdown版本与并发

迁移链：

- `v13 → v14`：新增 Prompt Fragment 与 Revision；
- `v14 → v15`：新增 Scope 与 Direct Prompt Assembly v1；
- `v15 → v16`：用户新Revision改为Markdown内容引用，Direct Assembly升级为四路输入v2；
- `v16 → v17`：补齐项目初始化相关事实集合；
- `v17 → v18`：新增不可变AgentVersion集合，并发布继承Pi CLI默认能力的Direct Workflow v2；历史只读Workflow Revision/View继续保留。

历史v1用户正文仍可读取；首次读取时会生成一个可见的兼容Markdown文件，之后继续通过同一文件Port访问。历史Direct Run保留原Assembly语义，迁移不会把当时不存在的选择伪造成新上下文。

Revision规则：

- 版本号从1连续递增；
- 第2版起绑定上一版ID/Hash；
- Aggregate current必须指向最高版；
- 内容文件发布后不可变，正文Hash、文件Hash和Product Revision互相校验；
- 归档后不能revise，restore只改变Aggregate状态；
- 同一Command原样重放返回原结果，不同正文复用Command ID失败关闭；
- 文件先落为不可变候选，Product事务失败时它只是未被引用的文件，不会成为产品事实。

## 5. DSH 与公开API

公开Queries：

- `GET /api/prompt-regions`
- `GET /api/prompt-fragments`
- `GET /api/prompt-fragments/:promptFragmentId`
- `GET /api/prompt-fragment-revisions/:promptFragmentRevisionId`
- `GET /api/prompt-workspaces`
- `GET /api/agent-profiles`
- `GET /api/agent-profiles/:agentKey`

两个 Agent Query 都只接受可选的`workspaceRootId`；无参数读取全局空 Workspace 基线，带参数则先校验 Root 授权，再由 Pi Executor 读取该 canonical Workspace 的真实目录。未知、重复或未授权 Root 均失败关闭。

公开Commands：

- `POST /api/prompt-fragments`
- `POST /api/prompt-fragments/copies`
- `POST /api/prompt-fragments/:promptFragmentId/revisions`
- `POST /api/prompt-fragments/:promptFragmentId/archive-status`
- `POST /api/prompt-configuration-previews`
- `POST /api/prompt-assembly-previews`
- `POST /api/prompt-turn-previews`
- `POST /api/agent-profiles/:agentKey/prompt-revisions`
- `POST /api/agent-profiles/:agentKey/restore-default`
- `POST /api/agent-profiles/:agentKey/versions`

Prompt Studio与Composer都通过`packages/dsh-lifeos-bridge`访问Chat公开Query/Command；浏览器不扫描本机目录、不提交权威路径、不直接调用Workflow或Pi。

DSH同源路由保存会话选择：

```text
PromptComposer（读取DSH真实input.draft）
→ GET/PUT /lifeos/sessions/:id/prompt-selection
→ Bridge按DSH Session保存草稿并在请求时冻结
→ Submit Message只携带会话上下文选择
→ Application读取Workflow节点绑定的Agent Profile和会话Revision并冻结Assembly
```

Workflow Agent配置走独立公开命令：

```text
前端Workflow配置页
→ POST /lifeos/workflow/agent-node-configurations
→ Bridge只校验、代理Chat Command并返回公开投影
→ Application在一个事务中派生个人Workflow或发布个人Workflow下一Revision
```

DSH发送审核使用实际Adapter入口捕获的完整可序列化`GenerateOptions`。Bridge出口审核由同一个冻结Dispatch Builder生成审核`bodyJson`和实际`fetch body`，确定性测试逐字节证明两者相同；首次会话的Plan包含Create Session与Submit Message两条HTTP操作，已有会话只有Submit。Trace只记录整体Hash、JSON Pointer值Hash/长度及DSH User文本到Bridge Payload的映射；正文不进入日志。两端文本Hash不一致时，在Chat写入前以`lifeos_dsh_raw_mapping_mismatch`失败关闭。

## 6. 系统级组装与覆盖规则

一次Workflow运行中的有效Agent配置先按以下顺序解析：

```text
本次Run冻结的Session临时agent_configuration
  > Workflow Revision精确绑定的AgentVersion ID + Hash
  > Agent Catalog / Pi Runtime默认
```

`global/workspace`是Version的授权Scope，不是自动合并层。解析完成后，最终节点提示词按以下顺序组成：

```text
1. 当前节点若声明专用Chat Runtime Contract，则先加入该不可覆盖层
2. 节点有效Agent Prompt（Workflow/Run有差异时替换Agent默认，否则继承Agent Profile）
3. 会话上下文Prompt选择
4. 当前消息、正式历史、节点输入、Tools与Request Options
```

`default / replace / append`只作用于会话上下文中的同一个用户可管理Region。AgentVersion则是System Prompt、Tools和资源策略的完整不可变配置；空绑定表示继承Catalog/Runtime默认，不存在通用多重继承框架。最终有效值在Run创建事务中冻结。它不能替换Runtime Contract、Workspace授权、结构化输出Schema、审批、预算、安全和Product事实所有权。

默认共享组合不再写死在Bridge或Application代码中，而由`prompts/catalog.json#sharedSelectionProfile`版本化并进入Catalog Hash。前端提交的是精确Revision ID/Hash和层级意图；Bridge只冻结、预览和转发，Application重新鉴权并编译。Workflow v3一次保存全部相关节点的有效结果，运行时只按`definitionNodeId + nodeType`取出对应节点，不允许Pi自行发现另一套Prompt来源。

当前Prompt-bearing节点为：

| 节点类型 | 锁定Profile | 用户层来源 |
|---|---|---|
| `agent.plan` | `planner-prompt.v3` | Planner默认或节点/Run差异 + 会话上下文 |
| `agent.direct` | `direct-agent-prompt.v1` | Direct/Project Bootstrap默认或节点/Run差异 + 会话上下文 |
| `execute.plan` | `executor-coding-agent-prompt.v1` | Coding Executor默认或节点/Run差异 + 会话上下文 |
| `note.extract` | `note-capture.v1` | Note Extractor默认或节点/Run差异 + 会话上下文 |

### 6.1 Direct Prompt Assembly v2

Direct固定Profile为：

```text
direct-agent-prompt-profile.v2
├── Instructions / System
│   ├── Pi动态默认基础System，或Chat用户选择的完整替换
│   ├── 只读/项目初始化等专用变体声明的Chat运行约束（默认Pi CLI无此层）
│   └── 用户按Region选入的命名Markdown段
├── Messages
│   ├── 近期成功Product Run提交的user/assistant对
│   └── 当前Product Message（原样role:user）
├── Tools / Resources
│   ├── pi_cli_default：完成Extension绑定后由真实Pi AgentSession决定；当前默认启用read/bash/edit/write，可选内置目录另含grep/find/ls
│   └── 派生Version：精确Tool子集与四类资源开关
├── Request Options
│   ├── pi_cli_default：沿用当前冻结的Pi默认执行选项
│   └── 受限变体：按对应运行合同冻结
└── Manifest（模型不可见）
    └── 来源、Revision、Scope、顺序、采用/排除原因、预算与Hash
```

用户管理的所有活动语义Region在Direct v2中都编译成带稳定标题的System追加段。`AGENTS.md`不是特殊旁路：它是`workspace_instructions` Region中的一个可选Markdown组件，选中时正文进入System，未选中时不会被Pi发现。

历史只选择已形成正式Assistant Message的成功`User → Assistant`对，按最近优先、完整成对地加入；失败、取消、`outcome_unknown`或没有正式Assistant结果的User Message不自动重放。当前输入永远是最后一条原始User Message，不加`<history>`等伪文本包装。

v2使用确定性首版预算：总输入上限64,000估算Token，固定为Tool Schema预留8,000；文本估算器为`ceil(UTF-8 bytes / 3)`。必需System与当前User超限时在Provider前失败；可选历史从旧到新稳定排除并在Manifest记录原因。Pi默认与显式受限版本的重试/Compaction选择分别冻结在Request Options中。

Direct Run与Assembly强制1:1；Input Manifest绑定Assembly Hash。Executor授权响应只返回冻结内容和证据，不从DSH Session、当前文件或已被修改的Prompt组件重新推导。

Runtime默认继承直到真实AgentSession绑定Extension后才能得到最终清单；该清单Hash在首次Session绑定时进入Operation Store。Prompt Review后恢复如果观察到不同的System、Tool Schema或资源清单，Operation直接失败，不会用新能力继续同一个Run。

## 7. 三道审核与来源对应

```text
DSH原生Send
→ 可选DSH→Bridge审核：审核DSH真正交给LifeOS Adapter的GenerateOptions
→ Bridge筛选最新真实User并冻结会话上下文选择
→ 可选Bridge→Chat审核：审核实际HTTP Command Plan/bodyJson
→ Chat Direct Message Command冻结Assembly v2并启动Workflow
→ Pi AgentSession组成真实Provider Context
→ Provider Gate逐次冻结真实Payload
→ Workflow节点以同一个Review Revision/Hash进入waiting_human后，公开Query才返回可审核内容
→ Prompt Review Raw/Friendly
→ 批准后才发送；拒绝则该次Provider调用数为0
```

Prompt Review Request可以先于Workflow节点投影成为Product Store事实，但它在此时不可决定。公开Query和Decision Command都会校验`agent.direct`节点最新`waiting_human` Transition绑定同一个Request ID、Revision和Hash；这既避免用户决定抢在耐久Hook认领之前，也不靠前端延时猜测“应该已经就绪”。

Friendly页按Raw JSON Pointer逐项对应：

- System段显示Git/全局/Workspace Markdown路径、Revision、Scope和Hash；
- History显示正式Product Message与产生Assistant Message的成功Run；
- Current User显示本轮Product Message来源；
- Runtime Tool Call/Tool Result显示Pi AgentSession运行来源；
- Tools与Request Options显示冻结Profile来源。

所有中文标题和来源解释都是UI Metadata，不会进入模型请求；任何Raw字段无法映射时必须显示为“未归类原始字段”，不能丢弃或补写正文。

2026-08-22真实付费E2E使用隔离端口连续执行两轮：每轮依次批准三道审核，Provider各只发送1次；Product Store最终形成1个Session、4条正式Message、2个成功Direct Run、2个Assembly、2个已dispatched Prompt Review和2个approve Decision。第一轮通过Agent API完整覆盖Direct的Pi基础System，创建规则组件并选择会话Region；第二轮证明发送前完整预览和Provider Raw/Friendly都从Chat正式Message恢复上一轮`user/assistant`历史，且Bridge Command不复制DSH宿主历史。测试命令为`pnpm --filter @chat/dsh-web test:e2e:prompt-three-gates-real:paid`。

## 8. 当前完成边界

已完成并应用于全部当前模型节点：会话Prompt管理、独立Agent Profile管理、Workspace Scope、Markdown版本、会话上下文选择、后端发布的
Agent/Tool绑定、Workflow节点持久差异、Session/Run临时差异、两个前端预览、v3节点Assembly、Manifest Hash绑定和Pi安全输入。
Direct另外拥有v2四通道Chat输入Assembly、正式历史选择、逐请求最终Payload Prompt Review和来源映射。

尚未实现：

- 在Provider审核页直接编辑Raw Payload并产生新审核Revision；
- DSH Tool/Skill/Plugin作为Chat Agent能力的目录与执行Provider；当前AgentVersion只真正执行Pi原生能力；
- Conversation Summary Candidate与跨Run压缩；
- Planner、Planning Executor和Note Extractor的Provider前人工审核与四路Payload来源映射；
- 其他非Direct Agent与Direct相同的完整Version/Tools/Resources临时配置纵向；
