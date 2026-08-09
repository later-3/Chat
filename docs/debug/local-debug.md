# Chat 本地调试与 Trace

本文固定本地调试入口、端口与 Trace 查询方式，对应任务书§7/§8。
规则来源：[后端闭环任务书](../tasks/planning-execution-backend-closure.md)；清理只作用于已确认属于本项目的进程，不使用模糊`pkill`伤害其他应用。

## 1. 固定端口

| 用途 | 地址/端口 |
|---|---|
| Web HTTP | `127.0.0.1:43110` |
| Chat API HTTP | `127.0.0.1:43111` |
| Workflow本地运行时 | `127.0.0.1:43112` |
| memmy HTTP | `127.0.0.1:18960` |
| Tencent MemoryCore HTTP | `127.0.0.1:18970` |
| API Node Inspector | `127.0.0.1:43120` |
| Workflow Node Inspector | `127.0.0.1:43121` |
| memmy Node Inspector | `127.0.0.1:43122` |
| MemoryCore包装进程 Node Inspector | `127.0.0.1:43123` |

Vite使用`--strictPort`，API/Workflow端口被占用时进程直接失败关闭，禁止自动换号。
并行期不修改`apps/web/vite.config.ts`（属于P1.2 PR），Web端口由`scripts/debug/start-web.mjs`经CLI传入。

## 2. 一键调试（VS Code）

主入口：Compound **“Chat：完整后端闭环”**，启动顺序固定：

```text
chat-debug:prepare-compound（只执行一次安全preclean，再顺序准备两套Memory缓存）
-> 并行准备并启动两个固定Memory服务：
   - Chat：Memory（memmy）（18960，Inspector 43122）
   - Chat：Memory（Tencent MemoryCore）（18970，包装进程Inspector 43123）
-> chat-debug:wait-memory + chat-debug:wait-memorycore 等待两个真实健康检查
-> Chat：Workflow 运行时（43112，Inspector 43121）
-> chat-debug:wait-workflow 等待 /healthz
-> Chat：API（43111，Inspector 43120；同时确认Workflow与两个Memory已就绪）
-> chat-debug:wait-api 等待 /api/readyz
-> chat-debug:start-web（Vite 43110）
-> Chat：Web 浏览器（打开 http://127.0.0.1:43110）
```

- 进程登记：被调试进程通过`node --import scripts/debug/register-process.mjs`
  把`role/pid/port`写入`.data/debug/pids.json`；两个Memory登记的都是包装进程，包装进程收到停止信号后会安全转发给真实服务子进程；Web由`start-web.mjs`登记进程组。
  登记是安全前置条件：登记失败时进程终止启动，不产生无法清理的未登记服务。
- 单独启动 **“Chat：Memory（memmy）”** 也会先执行`chat-debug:preclean`，再运行
  `pnpm memory:prepare:fixed`准备固定提交源码缓存，最后才执行
  `scripts/memory/start-fixed-memmy.mjs`；不会使用参考仓库的工作树。
- 单独启动 **“Chat：Memory（Tencent MemoryCore）”** 同样先执行安全preclean，核验固定
  commit/tree并准备隔离缓存，再启动`127.0.0.1:18970`。VS Code通过
  `load-memorycore-debug-env.mjs`强制MemoryCore、Workflow和API使用同一套仅loopback有效的
  调试身份；即使`.env`配置了远端地址，主Compound也不会把本地断点请求发往远端。
- 单独启动 **“Chat：Workflow 运行时”** 前，必须先启动并确认两个Memory服务就绪；该配置
  只等待健康检查，不会自行启动Memory。主Compound会自动安排此顺序。
- Compound统一门：`chat-debug:prepare-compound`先完成一次安全preclean和两套缓存准备，随后使用
  两个隐藏的Memory内部配置启动服务。Compound子配置的等待链不会再次触发preclean，因此不会发生
  “后启动的Memory清理任务误杀已Ready服务”的竞态。两个可见Memory配置仍保留单独启动能力，
  单独启动时各自先执行安全preclean。只负责汇合依赖的两个空任务使用`process`类型，避免
  `node -e`参数被zsh二次解释。
