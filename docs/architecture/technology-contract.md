# Chat 技术与所有权合同

> 本文冻结系统边界。当前落地事实见[PROJECT_STATE.md](../../PROJECT_STATE.md)。

## 1. 技术栈

| 层 | 选择 | 责任 |
|---|---|---|
| 唯一主前端 | Chat私有DeepSeek Harness Web rc.6（固定窄派生） | 原生会话、消息、Composer、布局、主题和Client插件宿主；仅Trajectory Location/标签/紧凑预览扩展 |
| 前端集成 | `@chat/dsh-lifeos-bridge` | DSH Host/Client插件、Chat Query/Command适配、HITL与Workbench表面 |
| HTTP | Node.js + Hono | 认证上下文、运行时校验、REST和未来SSE协议终止 |
| Product Core | TypeScript Domain + Application | 状态机、权限、用例、事务、幂等和产品提交 |
| Product Store | 当前版本化JSON Adapter | 权威产品事实；未来可替换生产Store |
| Durable Workflow | Vercel Workflow | 耐久步骤、暂停、恢复、重放和Checkpoint |
| Agent Runtime | `pi-agent-core` + `pi-coding-agent AgentSession` | Planner仍是Workflow内受限节点；完整Executor运行在独立服务中 |
| Memory | 暂停；保留`WorkflowMemoryProviderPort`、Adapter与历史合同 | 当前统一启动没有可用Provider；历史事实仍可读取，后续重新接入时复用窄Port而不自研Memory引擎 |
| Hosted Workbench | code-server（固定版本） | Files、Editor、Terminal、Git、Diff和VS Code扩展 |
| 验证 | Vitest/Node Test + Playwright | 单元、合同、集成和真实浏览器纵向 |

## 2. 系统拓扑

```text
Browser
  -> LifeOS Web Gateway (127.0.0.1:43110)
     -> DSH Web Host (internal 43114)
     -> DSH Client Plugin Graph
     -> LifeOS Bridge Host
        -> Chat Hono API
           -> Application -> Product Store
                         -> Transactional Outbox -> Vercel Workflow
                            -> Pi Coding Executor Service -> AgentSession
     -> localhost-only Workbench origin -> Gateway -> code-server (private Unix socket)
```

DSH和code-server是可替换Adapter/Hosted App，不拥有Chat产品对象。Chat API不依赖DSH类型；Domain/Application不依赖Hono、DSH、Vercel Workflow或pi。

### 2.1 本机运行实例隔离

- production实例固定使用`43110/43111/43112/43114`及主checkout的`.data`，由LaunchAgent常驻并承载正常PWA使用。
- VS Code F5与`pnpm dev:debug`固定使用`44110/44111/44112/44114/44115`、Inspector `44120/44121/44122/44123`及当前worktree的`.data/instances/vscode-debug`；`44123`只调试DSH Host与服务端LifeOS Bridge。
- 两套实例不共享Product Store、Workflow Store、Runtime Binding/Key、Trace、DSH Profile/Bridge状态、PID登记或浏览器Profile；只有固定源码缓存和只读依赖工件可以共享。
- debug事实只是开发数据，不是production副本，也不建立多实例生产Store。debug启动、停止或遗留进程收敛不得向production PID发信号。

## 3. 前端合同

### 3.1 DSH负责

- 会话列表、原生聊天轨迹、Composer、主题、响应式布局和插件Slot。
- 显示Host插件返回的文本流与Client插件提供的产品投影。
- 保存草稿、滚动、当前视图等可丢弃界面状态。

### 3.2 DSH不负责

- 创建或修改Product Store事实。
- 判断Product Run、Plan、Approval、Tool或项目对象的权威状态。
- 直接调用Workflow、Hook、pi、Provider或Memory服务。
- 把DSH Session ID当作产品身份或授权。

### 3.3 LifeOS Bridge负责

