# Chat Context与Resource统一模型

## 1. 文档地位

本文是Chat中Project、Session、Workflow、Agent、Memory、Skill、Extension、Tool、Prompt和配置共同遵守的基础协议。具体领域文档只能扩展本文，不能为同一个概念重新定义身份、作用域、路径或加载规则。

Chat在Pi Agent公开能力之上增加管理层，不改变Pi的`SKILL.md`、Extension、`registerTool()`、`ToolDefinition`、`ResourceLoader`、`SettingsManager`、`SessionManager`或`AgentSession`合同。

本文既有类型/目录描述当前基础实现。2026-09-07 已确认的 Long Agent 私有 Owner 与独立目录扩展见第14节；不能把当前 ResourceTarget 类型当作已经支持该目标，也不能以旧枚举拒绝新的已确认作用域。

## 2. 核心不变量

1. 当前执行上下文不等于操作目标。
2. 资源归属不等于可见范围，可发现不等于已加载，已加载不等于允许执行。
3. Project长期身份只能使用稳定`projectId`；`cwd`只是当前机器上的可变路径。
4. 浏览器和Agent提交身份与目标，物理路径只能由后端Resolver产生。
5. 默认行为可以使用“个人+当前Project”，底层接口必须支持显式个人、当前Project和其他已登记Project。
6. 跨Project访问不改变资源原归属，并保留发起Project、Session、Workflow、Agent和Turn来源。
7. Credential只属于个人；Project只能引用Provider和Model，不能保存密钥。
8. 所有持久变更和实际运行装配都必须保留来源、版本和必要日志。

## 3. Context、Target与Address

一次运行拥有不可变上下文：

```ts
interface ChatExecutionContext {
  readonly personalId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly workflowId?: string;
  readonly workflowInvocationId?: string;
  readonly agentId?: string;
  readonly turnId?: string;
}
```

操作目标与上下文独立：

```ts
type ResourceTarget =
  | { readonly type: "personal" }
  | { readonly type: "project"; readonly projectId: string }
  | { readonly type: "session"; readonly projectId: string; readonly sessionId: string }
  | { readonly type: "invocation"; readonly invocationId: string };

interface ResourceAddress {
  readonly kind: "memory" | "config" | "skill" | "extension" | "tool" | "prompt";
  readonly target: ResourceTarget;
  readonly id?: string;
}
```

每个领域服务接收`ChatExecutionContext`和显式`ResourceTarget`。缺省Target由该领域的默认策略补全，而不是由存储层猜测。

## 4. 用户级与Project级目录

```text
~/.chat/
├── config.json
├── agent/
│   ├── auth.json
│   ├── models.json
│   ├── settings.json
│   ├── skills/
│   ├── extensions/
│   └── prompts/
├── memory/
│   └── personal/
│       ├── catalog.db
│       └── vector-store.db
├── projects/
│   ├── registry.json
│   └── <projectId>/
│       ├── sessions/
│       ├── memory/
│       │   ├── catalog.db
│       │   └── vector-store.db
│       ├── prompt-resources/
│       └── workflows/             # Workflow运行状态与Agent持久配置
├── runtime/
│   ├── workflow-data/
│   └── skills/                  # Workflow私有构建资源，不是第三种Skill Target
├── cache/
│   └── fastembed/
└── logs/

<project-root>/.chat/
├── project.json
├── config.json
├── skills/
├── extensions/
└── prompts/
```

`~/.chat`保存当前用户的私有运行数据。Project仓库中的`.chat`只保存可移植声明和资源，不保存Credential、Session、Memory数据库或运行日志。

## 5. Project Registry与Context解析

`<project-root>/.chat/project.json`提供可移植身份；`~/.chat/projects/registry.json`提供当前机器路径、打开时间和可用状态。

除“打开/登记Project”外，API不能把cwd作为Project身份。正常请求提交`projectId`；服务端从Registry解析路径，并在请求同时携带cwd时验证二者一致。

所有Workflow、Session、Memory、配置、资源和文件访问共用一个`ChatProjectContextResolver`，不得各自从`process.cwd()`推导Project。

