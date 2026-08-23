# Chat Agent 管理 As-built

> As-built：2026-08-23。本文是当前 Agent Catalog、Agent Version、Workflow 绑定和会话临时配置的唯一事实源。
> Prompt 的区域与组装见[Prompt Studio 与系统级 Prompt Assembly](./prompt-studio-as-built.md)，Pi 执行边界见[Pi Coding Executor Service](./pi-coding-executor-service.md)，Session/轨迹/Trace 边界见[Session 与轨迹架构](./session-architecture.md)。

## 1. 产品结论

Chat 不从零实现 Agent，也不复制 Pi 或 DSH 的 Agent Loop。Chat 管理“可供产品选择并可复现的一套 Agent 配置”，运行时继续复用固定的上游实现。

当前完整 Agent 配置包含：

```text
Agent Configuration
├── identity / system prompt：继承运行时，或完整替换
├── tools：继承运行时默认，或有序、精确的启用集合
├── resources
│  ├── context files
│  ├── skills
│  ├── prompt templates
│  └── extensions
└── runtime：当前只支持 pi_coding_agent + 固定基线变体
```

模型、Thinking、重试、压缩、审批和 Workspace 授权仍由各自的运行合同治理，不因一段 Prompt 或一个 Tool 勾选而自动放权。

## 2. 两层长期事实，不建立重型继承框架

### 2.1 Agent Catalog：Chat 发布的内建定义

Agent Catalog 描述系统当前有哪些 Agent、支持哪些 Workflow 节点、默认 Prompt 来源以及底层 Runtime。它是发布随附的只读定义，不是用户数据，也不为每个 Workflow 复制一份上游实现。

Pi-backed Agent 的 Catalog 默认不是一段 Chat 手抄的近似 Prompt。`packages/pi-runtime/src/coding-agent-runtime-profile.ts`通过真实 `createAgentSessionServices()` 和 `createAgentSessionFromServices()` 投影固定 Pi Fork 的 System Prompt、全部可执行 Tool 目录、默认启用集合、Tool Schema 和资源清单；API 只读取这个窄投影，不加载第二套 Pi Coding Agent。无`workspaceRootId`时读取受管 AgentDir + 空 Workspace 的全局基线；指定受权 Root 时，Pi Executor 在私有边界把 Root ID 映射为 canonical cwd，并读取同一工作区的 Pi Settings、Extension 和资源。两层都不做跨请求永久缓存。

### 2.2 AgentVersion：Principal 创建的不可变完整配置

`agent-version.v1`是 Product Store v18 中的不可变产品事实。每个版本冻结：

- `agentVersionId + sha256`、所属 `agentKey`、Owner、版本号和来源版本；
- `global`或精确`workspace/rootId` Scope；
- Pi Runtime 基线键，以及包版本、受管 Fork Revision、Variant 与能力目录 Hash；
- System Prompt 的`inherit_runtime`或完整`replace`正文与 Hash；
- 按 Pi 上游稳定顺序冻结的 Tool 子集；
- Context Files、Skills、Prompt Templates、Extensions 各自的继承或关闭策略。

当前资源策略按类别选择`inherit_runtime_default / disabled`；真实资源清单逐项可见，但 v1 尚未承诺单个 Skill、Template、Context File 或 Extension 的独立勾选。不能把“展示了目录”写成“已经支持逐项执行配置”。

保存永远创建新版本，不修改或删除旧版本。`basedOnVersionId + basedOnVersionSha256`必须成对提交，并且来源版本必须属于同一 Owner、Agent 和 Scope。这样历史 Workflow Revision 与 Run 不会因后来编辑而变义。

`global`与`workspace`是可见和可用范围，不是两层自动合并：Workspace Version 只能用于同一个 `rootId`，不会与 Global Version 隐式拼接。需要组合时，用户明确创建一个新版本。

## 3. 默认 Pi Coding Agent 必须等于真实 Pi CLI 基线

`pi_cli_default`遵守以下合同：