- 固定DSH Session与Product Session的Adapter映射。
- 将DSH正常对话请求变成Chat公开Command/Query。
- 保留稳定`commandId`，处理网络结果未知和刷新恢复。
- 用`conversation.input.left`公开Slot显示可用Workflow；选择只是会话草稿，发送时由Chat重新校验并冻结Definition revision/Hash。
- 在DSH公开Slot中展示Plan/HITL；决定仍走Chat Command。
- 把Chat安全执行轨迹投影为DSH原生显示工具调用；显示工具只等待同一Pi结果，不重跑命令。
- 将Chat正式Assistant Message以DSH文本流投影回原生轨迹。
- 为完整Hosted App提供窄Surface与受控Host代理。

`session-title`、`compaction`等DSH内部辅助请求不能创建Chat Message或Run。

## 4. API与事务合同

Query读取资源并返回revision/ETag/cursor；Command表达一次用户意图并使用：

```json
{
  "commandId": "cmd_...",
  "expectedRevision": 7,
  "payload": {}
}
```

规则：

1. 同一`commandId`与同一规范化请求返回原结果；相同ID换正文必须409。
2. 修改已有对象必须CAS；Decision还绑定Plan/Approval的ID、revision和SHA-256。
3. Router不直接写Store；Application在事务中提交事实、Receipt与Outbox。
4. HTTP响应丢失不能产生新的命令身份。
5. 错误使用稳定Problem Details；公开响应不含密钥、Stack、隐藏推理或Runtime私有ID。

## 5. Workflow与pi合同

- Product Run先于Workflow Run存在，两者不能合并。
- Workflow只接收不可变输入和产品引用；通过私有Application活动读取/提交事实。
- Step必须可重放；非确定性值、模型调用和外部I/O进入Step边界。
- pi是Agent节点，不创建Product Session、Approval、Memory或完成事实。
- 完整Executor通过私有幂等Operation协议访问独立AgentSession服务；Workflow不把Pi Session当Checkpoint或产品身份。
- Runtime Key不等于产品授权；Executor在创建Operation和触达Workspace前必须经Application回查运行中Attempt、Contract、Manifest、Context与依赖血缘。
- Tool能力来自Approved Plan编译的Capability白名单；非文本能力必须绑定服务端Workspace Root。
- 文件工具拒绝Workspace Root逃逸；`shell_execute`是显式high-risk Host能力而非沙箱，并使用秘密清洗后的环境。
- Provider与Tool调用先写安全Operation Journal；未闭合副作用在恢复时进入`outcome_unknown`，不自动重放。
- 模型输出先成为候选；确定性校验与Product Commit之后才是正式结果。
- 付费模型失败默认不盲目自动重试；外部副作用必须有幂等、结果未知与对账。
- 普通系统Planning不含Memory。`memory.query`只存在于独立发布、前端显式选择的Memory Planning或用户自建Definition；每个节点冻结Provider描述、来源Message、预算和结果快照，所有查询终态在第一个Planner前聚合成唯一`WorkflowMemoryContext`。Plan修订只复用该引用，不重新查询。
- Memory Planning的`memory.write`节点保存本次用户输入，Application先提交`MemoryWriteIntent + Result`，由当前父Workflow唯一执行；不创建竞争的start Outbox。直接Write Command才提交`Intent + Result + Outbox`并启动独立`MemoryWriteWorkflow`。两者的外部write Step都固定`maxRetries=0`，未知结果只允许用同一`mwi_*`派生身份做只读对账。
- Memory读写Node状态进入Run Activity Journal并投影到公开Execution Trace，由DSH Bridge显示为`Memory · 查询/写入`Trajectory；不复制Memory正文或Provider Payload，Debug Trace不参与。
- DSH、Pi Extension与Workflow Memory均不直接依赖腾讯L0/L1模型；这些层级、Bearer、service/team/user/agent映射只存在于Adapter进程。未来HTTP、SDK或MCP项目必须实现同一窄Port，不能把Provider对象写回Domain。

