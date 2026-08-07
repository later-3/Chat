# Chat 本地调试与 Trace（B1 基线）

本文固定本地调试入口、端口与 Trace 查询方式，对应任务书§7/§8。
规则来源：[后端闭环任务书](../tasks/planning-execution-backend-closure.md)；清理只作用于已确认属于本项目的进程，不使用模糊`pkill`伤害其他应用。

## 1. 固定端口

| 用途 | 地址/端口 |
|---|---|
| Web HTTP | `127.0.0.1:43110` |
| Chat API HTTP | `127.0.0.1:43111` |
| Workflow本地运行时 | `127.0.0.1:43112` |
| API Node Inspector | `127.0.0.1:43120` |
| Workflow Node Inspector | `127.0.0.1:43121` |

Vite使用`--strictPort`，API/Workflow端口被占用时进程直接失败关闭，禁止自动换号。
并行期不修改`apps/web/vite.config.ts`（属于P1.2 PR），Web端口由`scripts/debug/start-web.mjs`经CLI传入。

## 2. 一键调试（VS Code）

主入口：Compound **“Chat：完整后端闭环”**，启动顺序固定：

```text
chat-debug:preclean（清理上次Chat调试进程并校验端口）
-> Chat：Workflow 运行时（43112，Inspector 43121）
-> chat-debug:wait-workflow 等待 /healthz
-> Chat：API（43111，Inspector 43120）
-> chat-debug:wait-api 等待 /api/readyz
-> chat-debug:start-web（Vite 43110）
-> Chat：Web 浏览器（打开 http://127.0.0.1:43110）
```

- 进程登记：被调试进程通过`node --import scripts/debug/register-process.mjs`
  把`role/pid/port`写入`.data/debug/pids.json`；Web由`start-web.mjs`登记进程组。
- 清理语义：`preclean`/`stop`只终止pids.json中有记录、且通过身份复核
  （命令片段+启动时间容差）的进程；SIGTERM后有限等待，仍存活且身份一致才SIGKILL。
- 端口被未知应用占用时：启动失败并报告端口、PID与命令行，**不会**终止未知进程；
  请手动释放端口后重试。
- 启动失败（如Web超时）会清理本轮已启动进程，不留下半套服务占端口。
- 停止调试（`stopAll`）后执行`chat-debug:stop`释放本轮进程与端口。
- B1阶段Workflow运行时为`scripts/debug/workflow-stub.mjs`占位（仅`/healthz`），
  B4将替换为真实Vercel Workflow运行时，端口与健康检查合同不变。

命令行等价入口：

```bash
pnpm debug:preclean   # 清理并校验冻结端口
pnpm debug:stop       # 停止本轮调试进程
```

## 3. Trace 查询

Trace按任务书§7.2写入`<仓库根>/.data/traces/chat-trace-YYYY-MM-DD.jsonl`
（一行一个JSON对象，UTC日期切分；`.data/`不进入Git）。

```bash
pnpm debug:trace --run run_xxx        # 按Product Run重建时间线
pnpm debug:trace --request req_xxx    # 按请求
pnpm debug:trace --command cmd_xxx    # 按命令
```

- 输出：stdout为脱敏后的JSONL事件（按timestamp+文件+行号稳定排序），stderr为摘要。
- 退出码：0成功（含0条）、2用法错误、3读取或Schema校验失败。
- 读取失败关闭：损坏行报告文件与行号，**绝不修改原始JSONL**。
- 脱敏：写入侧与读取侧双重执行；API Key、Authorization、Cookie、各类Token、
  Prompt、完整Payload与隐藏推理键替换为`[redacted]`，超长字符串截断；
  `tokenUsage`等用量字段允许保留。

## 4. B1 范围说明

- API已产生`http.command.received/completed/rejected`事件；`/api/healthz`与
  `/api/readyz`就绪探针可用（B2/B4起`readyz`将检查Product Store与Workflow依赖）。
- `apps/api/src/trace/jsonl-sink.ts`是并行期的本地实现；PR #3合并后
  （锁文件解冻）切换为`@chat/realtime`的`createTraceSink`（代码内TODO(B6)）。
- Provider、Workflow、Hook、pi与Product Commit事件在B4/B5/B7接入，
  事件名已在`packages/contracts/src/trace.ts`按任务书§7.3冻结。
