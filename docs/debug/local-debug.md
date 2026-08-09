# Chat 本地调试与 Trace

本文说明Chat应用统一的本地启动、VS Code调试、端口与Trace查询方式。
当前运行合同见[统一开发启动与调试任务书](../tasks/app-development-runtime.md)；历史验收背景见
[后端闭环任务书](../tasks/planning-execution-backend-closure.md)。清理只作用于已确认属于本项目的进程，
不使用模糊`pkill`伤害其他应用。

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

Vite使用`--strictPort`，API/Workflow端口被占用时进程直接失败关闭，禁止自动换号。
Memory是本地真实依赖，但不是默认调试目标，因此不开放Inspector；日常在Chat自己的API、Workflow和
`packages/memory-runtime` Adapter中设置断点。

## 2. 统一启动入口

仓库拥有唯一服务图，VS Code不拥有应用生命周期：

```text
preflight（清理已登记旧进程/专属调试浏览器 + 拒绝未知端口占用）
→ 校验/准备固定Memory源码缓存
→ 构建Workflow Bundles
→ 启动所选Memory并逐个等待真实健康检查
→ 启动Workflow并等待/healthz
→ 启动API并等待/api/readyz
→ 启动Vite并等待页面
→ 输出 [chat] ready: http://127.0.0.1:43110/
```

### 2.1 终端

```bash
pnpm dev                                      # 默认启动两套Memory、Workflow、API和Web
pnpm dev -- --memory=memmy                   # 只启动memmy依赖
pnpm dev -- --memory=memorycore              # 只启动MemoryCore依赖
pnpm dev:debug                                # 同一服务图；API/Workflow开放Inspector
pnpm dev:status                               # 查看登记与监听状态
pnpm dev:stop                                 # 安全停止已登记进程
```

`pnpm dev`与`pnpm dev:debug`都调用`scripts/dev/start.mjs`。启动器是本地开发工具，不是生产部署器；
生产环境仍由未来部署编排分别管理Chat进程和外部依赖。

### 2.2 VS Code

唯一入口是 **“Chat：调试应用”**。它直接调用同一个`scripts/dev/start.mjs --debug`，在唯一Debug
Console中汇总带服务前缀的日志；应用输出Ready标记后才启动Chrome。`.vscode/tasks.json`不再存在，
VS Code不复制Memory、Workflow、API和Web的启动/停止合同。

前端通过内联`pwa-chrome`会话启动，固定使用当前worktree的`.data/debug/browser-profile`。启动器会在
服务准备前只查找带这个精确`--user-data-dir`的Chrome主进程，先SIGTERM、再次身份复核后才可能
SIGKILL，并在进程收敛后删除该Profile中的`SingletonLock/Socket/Cookie`和`code.lock`。日常Chrome
没有这个参数，不会成为清理目标。父会话停止时使用`cleanUp: wholeBrowser`和`killBehavior: forceful`
收敛专属浏览器，因此正常停止和下一次F5都不需要开发者手动关窗口。

### 2.3 就绪期限与失败

- Memory冷启动期限为180秒；Workflow、API和Web为30秒。
- 期限从对应进程`spawn`成功后开始，不包含前置服务准备时间；这不是业务倒计时，也不重试用户命令。
- 探针每250ms复核进程状态与HTTP；单次HTTP最长1.5秒。进程提前退出时立即失败。
- 任一必要服务失败，启动器停止本轮已启动进程并退出非0，不留下半套应用。
- 端口被未知应用占用时只报告端口、PID和安全进程名，不终止未知进程。

### 2.4 进程、缓存与秘密

- 应用监督器是`.data/debug/pids.json`的正常单写者；终端强制中断后，下一次status/start/stop会剔除
  已确认退出或僵尸的记录。活PID仍需通过命令片段和启动时间身份复核。
- Memory包装进程收到SIGTERM后向真实子进程转发；安全清理至少等待7秒后才考虑SIGKILL。
- 同一Git仓库的worktree共享主仓库`.data/cache`中经过commit/tree/Hash校验的固定源码缓存；
  Memory数据库、Product Store、Workflow Store和Trace仍保存在各worktree自己的`.data`中。
- `.env`和本地Provider配置由目标进程内部加载，不写入`launch.json`、argv、日志或Git。
- `pnpm dev:debug`只开放API `43120`和Workflow `43121`；Memory第三方进程不开放Inspector。
- `pnpm dev:stop`同时收敛已登记Chat进程与当前worktree的专属调试浏览器；未知浏览器不处理。

保留的低层安全入口：

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
`.workflow-bundle`或`dist`。第三方Memory进程保持环境隔离，日常排查优先观察Chat Adapter请求与
严格响应分类。

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
