# Prompt Studio 与 Direct Prompt Assembly As-built

> 状态：Prompt 管理、全局/Workspace Markdown 版本、会话级 Region 选择、DSH 两级预览、DSH→Bridge与Bridge→Chat调试审核、Direct Prompt Assembly v2、近期正式会话历史和 Provider 前逐次审核已打通。当前只接“执行 Agent（逐次提示词审核）”；Planning、Planning Executor 与 Memory Workflow 尚未迁移。

## 1. 用户结果

1. DSH「设置 → 提示词」是长期管理面。它展示 Region、Git 内置 Markdown 与来源，支持创建全局或指定 Workspace 的组件、派生副本、追加不可变 Revision、归档与恢复。
2. 每个会话的 Composer 配置栏有「提示词」入口。发送前可按 Region 分别选择`默认 / 覆盖 / 追加`，并在全局与当前 Workspace 两个 Scope 中选择精确 Revision。
3. 「提示词配置预览」只回答当前选择将怎样组成 Prompt；「DSH 前端发送预览」还加入真实输入、DSH 请求和 Bridge→Chat 命令映射。二者都不是 Provider 请求。
4. Composer的「调试审核」面板有两个独立开关：DSH→Bridge审核真实`GenerateOptions`；Bridge→Chat审核筛选后将实际交给`fetch`的完整Command Plan。两项关闭时自动发送；开启时必须依序批准。第二道批准前Chat Session/Message写入数为零。
5. Direct Message Command 在创建 Run 的同一事务中冻结 Prompt Assembly v2。组件随后被修改、归档或页面刷新，都不能改变该 Run。
6. Direct Executor 只使用冻结 Assembly：Chat 编译的 System 追加段、近期正式历史、当前 User Message、只读 Tool Profile 和 Request Options。
7. Pi Coding Agent 仍负责单次 Run 内 Agent/Tool Loop，但自动加载 AGENTS、Skills、Prompt Templates 和 Extensions 已关闭。`AGENTS.md`只有被用户显式选择为 Prompt 组件时才进入请求。
8. Provider Gate 在每次真实模型请求前暂停。Raw 是 Provider Adapter 将发送的 Canonical Payload；Friendly 只增加来源、区域、Revision、Hash、Scope 和 JSON Pointer，不添加模型可见正文。

## 2. 事实所有权

```text
prompts/catalog.json + prompts/**/*.md
  └── Git PromptCatalog（内置组件唯一事实源，只读）

<Chat>/.data/prompts/global/**/*.md
<Workspace>/.chat/prompts/**/*.md
  └── 用户Prompt正文与人可读版本文件

Product Store v16
  ├── PromptFragment（owner/scope/status/current/CAS）
  ├── PromptFragmentRevision（不可变元数据、内容Hash、MD路径/文件Hash）
  └── PromptAssembly（一次Direct Run冻结的正文投影、来源、预算与Hash）

DSH Bridge State v11
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

本地“打开文件”菜单支持白名单应用，并重新校验文件必须属于以下边界之一：Git Catalog、Chat全局Prompt目录、当前登记Workspace的`AGENTS.md`或`.chat/prompts`。公网部署不装配启动服务器本机应用的能力。

## 4. Product Store、Markdown版本与并发

迁移链：

- `v13 → v14`：新增 Prompt Fragment 与 Revision；
- `v14 → v15`：新增 Scope 与 Direct Prompt Assembly v1；
- `v15 → v16`：用户新Revision改为Markdown内容引用，Direct Assembly升级为四路输入v2。

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

公开Commands：

- `POST /api/prompt-fragments`
- `POST /api/prompt-fragments/copies`
- `POST /api/prompt-fragments/:promptFragmentId/revisions`
- `POST /api/prompt-fragments/:promptFragmentId/archive-status`
- `POST /api/prompt-configuration-previews`
- `POST /api/prompt-assembly-previews`

Prompt Studio与Composer都通过`packages/dsh-lifeos-bridge`访问Chat公开Query/Command；浏览器不扫描本机目录、不提交权威路径、不直接调用Workflow或Pi。

DSH同源路由保存会话选择：

```text
PromptComposer（读取DSH真实input.draft）
→ GET/PUT /lifeos/sessions/:id/prompt-selection
→ Bridge按DSH Session保存草稿并在请求时冻结
→ Direct Submit Message携带promptSelection
→ Application重新读取精确Revision并编译Assembly
```

DSH发送审核使用实际Adapter入口捕获的完整可序列化`GenerateOptions`。Bridge出口审核由同一个冻结Dispatch Builder生成审核`bodyJson`和实际`fetch body`，确定性测试逐字节证明两者相同；首次会话的Plan包含Create Session与Submit Message两条HTTP操作，已有会话只有Submit。Trace只记录整体Hash、JSON Pointer值Hash/长度及DSH User文本到Bridge Payload的映射；正文不进入日志。两端文本Hash不一致时，在Chat写入前以`lifeos_dsh_raw_mapping_mismatch`失败关闭。

## 6. Direct Prompt Assembly v2

Direct固定Profile为：

```text
direct-agent-prompt-profile.v2
├── Instructions / System
│   ├── Pi固定默认基础System
│   ├── Chat Direct运行约束
│   └── 用户按Region选入的命名Markdown段
├── Messages
│   ├── 近期成功Product Run提交的user/assistant对
│   └── 当前Product Message（原样role:user）
├── Tools
│   └── read-only: read / grep / find / ls
├── Request Options
│   └── 固定provider/model/thinking=off/retry=0/compaction=off
└── Manifest（模型不可见）
    └── 来源、Revision、Scope、顺序、采用/排除原因、预算与Hash