## 6. Resource Catalog与运行时加载

Resource Catalog使用限定地址，例如：

```text
personal:skill/review
project/chat:skill/review
project/example-project:extension/content-tools
system:tool/memory_search
workflow/memory/memory-agent:tool/memory_delete
```

Chat限定地址只用于管理、冲突检测和日志。传给Pi时仍是原生文件和Tool名称。

默认发现与装配：

```text
Pi内置能力
  + Chat系统内置Tool
  + 个人资源
  + 当前Project资源
  + Workflow Agent私有资源
  + 本次Session/Run显式激活资源
```

其他Project资源可在Catalog中查询；显式激活后通过Pi的`additionalSkillPaths`、Extension Loader或`customTools`进入本次AgentSession。Chat系统Tool由源码Manifest进入统一Catalog，Agent以限定地址选择，Resolver绑定执行上下文后生成Pi `ToolDefinition`。Extension是代码执行，必须校验资源路径和Tool名称冲突。

## 7. 各领域允许的Target

| 领域 | Personal | 当前Project | 其他Project | Session/Run |
|---|---|---|---|---|
| Memory | 是 | 是 | 显式读写 | 记录来源，不作为独立长期库 |
| Config | 默认 | 覆盖 | 显式管理 | 临时覆盖 |
| Skill/Prompt | 安装/保存 | 安装/保存 | 显式查询、安装、激活 | 临时激活 |
| Extension/Tool | 安装 | 安装 | 信任后显式激活 | 临时启停 |
| Session | 否 | 固定归属 | 通过fork/clone创建新Session | 自身 |
| Credential | 唯一允许位置 | 禁止 | 禁止 | 只能引用 |
| Workflow运行数据 | 否 | 默认 | 不跨Project复用 | 按Invocation记录 |

“框架支持Target”不代表每种资源允许所有Target；允许集合由领域Policy声明并由后端执行。

## 8. Memory命名空间

Memory使用一个`MemoryStoreManager`管理多个独立Store：

```text
Personal Store
Project chat Store
Project example-project Store
...
```

每个Store包含自己的Chat事实库和Mem0可重建索引。正常查询并发检索Personal Store和当前Project Store；显式查询可以指定任意已登记Project集合。多Target写入创建独立记录，使用共同`groupId`和Source关联，但允许以后独立更新或删除。

默认策略是“查询个人+当前Project，写入当前Project”。这只是默认策略，不是底层限制。

## 9. 配置解析

```text
Workflow/Agent源码默认
  ↓
~/.chat/config.json Personal默认
  ↓
<project-root>/.chat/config.json Project覆盖
  ↓
Session/本次Run临时覆盖
```

一次Workflow Invocation在启动时解析并冻结配置和资源版本。文件变化从下一次Invocation生效。

公共 Pi 装配同时提供本轮 Project 的身份、用途、根目录和 cwd。普通 Workflow 的项目身份随 `chat.workflow-context-files.v1` 快照冻结；旧快照保留原规则，缺少身份字段时由已解析的同一 Project 补齐，不改写历史。Friend 的同类字段使用既有装配快照；旧快照没有用途字段时保持未知。两者共用项目说明与原生文件工具作用域：read/write/edit/ls/find/grep 默认限定当前 Project；Friend 额外允许自己的 Workspace，已选上下文/Skill 资源只开放声明的读取范围。父仓库、Chat 安装位置和 Skill 来源不代表当前 Project；缺少 README 不得自动向父级寻找另一个项目来冒充。检查与执行使用相同工具装配，explicit/默认工具选择不变。Bash 与可信 Extension 不是文件工具沙箱，不能由此声称实现 OS 隔离。

## 10. 版本与日志

文件资源至少记录内容Hash、来源和修改时间；Package资源记录包版本；配置记录Schema版本；Memory记录业务版本；Workflow运行记录实际装配的资源地址和版本。

必要管理日志包括配置修改、资源安装/更新/启停、跨Project激活、Memory增删改和显式跨Project读写。日志用于审计和排障，不把整个系统改造成事件溯源架构。

## 11. Skill与代码的关系

