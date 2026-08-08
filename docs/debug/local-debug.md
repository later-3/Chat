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
chat-debug:preclean（清理上次Chat调试进程并校验端口）
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
- Compound统一门：`chat-debug:preclean`先于所有子会话执行；Memory的独立启动任务也按顺序
  重跑该安全门。Workflow构建只等待Memory，不会并行触发第二次preclean误杀已登记的Memory。
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

## 4. Trace 查询

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

## 5. B1 范围说明

- API已产生`http.command.received/completed/rejected`事件；`/api/healthz`与
  `/api/readyz`就绪探针可用（B2/B4起`readyz`将检查Product Store与Workflow依赖）。
- API使用`@chat/realtime`提供的唯一Trace Sink（`createTraceSink`）；
  `packages/realtime`声明自己的`@types/node`类型依赖，不存在跨包typeRoots引用。
- Provider、Workflow、Hook、pi与Product Commit事件在B4/B5/B7接入，
  事件名已在`packages/contracts/src/trace.ts`按任务书§7.3冻结。

## 6. 端口冲突报告的安全边界

- 进程身份复核在内部使用完整命令行片段（防止PID复用误杀），但不输出到报告或Trace。
- 面向用户的端口冲突报告只包含：端口、PID、可执行文件basename（如`node`）。
- 未知进程的完整argv可能含其他应用的Token、密码或私有路径，绝不输出。