```

用户管理的所有活动语义Region在Direct v2中都编译成带稳定标题的System追加段。`AGENTS.md`不是特殊旁路：它是`workspace_instructions` Region中的一个可选Markdown组件，选中时正文进入System，未选中时不会被Pi发现。

历史只选择已形成正式Assistant Message的成功`User → Assistant`对，按最近优先、完整成对地加入；失败、取消、`outcome_unknown`或没有正式Assistant结果的User Message不自动重放。当前输入永远是最后一条原始User Message，不加`<history>`等伪文本包装。

v2使用确定性首版预算：总输入上限64,000估算Token，固定为Tool Schema预留8,000；文本估算器为`ceil(UTF-8 bytes / 3)`。必需System与当前User超限时在Provider前失败；可选历史从旧到新稳定排除并在Manifest记录原因。当前不开启Pi重试和Compaction。

Direct Run与Assembly强制1:1；Input Manifest绑定Assembly Hash。Executor授权响应只返回冻结内容和证据，不从DSH Session、当前文件或已被修改的Prompt组件重新推导。

## 7. 三道审核与来源对应

```text
DSH原生Send
→ 可选DSH→Bridge审核：审核DSH真正交给LifeOS Adapter的GenerateOptions
→ Bridge筛选最新真实User、显式Workspace指令和Prompt Region选择
→ 可选Bridge→Chat审核：审核实际HTTP Command Plan/bodyJson
→ Chat Direct Message Command冻结Assembly v2并启动Workflow
→ Pi AgentSession组成真实Provider Context
→ Provider Gate逐次冻结真实Payload
→ Prompt Review Raw/Friendly
→ 批准后才发送；拒绝则该次Provider调用数为0
```

Friendly页按Raw JSON Pointer逐项对应：

- System段显示Git/全局/Workspace Markdown路径、Revision、Scope和Hash；
- History显示正式Product Message与产生Assistant Message的成功Run；
- Current User显示本轮Product Message来源；
- Runtime Tool Call/Tool Result显示Pi AgentSession运行来源；
- Tools与Request Options显示冻结Profile来源。

所有中文标题和来源解释都是UI Metadata，不会进入模型请求；任何Raw字段无法映射时必须显示为“未归类原始字段”，不能丢弃或补写正文。

2026-08-20真实付费E2E使用隔离端口连续执行两轮：每轮依次批准三道审核，Provider各只发送1次；Product Store最终形成1个Session、4条正式Message、2个成功Direct Run、2个Assembly、2个已dispatched Prompt Review和2个approve Decision。第一轮创建并编辑身份组件v2、创建规则组件并选择两个Region；第二轮证明DSH输入仍包含宿主历史、Bridge Command不复制该历史、Provider Raw/Friendly从Chat正式Message恢复上一轮`user/assistant`历史。测试命令为`pnpm test:e2e:dsh-prompt-three-gates-real:paid`。

## 8. 当前完成边界

已完成并只应用于Direct审核工作流：Prompt管理、Workspace Scope、Markdown版本、会话选择、两个前端预览、正式历史选择、四路Assembly、Pi安全输入、逐请求Prompt Review和来源映射。

尚未实现：

- 在Provider审核页直接编辑Raw Payload并产生新审核Revision；
- 用户可命名、版本化的Prompt Profile；当前Direct Profile由代码固定；
- Conversation Summary Candidate与跨Run压缩；
- Planner、Planning Executor与Memory Workflow迁移；
- Workspace写入/Shell能力；当前Direct固定`read_only`；
- 临时未保存正文直接用于一次发送；当前必须先保存为Revision再选择。
