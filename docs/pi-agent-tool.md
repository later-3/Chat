# pi Agent Tool 使用与运行手册

## 1. 当前实现

Chat把pi coding agent作为同一Product Run中的受治理`ToolExecution`，由持续协作主Workflow
v1.7.0中的确定性Executor启动。它不是第二个用户Workflow，也不是把一条Shell命令当成“Tool成功”：

```text
用户在主Workflow中批准pi_readonly RunSpec
-> execution_route选择pi_readonly
-> pi_readonly_dispatch启动pi JSONL RPC子进程
-> pi准备Provider请求
-> Chat Provider Gate生成完整ModelCallDraft并暂停
-> 用户查看、修改、保存新Hash并批准
-> Chat按批准字节调用真实Provider
-> pi提出内部只读Tool调用
-> Chat按HITL策略自动继续或暂停
-> Chat-owned Tool Gateway执行read/grep/find/ls
-> 下一次Provider请求再次审批
-> pi完成，确定性Result Assembly核对Result Hash
-> Product Run、ToolExecution与最终消息提交终态
```

前端入口有2个：

1. 持续协作主Workflow的设计者工作台：查看执行路由、pi节点结果、模型/Tool子活动和治理事实。
2. `Tool -> pi coding agent`：配置Provider、模型、工作目录、内部Tool、Thinking、调用上限、超时和System Prompt，并查看执行统计。

旧`governed-pi-agent`只保留为不可选诊断/回归合同，不再要求用户切换根Workflow。

## 2. 为什么选择JSONL RPC

源码基线是pi固定提交`2b00dade7cec918aefb025c8b7a4fa304a30acdd`，本机真实运行版本是`@earendil-works/pi-coding-agent 0.81.1`，Node是`22.23.1`。

| 接入方式 | 结论 | 原因 |
|---|---|---|
| 每次执行`pi -p` | 不采用 | 适合一次性文本输出，但跨多轮审批时必须反复重建进程和状态，难以关联结构化Tool事件 |
| 进程内TypeScript SDK | 不采用 | Python后端需要引入Node侧常驻服务和自定义RPC合同，增加第二套部署与升级边界 |
| pi官方JSONL RPC | 采用 | `rpc-entry.ts`、`rpc-mode.ts`和`rpc-types.ts`提供长期子进程、结构化命令、事件、用量和状态，能在一个pi回合内多次暂停/继续 |

当前实现通过显式Node路径启动pi的`dist/cli.js --mode rpc`，每次执行使用隔离的临时Agent目录、
模型配置和治理扩展；不会读取或改写用户全局pi配置。SD2同时使用`--no-builtin-tools`、
`--no-context-files`、`--no-skills`、`--no-prompt-templates`和`--no-session`：

1. pi不能沿工作目录祖先隐式加载`AGENTS.md`或`CLAUDE.md`，避免越过已批准Repository Binding。
2. Project、Work、Plan、Context revision、治理规则与用户批准范围由Chat编译为有来源的StepInput。
3. `--no-session`仍使用内存Session；当前ToolExecution可解释此前终态，但进程退出后不能恢复pi内部
   对话树。

## 3. 两道治理门

### 3.1 Provider Gate

pi的`before_provider_request`扩展事件不适合作为安全门。固定源码`core/extensions/runner.ts`会捕获该处理器异常并继续运行，因此不能提供“审批服务失败就绝不发送”的fail-closed保证。

Chat改用本机Provider网关：pi模型配置只指向Chat生成的短期本地网关地址；网关收到请求后创建正常的`ModelCallDraft`，绑定Provider、协议、完整Body和Hash。只有当前Approval批准后，网关才把同一份规范请求字节转发给真实Provider。每一次后续模型调用都会重新进入该门。

本机网关使用独立`X-Chat-Pi-Token`绑定当前进程内pi执行，不复用模型SDK的`Authorization`。后者
仍属于Provider认证语义，可能由pi配置或SDK生成、合并和替换；混用会让本机网关把有效执行误判为
401。网关保留规范化Bearer兼容路径，但独立Header一旦存在就不会降级绕过，比较采用常量时间函数，
日志只记录脱敏指纹与活动执行数。

### 3.2 Tool Gate

pi固定源码`core/agent-session.ts`和`core/extensions/runner.ts`在真实Tool执行前触发`tool_call`；
处理器可阻止调用，并允许修改参数。Chat为每个pi进程注入Custom Tool Extension；Extension只声明
`read/grep/find/ls`，真实读取通过短期Bearer令牌的本机Gateway回到Python后端。每次调用重新验证
Snapshot、路径、symlink、Protected Source和结果上限，pi的cwd和内置Tool不构成授权边界。