架构文档是完整事实源；`.chat/skills/chat-architecture/SKILL.md`是Chat Project面向Agent的架构导航和变更影响工作流。它负责触发架构意识、把任务路由到相关文档并要求沿真实执行链取证，不复制完整架构内容，也不作为第二事实源。它只按普通Project Skill发现，不由Chat运行时全局注入。Schema和测试是机器可执行合同；即使Agent未读取该Skill，后端也必须通过Context Resolver、Resource Resolver和Policy保证上述不变量。

## 12. 新能力接入检查

新增Workflow、Agent、Tool、Skill或持久资源时必须回答：

1. 当前`ChatExecutionContext`从哪里注入？
2. 允许哪些`ResourceTarget`，默认Target是什么？
3. 资源的Owner、物理存储和稳定ID是什么？
4. 如何发现、授权、解析、加载和检测冲突？
5. 使用哪个Pi公开接口？
6. 如何记录来源和版本？
7. Project移动、Session恢复、索引重建和跨Project访问如何测试？

## 13. 源码落地映射

| 合同 | 实现入口 |
|---|---|
| Chat Home | `src/chat-home.ts` |
| Project Manifest、Registry、Context | `src/projects/` |
| Personal + Project配置 | `src/chat-config.ts` |
| Project Session分区 | `src/chat-session.ts`、`src/session-read-model.ts` |
| Pi资源装配 | `src/workflows/agent-definition.ts` |
| Resource Address与文件版本 | `src/resources/version.ts` |
| Personal + 每Project Memory Store | `src/memory/manager.ts`、`src/memory/runtime.ts` |
| 可恢复旧数据迁移 | `src/migrations/project-layout-v1.ts` |
| 管理审计日志 | `src/audit-log.ts`，运行文件为`~/.chat/logs/audit.jsonl` |
| Chat架构导航Skill | `.chat/skills/chat-architecture/SKILL.md` |

Pi Web只通过上述后端事实工作：项目选择来自`GET /api/projects`；Memory页默认读取Personal与当前Project，也可以选择Personal或任意登记Project；Workflow、Session、Agent Resolve、配置和资源请求携带同一个`projectId`。

## 14. Long Agent 私有资源的目标扩展

Long Agent 是已确认的独立资源 Owner，具有稳定 longAgentId；不是某个 Project 或 Workflow 私有目录的别名。其配置、Skill、Tool资源、Prompt和Markdown Memory的逻辑根及领域责任以[定义与配置模型](../modules/long-agents/chat-long-agent-capability-model.md)为准。

ResourceTarget/Address 后续需表达明确的 Long Agent 目标，具体 Schema 和地址语法在实施任务中确定。调用方不能通过自报 longAgentId 取得其他 Agent 权限；当前身份由可信执行上下文绑定，目标由服务端解析并授权。

发现与装配同时区分：Personal公共资源、当前Agent自有资源、当前Project资源、Workflow私有资源及本轮显式选择。同名冲突必须可解释，不能按磁盘遍历顺序覆盖。Agent引用公共或Project资源不改变其Owner，也不自动复制。

Agent的System Prompt和模型选择来自Chat配置；Project提供上下文、资源与权限，不能隐式覆盖长期身份。NanoClaw资源通过版本化服务提供；仅允许显式受控目录或快照，不挂载全部groups或Chat Home。

本仓库chat-architecture Skill仍是开发导航。面向运行中Long Agent的公共管理Skill是独立的发布/发现需求，必须包含实际有效配置与能力查询入口，不能把仓库文件存在当作部署证据。

Markdown Agent Memory与Chat Personal/Project Memory保持不同领域服务和来源。活动索引与摘要读取任何Owner资源时仍检查权限，授权撤回、修正和删除要作用到派生视图。

### 14.1 共享概览的目标补充

资源归属与可见范围分开，也适用于 Project/Agent 的概览：尚未参与项目的 Agent 可发现面向它开放的项目名称、用途、阶段和活动；发现不同时取得完整 Session、Memory、文件或执行权限。可见范围由持久配置与服务端身份解析，不能靠用户逐个向 Agent 转述。