1. 不传显式 `tools` 给 `AgentSession`，初始活动 Tool 由固定 Pi SDK 的 Settings 与 Extension 自己决定；当前无工作区覆盖时，受管 AgentDir 的默认启用集合为`read / bash / edit / write`，可执行内置目录还包含`grep / find / ls`。目标 Workspace 的 Pi Settings 或 Extension 可以产生 scoped 目录与默认集合，并在页面按该 Root 重新读取。
2. 不设置`noContextFiles`、`noSkills`、`noPromptTemplates`或`noExtensions`，资源发现沿用同一 Pi 公共构造路径。
3. System Prompt 继承 Pi 动态生成结果；Chat 不向默认变体追加“只读”“禁止写文件”一类约束。
4. 前端展示的 Prompt、完整可选 Tool 目录、默认勾选集合和资源清单来自同一次真实运行时投影，不维护第二份人工副本。
5. 每次执行先完成 Extension 绑定，再解析实际活动 Tool、System 与资源清单；该 Resolved Runtime Manifest 的 Hash 写入 Pi Journal并在同一个 Operation 首次绑定时钉住。审核等待后恢复只能使用完全相同的 Hash，Settings、Extension、System、Schema 或资源发生漂移时在 Provider 前以`direct_executor.runtime_manifest_mismatch`失败。
6. 真正发送给 Provider 的逐字节请求仍以每次 Provider 前 Prompt Review 为最终事实，因为 cwd、历史、Extension 和 Tool Loop 会在运行时变化。

因此“Pi Coding Agent 默认版”不是 Chat 自己设计的受限 Agent。若用户需要只读、移除 Bash、关闭 Skill 或完整替换 System Prompt，必须显式创建派生 AgentVersion，或仅在当前会话生成临时配置。历史`read_only`和项目初始化专用变体只能标为显式受限/专用能力，不能再冒充 Pi CLI 默认值。

## 4. Workflow、Session 草稿与 Run 的解析

当前长期到临时的解析顺序固定为：

```text
本次 Run 已冻结的 agent_configuration
  > Workflow Revision 中精确绑定的 AgentVersion ID + Hash
  > Agent Catalog / 真实 Pi Runtime 默认
```

其中：

1. **Workflow 节点**是 Agent 的一个使用实例。保存节点配置时，系统 Workflow 派生个人 Workflow，个人 Workflow 发布下一不可变 Revision；节点只保存精确 AgentVersion ID/Hash。若选择 Pi 默认，则不制造一个伪 Version。
2. **当前会话配置**由 DSH Bridge 作为未发送草稿保存。用户可以选择既有 Version，也可以临时修改 System Prompt、Tools 和四类资源；页面按当前 DSH Session 的受权 Workspace Root 读取 scoped Runtime Profile。“应用当前会话”不修改 AgentVersion 或 Workflow Revision。
3. **本次 Run**创建时，Application 重新鉴权和校验 Scope、Runtime、Version ID/Hash，并用同一个`workspaceRootId`重新读取 scoped Profile，把会话草稿编译成结构化`agent_configuration`并冻结到 RunSpec 与 Prompt Assembly。`direct-agent-prompt-compiler.v3`还在 Assembly 中冻结 scoped Runtime Profile Hash；存在 Workspace 时同时冻结不暴露路径的 Root Grant Hash。Run 启动后不再读取浏览器草稿。

`AgentVersion ID + Hash`、`agentTemporaryConfiguration`与旧单段`agentPromptOverride`是三种互斥来源，任意两者不能同时保存或在本次Run中用优先级拼接。Catalog、窄保存命令、Draft/Publish、RunSpec Compiler、Prompt Assembly和Operation授权分别独立失败关闭；绑定Version的窄保存命令还会删除旧Temporary/Prompt/Tool/资源字段。合法Temporary `systemPrompt.mode=replace`仍完整冻结在RunSpec中，Product Store从该结构化配置重建Workflow Prompt来源，不要求制造顶层兼容字段。
4. 临时配置可以记录它基于哪个 Version，但它本身不是新版本；要长期复用必须显式“创建版本”或“保存到 Workflow”。

当前“会话级”语义是 Bridge 对同一 DSH Session 复用草稿、每次发送都形成新的 Run 冻结副本；它不是 Product Store 中另一份可变 Agent 真相。若以后需要跨前端恢复的耐久 Product Session 默认，应新增明确的 Product Session 配置事实，不能把浏览器/Bridge 状态偷换成产品事实。