完整执行服务、身份、Trace和恢复语义见[Pi Coding Executor Service As-built](./pi-coding-executor-service.md)。

## 6. HITL合同

1. Workflow创建私有Hook并请求Application创建Approval或Note Candidate事实。
2. 用户通过DSH Client表面读取Plan/Approval或安全Note Candidate审核DTO。
3. Client把意图交给Bridge Host；Host提交Chat Plan Decision或Note Decision Command。
4. Application校验Principal、Run revision以及Plan/Approval或Candidate的版本与Hash，并原子提交Decision和Resume Outbox。
5. 后端Dispatcher私下恢复Hook。

浏览器永远不持有Hook Token。

## 7. Workbench合同

- 当前状态是Beta：实现保留，但不进入通用CI/CD或远程部署；只有单独启用、修改或准备提升为稳定能力时才执行真实Workbench完成门。
- code-server作为独立进程运行，不拆UI组件，也不复制上游源码。
- 当前只打开精确`CHAT_REPO_ROOT`，使用清洗后的环境、隔离HOME和独立user-data/extensions目录。
- code-server仅绑定受管0600 Unix socket且不监听TCP；Web Gateway代理HTTP与全部动态WebSocket，并将Workbench放在与DSH不同的虚拟Host Origin。
- 受管child固定`EXTENSIONS_GALLERY={}`，默认没有扩展市场serviceUrl，不得连接Open VSX、查询Copilot或从父进程继承Gallery配置；后续扩展Provider必须作为显式能力另行设计。
- `localhost`虚拟Host只允许`/workbench/code/**`，不得访问DSH或`/lifeos`；code-server Service Worker作用域只能是该子路径。
- DSH用顶级Surface打开，关闭后原聊天Session、草稿和滚动保持。
- code-server写文件或执行命令不自动成为Chat产品完成事实。
- 当前本地模式不是OS沙箱；Terminal与扩展以本机用户权限运行，只适用于可信单用户。远程/多用户部署必须换成容器或独立UID Provider。

## 8. 实时与恢复

当前Bridge使用公开Query恢复Run、Messages、Plan/Approval、Note Candidate和安全执行轨迹；执行轨迹先以cursor轮询接入DSH原生Trajectory。未来加入Chat拥有的SSE Cursor Journal时，它只把轮询升级为有序实时投影和资源失效通知，不成为产品事实源，也不改变Query/Command合同。

必须覆盖：浏览器刷新、DSH Host重启、API重启、Workflow Worker恢复、重复Command、响应丢失、过期Decision、Provider结果未知和Workbench进程崩溃。

## 9. 依赖与升级

每个外部依赖记录精确版本、来源、许可证、运行边界、升级测试和退出方式。DSH/code-server不以源码副本进入Chat仓库。DSH当前有且只有一个显式批准的窄派生：公开`later-3/deepseek-harness-chat`保存派生源码、测试与上游汇合历史，Chat直接链接稳定分支消费Trajectory Location、标签与紧凑预览扩展；它不复制UI，也不改变Host、Session或产品事实边界。升级必须先判断上游是否已提供等价插件合同，否则把该窄差异重放到Fork功能分支，并通过DSH源码测试、Fork分支漂移门、合同与真实浏览器E2E；任何扩大修改面都需要重新审核。完整维护规则见[DSH前端派生与维护](./dsh-frontend-maintenance.md)。

## 10. 完成门

1. 全仓格式、lint、typecheck、test、build和生产依赖审计通过。
2. DSH原生Host与Client插件真实启动，不是旁路Adapter页面。
3. 真实浏览器完成发送、Plan、修订/批准/拒绝、执行、正式回复与刷新恢复。
4. 浏览器Bundle/响应/日志不泄漏凭据或Runtime私有身份。
5. Workbench不属于当前通用CI/CD完成门；单独启用、修改或准备提升为稳定能力时，必须真实验证Files、Terminal、Git与Diff，以及WebSocket和停止回收。