公开概览通过领域服务提供，不作为一份全局 Memory 再复制进所有 Owner。公共 Prompt 区域和 Tool 使用同一来源、更新时间和权限；长期职责与事件订阅仍通过 Chat 配置及现有执行链管理。场景和详细机制待审稿见[共享认知与自主工作](../modules/long-agents/chat-long-agent-awareness-and-autonomy.md)。

## 15. 公共 Agent 装配合同（P1，2026-09-19）

状态：P2 已接入公共装配、规则/资源冻结、工具工作目标与检查预览；P3 已实现耐久接受和跨入口每日定位；P4 实时流已接入公共事件消费，验证状态见阶段记录；P5 迁移演练待完成。适用于 Workflow 与 Friend。它取代“Session 存储 Project 必须同时是 Friend 每轮工作 Project”的旧假设；Session 固有归属不变、目标授权和唯一 Pi 装配入口继续成立。每日生命周期由 [Long Agent 架构 §4](../modules/long-agents/chat-long-agent-architecture.md#4-project-first-与会话选择)拥有。

### 15.1 输入、所有权与解析顺序

下列是内部合同字段，不是可以直接写入当前 JSON/API 的新字段：

| 输入 | 字段与事实源 | 信任和生效点 |
|---|---|---|
| AgentDefinition | agentId、definitionRevision、模型/Thinking、System Prompt、自定义区域、tools/resources；现有配置 Resolver | Workflow 使用其有效定义；Friend 使用自身定义与 Personal 模型默认，不受浏览项目的 Workflow 或 `.pi/settings.json` 隐式覆盖 |
| SessionRef | ownerKind、ownerId、storageProjectId、sessionId、dailyDate/timeZone（Friend）；Session 定位服务 | 路径仅服务端解析；projectId 兼容字段表示存储归属，不再同时代表本轮协作目标 |
| AgentWorkspace | longAgentId、workspaceRoot、自有资源引用；配置根和受控 Nano 资源服务 | 固定身份；不因项目切换搬家；Nano Group 资源不等于可任意挂载的本地目录 |
| CollaborationContext | projectId 或 null、projectRoot、effectiveCwd、selectionSource、selectionRevision；Project Resolver | Web 明确选择、通道绑定或受控切换 Tool；null 明确表示无项目，不能漏字段后猜最近项目 |
| Invocation | requestId、turnId、acceptedAt、序号、可信来源/发送者/回复目的地、运行用途 | 服务端校验后耐久接收；客户端不能指定其他 Agent 或 Session 权限 |
| AssemblySnapshot | schemaVersion、definitionRevision、区域正文/资源引用与 hash、授权来源、SessionRef、CollaborationContext、交接 revision | 接受时冻结配置、规则和资源输入；出队时接入最新有序 Session 历史并再次校验权限，不能换目标 |

解析顺序：可信入口 → 身份/项目授权 → Session 定位 → 配置与资源快照 → 耐久接受 → 同 Session 排序 → 读取历史/校验授权 → 公共装配 → Pi 执行。资源或规则读取失败不返回已接受；瞬时离线的 Nano 身份快照只按既有带 stale 标记的缓存合同处理。

同一已接受请求重试使用同一快照；项目移动、撤权或快照文件缺失时明确停止并报告，不用新 cwd、最新规则或 Home 静默替代。模型循环的后续工具步骤不重新读取浏览器选择。新的消息才重新解析。

### 15.2 区域填充与 Pi 接缝

| 区域 | 来源及 Pi 入口 | 持久化/恢复要求 |
|---|---|---|
| Pi 基础 System Prompt | 原生 builder；显式 replace 只替换此区域 | 保存策略/revision；不因 replace 丢失当前身份与协作区 |
| Agent 身份、职责和用户自定义区域 | 现有 customInstructions → appendSystemPromptOverride | 区域有稳定 ID、顺序、来源；文字不赋予权限 |
| Personal 规则、Agent 自身规则、当前项目规则 | 受控 context loader → agentsFilesOverride；禁用祖先扫描 | 按 realpath 去重，根目录候选优先级沿用当前实现；缺失记录为空，越界/不可读/解码异常失败；正文/hash 随快照冻结 |
| Workspace 与协作协议 | 程序生成的独立自定义区：自身空间、当前项目/无项目、默认 cwd、工具目标规则 | 下轮替换，不能把 A 的规则追加到 B 的有效 System Prompt；名称/路径作为引用数据编码，不能当模板代码执行 |
| Tool | 现有注册与授权 Resolver；Pi built-in factories/customTools | 记录实际启用工具与版本；Tool Schema 与函数执行同时正确，不只告诉模型工具名 |
| Skill、Extension、Plugin、Prompt 资源 | DefaultResourceLoader，按 inherit/explicit 和 Owner 选择 | 记录选中/排除/冲突原因；自有能力不随项目消失，项目选择不自动开启所有代码扩展 |
| Agent 核心 Memory | 现有 Nano 资源 API 的有界、版本化快照 | 维持既有单一事实源及 stale/错误语义；不迁移或双写 Memory |
| 每日交接 | 已校验的总结 revision＋未完成状态引用，放自定义区 | 每次装配均从当日初始化记录恢复，不依赖 isNewSession；更新交接用新 revision，冻结已接受轮次 |
| 历史和压缩摘要 | SessionManager.buildSessionContext；必要时 transformContext | 不重写真实 user/assistant/toolResult；压缩不读取 CustomEntry 中隐藏的项目字段，见 Session 合同 |
| 装配证据 | 版本化 CustomEntry＋现有 runtime 内容快照 | 不作为真实发言的唯一存储；检查使用同一 resolver，显示当前预览与既有执行快照的区别 |

区域名称用于检查和来源解释，不新增提示词脚本语言。现有 Workflow 的有序自定义输入兼容；新结构由公共层规范化，不要求 Frontend 维护第二份区域清单。

### 15.3 默认工作位置与能力边界

普通 Workflow 默认 storageProjectId = collaboration.projectId，保持现有行为；Friend 的 storageProjectId 永远指其 Home 容器，effectiveCwd 为本轮协作项目根，无项目时为专属 Workspace。Pi Session header 的 cwd 保留创建事实，不能从它推断当前轮次 cwd。

Chat 系统工具上下文必须同时带 SessionRef 和 CollaborationContext：会话查找/审计来源用前者；默认项目读写/配置/Memory 用后者。没有协作项目时，Project Memory 写入必须要求明确目标，不能把 Agent Home 当普通用户项目库；Personal 和 Agent Memory 仍走各自工具。`workflow_call` 保留父 Home Session 来源，目标子 Workflow 使用经授权的协作项目并建立原生父子关系；该子 Session 属于 Workflow，不是 Friend 的第二条直接交流。

跨项目的 read/write 等受管文件操作经真实路径和授权范围校验；专属空间只通过已授权自身资源路径/工具访问。**Pi 原生 cwd 不是沙箱**：绝对路径、`..`、bash 和扩展代码不由 cwd 限制。P1 实验只证明相对路径解析正确，不证明进程隔离。P2 已通过受管原生文件工具的真实路径校验验证文件越界；shell/任意代码继续明确为已有可信宿主能力，不能宣称具有项目沙箱，也不能给原本受限调用方隐式启用。要求严格进程隔离而无执行环境时明确不支持；本轮不通过命令文本检查冒充 Docker 隔离。

配置/工具权限撤回从下一次动作再次校验，不因快照冻结继续越权。历史中用户自己提供的旧项目资料保留为历史，不可能仅靠提示词保证模型永不误解；程序必须保证当前规则不混入、实际目标经校验。模型输出不能绕过工具授权。

### 15.4 可复现性与预算

规则正文及选定 Prompt 使用现有 revision 或内容快照；仅记录 hash 而读取被修改的原文件不算冻结。Skill 的描述与按需读取正文必须对应同一包/文件版本；可执行扩展在进程内装载完成后保留实例，重启无法解析原版本时中断，不偷偷使用新代码。使用现有 runtime 快照机制，不另建资源数据库。快照保留至其最后一个可恢复执行/保留历史引用过期。

不静默截断项目规则。模型窗口预留输出及运行预算后，若必需区域超限，发送前给出具体区域和大小错误；可选历史/检索结果按声明预算收缩并标明省略，身份与核心规则不能默默丢失。Pi 压缩只处理历史，不解决系统规则自身超长。

### 15.5 原生证据与实施范围

`test/agents/pi-assembly-seams.test.mjs` 使用本地 HTTP 假模型、真实 Pi ResourceLoader/AgentSession/SessionManager 及原生 write 工具，证明：同一文件与 ID 跨 A/B 重装配、规则替换、真实相对文件写入、CustomEntry 不自动入模型、transformContext 不回写历史、原生 compaction 和重开恢复、已加载规则不随磁盘变化改写。

这是原生 SDK 接缝门禁，故意直接调用 Pi；生产仍只能通过 createChatPiAgentSession，P2 已在该公共入口补充 `test/agents/public-assembly.test.mjs`，并通过 Long Agent HTTP 检查/发送对照测试验证实际 Prompt 一致。它不证明 Chat 路由、Nano、授权沙箱或每日生命周期已经完成，也不需要修改 Pi 源码。

### 15.6 P2 实现边界与恢复

- `src/agents/assembly-context.ts` 解析可信 `invocation`，将身份、存储 Project、本轮目标、cwd、有效定义及根规则正文写入 `chat.agent-assembly.v1`。P3 已在统一耐久接受点冻结，执行安装同一 seed；P4 Web turns API 耐久接受后返回引用，再订阅实时事件，旧 messages API 保留同步兼容。
- Web `contextProjectId` 为已登记用户项目 ID 或 null；省略兼容为 null。Agent Home 不能作为协作项目。Nano/调度适配显式传入绑定的用户项目，绑定 Home 时为 null，不读取浏览器最后选择。
- Friend 模型/Thinking 从自身定义 → Personal 设置解析；项目设置只参与资源等 Pi 设置。`prepareLongAgentAssembly` 供执行和检查共用身份/交接输入，检查为当前配置预览，不修改真实历史。
- 原生 `read` 对选中规则/Skill 等文本返回本轮快照，其他文本和图片保留 Pi 行为。普通 Workflow 与 Friend 共用 `read/write/edit/ls/find/grep` 作用域检查：普通 Workflow 以当前项目为边界，Friend 额外允许自身 Workspace；选中资源保留声明的只读范围。自定义同名工具仍由其能力提供方负责，不声称对任意扩展代码实施沙箱。
- `chat.agent-assembly-resources.v1` 保存加载的 Skill/Prompt/扩展入口源内容与版本。恢复前校验，再交给 Pi；修改或缺失明确失败。运行中的扩展保留已加载实例。重建带可执行扩展的旧轮次一律失败并要求新轮次，因为入口文件 hash 无法证明其任意依赖代码未变化；不以重新导入最新代码冒充恢复。
- `chat.agent-assembly-tools.v1` 固定实际启用工具、Schema 与资源版本；恢复时默认工具设置变化会明确失败，新轮次才采用新设置。
- 普通 Workflow 以 invocation/stage/agent 为键保存 `chat.workflow-context-files.v1`，恢复时使用原规则正文。Session 消息、工具结果、Pi 压缩仍是原生记录；快照不是第二份聊天历史。
- 必需系统区域和实际启用 Tool Schema 在发送前按 UTF-8 字节保守上界检查，扣除 Pi 配置的运行/输出预留。报错列出区域大小、文件来源及可用预算；这不是供应商精确 Token 计数，可能要求精简理论上能放入窗口的配置。Standing Instructions 超过 32,000 code point、身份定义超过 16,000 时失败；可选 Memory index 保留带提示的有界摘要。

实现证据及阶段自检见 [P2 交付记录](../history/reviews/2026-09-19-agent-unification-p2.md)。P3 已实现每日索引恢复、请求接受排序、执行授权再校验和跨日交接；实现与场景证据见 [P3 交付记录](../history/reviews/2026-09-19-agent-unification-p3.md)。