旧 Workflow 的单段`agentPromptOverride`仍可在没有Version或Temporary时读取，但只是迁移兼容；普通`node_config`不能替换已绑定Version的System Prompt。新的 Pi-backed Direct Agent 以完整 AgentVersion 或结构化临时配置为主，不再用散落 Prompt 文本代表完整 Agent。

### 4.1 Version 能力的单一运行语义

只要 Direct 节点绑定了精确`AgentVersion ID + Hash`，Compiler 就把该 Run 的能力模式规范化为`custom`，并从版本事实生成 Tool 与四类资源策略；节点历史字段不能把它降回`inherit_runtime_default`。这一规则同时适用于长期 Workflow Revision 绑定和本次 Run 的 Version 临时覆盖，且不会反向改写旧 Revision。

同一次 Run 的三个消费面必须严格相等：

1. `WorkflowRunSpec`冻结 Version ID/Hash、`custom`能力模式与资源策略；
2. `PromptAssembly`只接受同一份 RunSpec 绑定的合成 Version Prompt Source，并冻结同一 Tool 名称和资源策略；
3. Executor Operation 授权重新读取 Product Store 中的 AgentVersion，并重新读取同一 Principal、Agent 与 Root 作用域的实时 Pi Runtime Profile；Application用与Run编译相同的纯函数重新派生`tools.names / tools.resources / piSystemPrompt / requestOptions`完整能力包络，并与自身Hash正确的Assembly逐字段重证。Version 的包/Fork/能力目录、Assembly 中冻结的 Profile Hash和Root Grant Hash也必须全部一致，才返回可执行能力；Executor在进入Runner前再用实际canonical root复核Grant Hash。

这两个 Hash 是 Run 创建与 Operation 授权之间的漂移证据，不取代首次真实 Session 绑定后的 Resolved Runtime Manifest。前者覆盖 Agent Settings、Extension、Tool Schema、资源目录与 Root 授权是否仍等于 Run 创建时的配置基线；后者覆盖本次 Session 最终 System、活动 Tool Schema 与资源清单，并在同一 Operation 的审核恢复时保持不变。绑定 AgentVersion 的历史 Assembly 若缺少新版漂移证据，会在 Provider 前失败关闭；未绑定 Version 的兼容 Run 仍按原合同读取。

Version 不存在、Hash/Owner/Scope/Root 漂移、Version与Temporary/普通Prompt Override并存、Assembly 来源漂移，或Assembly的Tool/资源/System Prompt/Request Options任一项与唯一Version或临时配置不一致时，均在创建Operation、解析Workspace或触达Provider前失败关闭。因此失败证据允许“零Operation、零Provider请求”，而不能为了补日志先启动一次错误能力的AgentSession。

## 5. 从前端到 Provider 的唯一通路

```text
DSH Agent设置 / Workflow配置
  → packages/dsh-lifeos-bridge（只做宿主适配与Command转发）
  → Chat公开Agent/Workflow Query与Command
  → Application校验Owner、Scope、Version Hash并写Product Store
  → Workflow Run Compiler冻结节点有效配置
  → Prompt Compiler冻结System/Messages/Tools/Resources/Options来源
  → Pi Executor用真实AgentSession构造请求
  → Provider Request Gate展示最终Raw/Friendly并审核
```

前端不是事实所有者；浏览器不能直连 Workflow 或 Pi。Bridge 也不能写死“生成计划/执行计划”之类的 Prompt 选项代替 Agent 配置。

当前公开管理面包括：

- `GET /api/agent-profiles`与`GET /api/agent-profiles/:agentKey`：读取 Catalog、真实 Pi Runtime 基线和当前 Principal 的版本；可选严格 Query`workspaceRootId`只返回 Global + 该 Workspace 可用版本，并由 Executor 解析真实 scoped Pi 目录；
- `POST /api/agent-profiles/:agentKey/versions`：当前只为已完成逐字段消费纵向的 Direct Agent 创建不可变完整版本；Project Bootstrap、Coding Executor 等只读显示真实基线，不能创建“可保存但执行时不生效”的假版本；
- Workflow Agent 节点保存命令：精确绑定一个版本，或恢复继承默认；
- Workflow Run Configuration 的`agent_configuration`：选择版本或冻结结构化临时配置。

## 6. Pi 与 DSH 的能力边界

本纵向**真正接入执行的只有 Pi 原生能力**：