Tool名称只能来自服务端目录；前端不能输入`new_tool`或改名。低风险只读Tool默认可在HITL系统下限内
自动继续，用户仍可按作用域改成每次确认。SD2上限是6次模型调用、24次只读Tool、600秒和64KiB
单Tool结果；拒绝或放弃不会制造Tool成功或Assistant成功。

SD3在同一Gateway边界新增受管Execution Workspace中的单文件精确`edit`。每次编辑先形成不可变
Tool Operation和bounded diff，绑定路径、参数、Workspace、Snapshot及pre/post Hash；一次性授权
被消费后才能落盘。`write/bash/commit/push`仍不开放，活动仓库不会被直接修改。

## 4. 配置

私有`backend/config.json`中的运行时配置使用以下结构；仓库中的脱敏样例位于`backend/config.example.json`：

```json
{
  "pi_agent": {
    "enabled": true,
    "contract_version": "0.81.1",
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
2. `contract_version`是运维固定并进入健康/统计投影的RPC合同版本；不能从失败后的CLI输出猜测。
3. 工作目录必须存在，并位于`allowed_working_roots`之一；前端不能扩大根目录。
4. `gateway_origin`只能是本机HTTP地址，避免把短期授权网关暴露为远程公共入口。
5. Provider密钥仍只来自服务端Provider配置，不传给浏览器，也不写入pi临时配置。
6. JSON运行配置是启动快照；修改后要重启后端。页面内Tool配置有独立Revision，只影响之后启动的Workflow。

## 5. 统计与恢复语义

每次执行写入`ToolExecution`记录，页面展示：

1. 配置Revision。
2. 模型调用数和内部Tool调用数。
3. 输入、输出、缓存读写Token。
4. Provider报告的成本（若Provider/pi事件提供）。
5. 总耗时、Tool事件和失败代码。

正常终态包括`已完成`、`失败`和`已放弃`。进程退出前未写终态的
`starting/running/waiting_human`记录会在下次启动收敛为`已中断 / process_restarted`，不会永久
显示假运行中。

当前恢复保证是R1级产品事实恢复：可以解释此前执行到过哪里、调用了多少次、为何中断。主Workflow
Checkpoint不能重建pi RPC进程或其内存边界，所以后端重启后不会从中间自动继续，也不会自动重做调用。

## 6. 验证

自动验证：

```bash
.venv/bin/python -m pytest backend/tests/test_pi_agent.py backend/tests/test_continuous_pi_readonly.py -q
(cd frontend && npm test && npm run typecheck && npm run build)
./scripts/verify.sh
```

自动化覆盖运行时请求草稿、真实Tool绑定、配置CAS、路径/symlink/Protected Source、64KiB结果、
精确Provider字节、Chat Completions Tool loop、两次模型审批、放弃无假成功、统计与三种非终态启动
中断收敛。

2026-07-25的主Workflow真实Dogfood使用现有私有Provider配置完成：Product Run
`58e48b4b-25fd-44b0-ac35-f099bbd8821a`产生2次模型审批、2次Chat-owned `read`，最终只读取
`README.md`与`PROJECT_STATE.md`；模型/Tool/Token/耗时、Result Hash和最终消息全部提交成功，
Repository没有Shell、文件写入或Git操作。桌面与520 CSS像素窄屏工作台均可查看节点结果和子活动，
控制台0错误。

SD3首次真实写入复验暴露的HTTP 401来自Chat本机Gateway，已通过独立Header及自动回归修复。随后
Ark与DashScope复验均在远端响应流阶段超时或断连；Product Run保守收敛为`outcome_unknown`，没有
创建Tool Operation，也没有修改Snapshot或活动仓库。因此这组运行只能证明安全失败边界，不能作为
真实pi精确`edit`成功证据。

## 7. 已知边界

1. SD2只读模式只允许`read/grep/find/ls`；SD3隔离编辑模式额外允许受管worktree内的精确
   `edit`。`write/bash/commit/push`仍未开放。
2. 主Workflow审批安全点可以持久恢复，但活动pi进程及其内存Model/Tool边界不能跨进程恢复。
3. 当前每个pi执行使用独立子进程，不提供跨Product Run共享pi Session。
4. 真实Provider的计费和Token口径以Provider/pi事件为准；缺失字段显示0，不推测成本。
5. 当前pi不自动加载工作目录及祖先的`AGENTS.md`/`CLAUDE.md`；主Workflow只传递批准的Harness
   StepInput。SD3的Execution Workspace与Tool Operation Ledger仍不能替代Evidence完成门。
