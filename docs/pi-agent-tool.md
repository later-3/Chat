# pi Agent Tool 使用与运行手册

## 1. 当前实现

Chat把pi coding agent注册成一个真实的MAF `FunctionTool`，并由MAF Workflow管理一次完整执行。它不是把一条Shell命令当成“Tool成功”：

```text
用户启动pi Workflow
-> MAF FunctionTool启动pi JSONL RPC子进程
-> pi准备Provider请求
-> Chat Provider Gate生成完整ModelCallDraft并暂停
-> 用户查看、修改、保存新Hash并批准
-> Chat按批准字节调用真实Provider
-> pi提出内部Tool调用
-> Chat Tool Gate展示固定Key、可编辑Value并暂停
-> 用户批准后pi执行真实Tool
-> 下一次Provider请求再次审批
-> pi完成，Product Run与Tool Execution Ledger提交终态和统计
```

前端入口有2个：

1. `工作流 -> pi Agent 受控工具`：运行任务并处理每次模型/Tool审批。
2. `Tool -> pi coding agent`：配置Provider、模型、工作目录、内部Tool、Thinking、调用上限、超时和System Prompt，并查看执行统计。

## 2. 为什么选择JSONL RPC

源码基线是pi固定提交`2b00dade7cec918aefb025c8b7a4fa304a30acdd`，本机真实运行版本是`@earendil-works/pi-coding-agent 0.81.1`，Node是`22.23.1`。

| 接入方式 | 结论 | 原因 |
|---|---|---|
| 每次执行`pi -p` | 不采用 | 适合一次性文本输出，但跨多轮审批时必须反复重建进程和状态，难以关联结构化Tool事件 |
| 进程内TypeScript SDK | 不采用 | Python后端需要引入Node侧常驻服务和自定义RPC合同，增加第二套部署与升级边界 |
| pi官方JSONL RPC | 采用 | `rpc-entry.ts`、`rpc-mode.ts`和`rpc-types.ts`提供长期子进程、结构化命令、事件、用量和状态，能在一个pi回合内多次暂停/继续 |

当前实现通过显式Node路径启动pi的`dist/cli.js --mode rpc`，每次执行使用隔离的临时Agent目录、模型配置和治理扩展；不会读取或改写用户全局pi配置。

## 3. 两道治理门

### 3.1 Provider Gate

pi的`before_provider_request`扩展事件不适合作为安全门。固定源码`core/extensions/runner.ts`会捕获该处理器异常并继续运行，因此不能提供“审批服务失败就绝不发送”的fail-closed保证。

Chat改用本机Provider网关：pi模型配置只指向Chat生成的短期本地网关地址；网关收到请求后创建正常的`ModelCallDraft`，绑定Provider、协议、完整Body和Hash。只有当前Approval批准后，网关才把同一份规范请求字节转发给真实Provider。每一次后续模型调用都会重新进入该门。

### 3.2 Tool Gate

pi固定源码`core/agent-session.ts`和`core/extensions/runner.ts`在真实Tool执行前触发`tool_call`；处理器可阻止调用，并允许修改参数。Chat为每个pi进程注入治理扩展，把调用转换成RPC编辑请求，再映射为MAF/AG-UI Interrupt。

Tool名称只能来自服务端配置中的真实pi内置Tool；前端不能输入`new_tool`或改名。参数Key固定，Value可修改。放弃会结束整个pi任务，不会制造Tool成功或Assistant成功。

## 4. 配置

私有`backend/config.json`中的运行时配置使用以下结构；仓库中的脱敏样例位于`backend/config.example.json`：

```json
{
  "pi_agent": {
    "enabled": true,
    "node_path": "/absolute/path/to/node-22-or-newer",
    "cli_path": "/absolute/path/to/pi-coding-agent/dist/cli.js",
    "allowed_working_roots": ["/absolute/path/to/allowed/projects"],
    "default_working_directory": "/absolute/path/to/allowed/projects",
    "gateway_origin": "http://127.0.0.1:8030"
  }
}
```

约束：

1. `node_path`和`cli_path`必须是后端可执行/可读取的绝对路径。
2. 工作目录必须存在，并位于`allowed_working_roots`之一；前端不能扩大根目录。
3. `gateway_origin`只能是本机HTTP地址，避免把短期授权网关暴露为远程公共入口。
4. Provider密钥仍只来自服务端Provider配置，不传给浏览器，也不写入pi临时配置。
5. JSON运行配置是启动快照；修改后要重启后端。页面内Tool配置有独立Revision，只影响之后启动的Workflow。

## 5. 统计与恢复语义

每次执行写入`ToolExecution`记录，页面展示：

1. 配置Revision。
2. 模型调用数和内部Tool调用数。
3. 输入、输出、缓存读写Token。
4. Provider报告的成本（若Provider/pi事件提供）。
5. 总耗时、Tool事件和失败代码。

正常终态包括`已完成`、`失败`和`已放弃`。进程退出前未写终态的`running`记录会在下次启动收敛为`已中断 / process_restarted`，不会永久显示假运行中。

当前恢复保证是R1级产品事实恢复：可以解释此前执行到过哪里、调用了多少次、为何中断；尚未持久化pi RPC进程、MAF Checkpoint或审批Interrupt，所以后端重启后不会从中间自动继续，也不会自动重做未知副作用。

## 6. 验证

自动验证：

```bash
uv run pytest backend/tests/test_pi_agent.py -q
(cd frontend && npm test && npm run typecheck && npm run build)
./scripts/verify.sh
```

`backend/tests/test_pi_agent.py`覆盖：运行时请求草稿、真实Tool绑定、配置CAS与路径策略、精确Provider字节、两次模型审批、Tool参数改写、放弃无假成功、统计与启动中断收敛。

2026-07-21的真实验证使用现有私有Provider配置完成：

1. JSONL RPC无Tool回合：1次模型调用，返回指定文本。
2. JSONL RPC Tool回合：2次模型调用、1次`read`，参数从`README.md`改为`PROJECT_STATE.md`后执行。
3. 浏览器同一场景最终Product Message为`BROWSER_PI_OK`，监控记录模型2次、Tool 1次；371px无横向溢出，全新页面控制台0错误。

## 7. 已知边界

1. 当前只允许`read/grep/find/ls/bash/edit/write`；高副作用Tool仍需要后续Tool Operation Ledger、幂等、结果未知和对账设计。
2. Provider Approval和Workflow Checkpoint仍为单进程状态；刷新/进程重启后的持久HITL属于Session Phase 7，不由本功能冒充完成。
3. 当前每个pi执行使用独立子进程，不提供跨Product Run共享pi Session。
4. 真实Provider的计费和Token口径以Provider/pi事件为准；缺失字段显示0，不推测成本。