- Runtime：`pi_coding_agent`；
- Tools：Pi 的`read / bash / edit / write / grep / find / ls`，以及由受管 Pi Extension 注册并真实绑定的 Tool；
- Resources：Pi ResourceLoader 的 Context Files、Skills、Prompt Templates 和 Extensions。

DSH 的能力边界已经审计，但没有伪装成可执行 AgentVersion：

- DSH Tool 来自宿主`ctx.tools`注册和真实 DSH Agent Loop；
- DSH Skill 来自`ctx.skills`及其消息注入；
- DSH Plugin/Extension 还承担 UI、Session、Prompt Section、Host Action 等不同责任，并非都能作为模型 Tool；
- DSH 当前没有可直接复用为 Chat 外部 Agent Tool Registry/Execute API 的统一合同。

因此前端目前不能把 DSH Tool、Skill 或 Plugin 勾选后宣称 Pi 已经能执行。后续若需要跨运行时能力，必须新增窄 Provider/Host RPC，分别定义目录投影、执行授权、凭据、超时、幂等和结果未知；Pi 原生 Tool 仍由 Pi 执行，DSH 宿主能力仍由 DSH 执行。

## 7. Agent、Session、Trajectory 与 Trace 不混用

| 对象 | 作用 | 事实所有者 |
|---|---|---|
| Agent Catalog / AgentVersion | 定义可选择的 Agent 配置和不可变版本 | 发布工件 / Product Store |
| Chat Product Session | 用户与各 Agent 的正式持续会话 | Product Store |
| RunSpec / Prompt Assembly | 某次 Run 实际采用的 Agent、Prompt、Tools 与来源 | Product Store |
| Pi Session / Journal | 一个 Pi AgentSession 的恢复与 Tool Loop 证据 | Pi Executor |
| Trajectory | 组合一次 Run 的 Workflow、Agent、Model、Tool 活动读模型 | Product Store + Run Activity |
| Debug Trace | 按模块临时定位失败、耗时和边界 | 各进程 Trace Sink |

Agent 配置不是 Session 日志；Trajectory 不是 Agent Version；Debug Trace 不能反向成为 Session 或轨迹的数据源。任何调试开关都不得改变 Agent 的有效 Prompt、Tool 或资源。

## 8. 失败关闭与当前边界

- Direct Workflow 的 prepare Step 使用共享的`directAgentCapabilityModeSchema`校验能力模式，不能在 Workflow 内再次硬编码旧`read_only`默认；`pi_cli_default`、显式自定义和专用变体必须与 Application 冻结的 RunSpec 保持同一合同。
- 若 Workflow 在创建 Pi Direct Attempt 前失败，产品事实收敛为`failed/queued`并允许零个 Direct Attempt；不能伪造一次从未开始的 Pi 执行，也不能因终态提交失败而让前端永久显示活动中。
- Version 不存在、Hash 漂移、Workspace Scope/Grant 不匹配或 scoped Runtime Profile 已在 Run 创建后变化时，Operation 在 Provider 前失败；Executor 不信任 API 提供的 Root ID 代替实际 canonical root 复核。
- 同一 Operation 恢复时 Resolved Runtime Manifest 必须与首次绑定完全一致；旧记录没有该字段时只允许在首次恢复补钉一次。
- 自定义能力没有冻结 Tool 清单时失败；客户端不能通过任意 JSON 绕过专用`agent_configuration`合同。
- Prompt 修改不能扩大 Tool/Workspace授权；Shell和写入仍受运行合同与人工审批治理。
- Version 与 Workflow Revision 保留精确 ID/Hash和Runtime基线引用；运行工件变化时失败关闭，不会静默追随“最新版本”。
- 当前仅`agent.direct`节点使用的 Direct Pi Coding Agent 完成完整 Version、Tools、Resources 和会话临时配置纵向；Project Bootstrap 的固定产品Tool合同、Coding Executor及其他 Agent Profile 仍只读展示既有Prompt/运行时合同，不能创建或绑定完整Version，也不能声称已经拥有同等可配置能力。
- Pi 四类资源当前只支持整类继承或关闭；逐项资源选择、独立来源版本与Hash仍是后续合同，不在本次结果中伪装完成。
- DSH Tool/Skill/Plugin 目录与执行接缝尚未实现，这是明确的后续 Provider 纵向，不在本次交付中。