- Node调试配置显式使用`program`指向入口文件；`runtimeArgs`只放`--import`加载器，防止
  js-debug退化为从stdin执行`-`。`.env`由被调试进程内部安全加载，不使用会把Key展开到
  集成终端命令行的`envFile`。TypeScript加载器使用Workflow/API各自包内的`tsx`固定路径，
  不从仓库根目录解析未声明的裸包名。
- 6个Node服务使用`internalConsole`由js-debug直接创建进程，日志进入VS Code Debug Console；
  服务不需要交互式stdin，因此不经过多个集成终端并发初始化zsh，避免命令已写入但未执行的竞态。
- Node进程同时用`--inspect=127.0.0.1:<冻结端口>`显式开放43120～43123；`launch.json`里的
  `port`字段不能替代真实监听验收，Inspector只绑定loopback且纳入统一preclean冲突检查。
- Workflow/API设置空`outFiles`，禁止js-debug因工作区恰好存在`dist`而把`.ts`入口替换成
  可能过期的构建产物；实际进程参数必须始终指向workspace源码，tsx负责运行时转换与源码映射。
- 清理语义：`preclean`/`stop`只终止pids.json中有记录、且通过身份复核
  （命令片段+启动时间容差）的进程；SIGTERM后有限等待，仍存活且身份一致才SIGKILL。
- 端口被未知应用占用时：启动失败并报告端口、PID与命令行，**不会**终止未知进程；
  请手动释放端口后重试。
- 启动失败（如Web超时）会清理本轮已启动进程，不留下半套服务占端口。
- 停止调试（`stopAll`）后执行`chat-debug:stop`释放本轮进程与端口。
- 停止Memory时，`stop`先向已登记包装进程发送`SIGTERM`，至少等待7秒让它转发给真实
  memmy子进程；仍存活时才再次身份复核并`SIGKILL`，不会用模糊进程匹配。
- Workflow与两个Memory均为真实本地运行时；API只有在三者的健康检查均通过后才启动。

命令行等价入口：

```bash
pnpm debug:preclean   # 清理并校验冻结端口
pnpm debug:stop       # 停止本轮调试进程
```

## 3. MemoryCore断点顺序

规划召回建议按以下顺序设置断点：

1. `packages/workflows/src/planning-execution-workflow.ts:99`：进入Memory节点。
2. `packages/workflows/src/workflow-planning-steps.ts:145`：耐久查询Step。
3. `packages/memory-runtime/src/tencent-memorycore-adapter.ts:441`：真实`atomic/search`。
4. `packages/workflows/src/workflow-planning-steps.ts:269`：Memory上下文进入真实Planner。

显式导入建议按以下顺序设置断点：

1. `packages/application/src/memory-import-use-cases.ts:105`：冻结Intent/Result/Outbox。
2. `apps/api/src/outbox-dispatcher.ts:306`：派发MemoryImportWorkflow。
3. `packages/workflows/src/memory-import-workflow.ts:104`：导入与对账状态分支。
4. `packages/workflows/src/memory-import-workflow-steps.ts:118`：唯一外部写入Step。
5. `packages/memory-runtime/src/tencent-memorycore-adapter.ts:494`：真实`conversation/add`。
6. `packages/memory-runtime/src/tencent-memorycore-adapter.ts:559`：L0/L1只读对账。
7. `packages/application/src/memory-import-use-cases.ts:545`：提交accepted。
8. `apps/api/src/outbox-dispatcher.ts:460`：确认accepted不会被终态监督器降级。

Workflow Step通过tsx解析回TypeScript源码，断点应设置在上述`.ts`文件，不要进入
`.workflow-bundle`或`dist`。MemoryCore Inspector调试的是Chat拥有的包装/启动边界；第三方固定
源码进程保持环境隔离，日常排查优先观察Adapter请求与严格响应分类。

## 4. Project Intake断点顺序

先按`.env.example`配置`CHAT_PROJECT_ROOTS_JSON`，只加入你明确允许Chat只读观察的工作区。随后从浏览器切换“建立项目”、选择资源并发送消息，建议按以下顺序设置断点：

1. `packages/application/src/project-use-cases.ts`的`beginProjectIntake`：原子提交Message、queued Candidate和Start Outbox。
2. `apps/api/src/outbox-dispatcher.ts`的`dispatchProjectIntake`：派发独立Project Intake Workflow。
3. `packages/workflows/src/project-intake-workflow.ts`的`projectIntakeWorkflow`：进入耐久建项链与Hook等待。
4. `packages/workflows/src/project-intake-workflow-steps.ts`的`prepareProjectCandidateStep`：Workflow到API私有Command边界。
5. `packages/pi-runtime/src/project-intake-understanding.ts`的`understand`：pi与当前服务端Model Profile的真实模型调用。
6. `packages/project-runtime/src/registry.ts`的`observe`：允许根内Git、治理文档和脚本清单观察。
7. `packages/application/src/project-use-cases.ts`的`prepareProjectCandidateForReview`：模型理解、资源证据与Domain规则编译Candidate。
8. 同文件的`decideProjectCandidate`：用户确认后原子提交Project账本和Resume Outbox。

项目建成后，从浏览器切换“管理项目”发送待办、决定或贡献，可在`beginProjectManagementCandidate`和`decideProjectManagementCandidate`断点观察“正式Message → 可修改Candidate → 确认后单一账本事实”。这条简单确定性链不调用模型，也不启动额外Workflow。

## 5. Trace 查询

Request ID规则：API不信任客户端`x-request-id`，只有通过受限Schema（`req_`前缀）
的传入ID才被复用，否则生成新的服务端ID；响应头始终返回最终生效ID。
Trace写入失败不影响业务响应，但会计入内部故障计数并输出不含事件内容的稳定错误日志。

Trace按任务书§7.2写入`<仓库根>/.data/traces/chat-trace-YYYY-MM-DD.jsonl`
（一行一个JSON对象，UTC日期切分；`.data/`不进入Git）。

```bash
pnpm debug:trace --run run_xxx        # 按Product Run重建时间线
pnpm debug:trace --request req_xxx    # 按请求
pnpm debug:trace --command cmd_xxx    # 按命令
```

- 输出：stdout为严格合同校验通过的JSONL事件（按timestamp+文件+行号稳定排序），stderr为摘要。
- 退出码：0成功（含0条）、2用法错误、3读取或校验失败。
- 读取失败关闭：损坏行或不符合严格合同的事件（含旧版任意`attributes`事件）报告文件与行号，**绝不修改原始JSONL**。
- 内容边界：Trace合同是以`eventName`判别的严格联合，不存在任意`attributes`内容通道；
  HTTP只记method/route template/status，Provider只记模型、请求ID、耗时与Usage等白名单字段，
  正文、密钥、Prompt与Provider Payload在结构上无法写入（不是写入后脱敏）。
  完整历史回放（组合Product Store正文）属B7的`pnpm debug:replay`，见任务书§7.5。

## 6. B1 范围说明

- API已产生`http.command.received/completed/rejected`事件；`/api/healthz`与
  `/api/readyz`就绪探针可用（B2/B4起`readyz`将检查Product Store与Workflow依赖）。
- API使用`@chat/realtime`提供的唯一Trace Sink（`createTraceSink`）；
  `packages/realtime`声明自己的`@types/node`类型依赖，不存在跨包typeRoots引用。
- Provider、Workflow、Hook、pi与Product Commit事件在B4/B5/B7接入，
  事件名已在`packages/contracts/src/trace.ts`按任务书§7.3冻结。

## 7. 端口冲突报告的安全边界

- 进程身份复核在内部使用完整命令行片段（防止PID复用误杀），但不输出到报告或Trace。
- 面向用户的端口冲突报告只包含：端口、PID、可执行文件basename（如`node`）。
- 未知进程的完整argv可能含其他应用的Token、密码或私有路径，绝不输出。
