# Chat与pi的两种调试模式

**归档日期**：2026-07-29
**分类**：调试实战
**关联源码**：

- [Chat的VS Code启动配置](../../.vscode/launch.json)
- [Chat的VS Code启动任务](../../.vscode/tasks.json)
- [pi调试开关脚本](../../scripts/configure-pi-debug.py)
- [pi运行配置解析](../../backend/app/config.py)
- [PiRuntimeManager.start](../../backend/app/pi_gateway.py)
- [PiExecution.start](../../backend/app/pi_runtime.py)
- pi仓库的VS Code启动配置：`/Users/xulater/Code/opc-os/pi/.vscode/launch.json`
- pi仓库的VS Code构建任务：`/Users/xulater/Code/opc-os/pi/.vscode/tasks.json`
- pi RPC入口：`/Users/xulater/Code/opc-os/pi/packages/coding-agent/src/main.ts`
- pi RPC命令循环：`/Users/xulater/Code/opc-os/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts`

## 问题

日常开发需要两种调试能力：

1. 只调试Chat源码，但持续协作主Workflow仍能把pi当执行层正常调用。
2. 同时调试Chat与pi源码，Chat的Python断点和pi的TypeScript断点都能命中。

这两种模式应当怎样选择、启动和验证？为什么联合调试必须使用两个VS Code窗口？

## 回答

当前工程已经提供两个独立入口：

| 需要 | Chat窗口选择 | pi窗口 | pi是否执行 | 能否进入pi TypeScript断点 |
|---|---|---|---:|---:|
| 只调试Chat | `Chat Full Stack` | 不打开 | 是 | 否 |
| 联合调试Chat + pi | `Chat Full Stack (pi External Debug)` | 选择`Attach to Chat pi Runtime (9230)` | 是 | 是 |

最重要的结论是：**两种模式使用的是同一份本地编译pi执行层。区别只在新pi子进程是否携带Node
Inspector，以及pi源码窗口是否附加调试器。**

## 1. 一个具体场景

假设你在Chat里发送：

> 检查README中的项目标题，并说明判断依据，不要修改文件。

持续协作主Workflow完成Intent、Context、Plan和RunSpec后，把执行路由选为`pi_readonly`：

```text
Chat接纳消息
-> 主Workflow形成并批准RunSpec
-> Chat创建ToolExecution
-> Chat启动pi JSONL-RPC子进程
-> pi向Chat Provider Gateway提出模型调用
-> pi提出read Tool调用
-> Chat返回结果并提交Product Run终态
```

在“只调试Chat”模式中，这条链完整运行，但你只进入Chat的Python源码；pi像一个真实外部执行进程一样
正常工作。在“联合调试”模式中，同一条链仍然成立，只是pi启动后会先等待9230端口上的源码调试器。

## 2. 要解决的问题

如果只有一个模糊的“全栈调试”入口，会出现3类问题：

1. 日常只查Chat逻辑时，pi带`--inspect-brk`启动却没有调试器附加，整个执行看起来像卡死。
2. 把pi源码硬塞进Chat工作区调试，Source Map、构建任务和断点归属会跨越两个独立仓库。
3. 为了避免卡死而禁用pi，会让普通Chat调试无法覆盖真实执行路由、Provider Gate和Tool Gate。

所以当前把“是否调试pi源码”和“是否使用pi执行层”拆成两个开关：普通模式只关闭前者，不关闭后者。

## 3. 一句人话定义

- **只调试Chat**：调试Chat前端和Python后端，把pi当作正常运行但不进入源码的外部执行层。它不是
  “禁用pi”，也不是改用系统全局pi。
- **联合调试Chat + pi**：Chat继续拥有Workflow和治理，另一个VS Code窗口通过Node Inspector附加到
  Chat临时创建的pi子进程。它不是让Chat仓库拥有pi源码。
- **Node Inspector**：Node进程开放的调试协议端口。`--inspect-brk`表示进程在执行用户代码前暂停，
  直到VS Code附加并继续；它不同于Chat产品里的模型审批或Tool审批。

## 4. 两种模式的具体对象样本

不读取私有配置，可以通过公开健康接口观察安全投影。

普通模式应看到：

```json
{
  "pi_agent": {
    "enabled": true,
    "available": true,
    "runtime_source": "source_build",
    "debugger_enabled": false
  }
}
```

联合调试模式应看到：

```json
{
  "pi_agent": {
    "enabled": true,
    "available": true,
    "runtime_source": "source_build",
    "debugger_enabled": true
  }
}
```

这里的`debugger_enabled=false`只表示没有给pi子进程添加Inspector参数；`enabled/available=true`才表示
pi仍可作为执行层运行。

## 5. 对象生命周期

### 5.1 只调试Chat

1. Chat窗口启动`Chat Full Stack`。
2. 组合启动任务先执行`chat: prepare normal full stack`：清理旧进程，并把pi调试字段恢复为关闭。
3. FastAPI启动时从私有`backend/config.json`读取一次运行快照；pi运行能力仍保持启用。
4. 用户请求真正选择`pi_readonly`或`pi_workspace`时，`PiRuntimeManager.start`才创建本轮
   `PiExecution`。
5. `PiExecution.start`启动本地源码编译出的`dist/cli.js --mode rpc`，参数中没有`--inspect`或
   `--inspect-brk`。
6. pi照常完成Provider/Tool循环，Chat照常记录Session、ToolExecution和Trace。
7. 停止组合调试后，Chat前后端进程被清理。

### 5.2 联合调试Chat + pi

1. pi窗口先构建自己的源码，并等待附加到`127.0.0.1:9230`。
2. Chat窗口启动`Chat Full Stack (pi External Debug)`。
3. Chat的前置任务把pi运行快照临时切为`node_debug_port=9230`、`node_debug_break=true`，再启动后端。
4. 用户请求进入pi执行路由时，Chat创建新的pi子进程，并添加
   `--inspect-brk=127.0.0.1:9230`。
5. pi子进程在首行暂停；pi窗口附加成功后，按F5继续并命中TypeScript断点。
6. Chat与pi分别在自己的窗口调试；Provider Gate、Tool Gate和Product提交仍由Chat控制。
7. 停止Chat联合调试后，`postDebugTask`会关闭pi调试字段。异常退出时需要手工运行恢复任务。

固定9230端口意味着联合调试时只允许1个活动pi执行。`PiRuntimeManager.start`会拒绝第二个并发执行，
而不是让两个子进程争抢同一调试端口。

## 6. 为什么这样设计

一个看似更简单的替代方案，是在Chat的VS Code窗口里直接把pi源码加入`outFiles`，让一个调试配置承担
两个仓库。当前没有这样做，原因是：

1. Chat和pi是独立Git仓库，拥有各自的分支、依赖、构建任务和质量门。
2. pi断点依赖pi仓库生成的JavaScript与Source Map；应由pi窗口的`${workspaceFolder}`解析。
3. pi不是Chat启动时常驻的进程，只有执行路由真正选择pi后才动态出现，适合`attach`而不是固定`launch`。
4. 普通开发占多数，不应因为没有附加pi调试器而阻塞真实Workflow。

两个窗口并不表示两份pi。Chat仍从私有配置指定的同一个源码构建入口启动pi；第二个窗口只负责构建、
Source Map和断点附加。

## 7. 模式一：只调试Chat，但保留pi执行层

### 7.1 启动

1. 用VS Code打开`/Users/xulater/Code/Chat`。
2. 在“运行和调试”中选择`Chat Full Stack`。
3. 按F5，等待后端8030和前端5073启动。
4. 用Chrome打开`http://127.0.0.1:5073`。

这个组合会启动：

- `Chat Backend (MAF + FastAPI)`：由debugpy调试Python后端，并使用内嵌Execution Worker。
- `Chat Frontend (React + Vite)`：启动Vite开发服务。

当前组合没有自动附加Chrome JavaScript调试器。React/TypeScript页面断点请使用Chrome DevTools；Python
断点直接在Chat的VS Code窗口命中。第一次掌握链路时不要使用`Chat Distributed Stack`，否则API、
Execution Worker和Outbox Worker分成多个进程，断点归属更复杂。

### 7.2 推荐的Chat断点

| 顺序 | 文件与符号 | 观察内容 |
|---:|---|---|
| 1 | `backend/app/pi_gateway.py` → `PiRuntimeManager.start` | `task`、`config.provider_id`、`tool_execution_id`，不要展开原始凭据 |
| 2 | `backend/app/pi_runtime.py` → `PiExecution.start` | `runtime.node_debug_port`应为`None` |
| 3 | 同一函数调用`asyncio.create_subprocess_exec`前 | `arguments`包含`--mode rpc`，但不含`--inspect*` |
| 4 | `PiExecution.accept_provider_call` | pi已经生成一次Provider请求并回到Chat治理边界 |
| 5 | Workflow的pi dispatch/result节点 | Chat怎样消费pi结果并提交Product状态 |

即使无法进入pi TypeScript源码，你仍然能调试Chat侧的完整责任：为何选择pi路由、给pi什么受控任务、
怎样启动进程、怎样审批每次模型/Tool调用、怎样处理失败，以及怎样把结果写回Product Run。

### 7.3 验证pi没有被禁用

后端启动后执行安全查询：

```bash
curl -s http://127.0.0.1:8030/api/health \
  | jq '.pi_agent | {enabled, available, runtime_source, debugger_enabled}'
```

预期`enabled=true`、`available=true`、`runtime_source="source_build"`、`debugger_enabled=false`。

再发送一条会进入pi执行路由的任务。预期现象：

1. 命中`PiRuntimeManager.start`和`PiExecution.start`。
2. 不需要打开pi窗口，pi子进程也会继续运行。
3. 页面仍会出现Chat产品的模型调用审批或Tool审批；这些不是调试器暂停。
4. 终态的ToolExecution包含pi模型/Tool统计，并关联一个新的`chat-*` pi Session。

普通模式使用“最近一次已经编译好的pi源码产物”，不会自动重新构建pi。修改过pi源码后，要先在pi仓库
执行构建，再回到普通模式验证；否则Chat仍会运行旧`dist`。

## 8. 模式二：联合调试Chat + pi

### 8.1 启动顺序

使用两个独立VS Code窗口：

1. **pi窗口**：打开`/Users/xulater/Code/opc-os/pi`。
2. 在pi TypeScript源码中设置断点。
3. pi窗口选择`Attach to Chat pi Runtime (9230)`并按F5。它会先执行`npm run build:offline`，然后最多
   等待300秒，直到Chat真正创建pi子进程。
4. **Chat窗口**：打开`/Users/xulater/Code/Chat`。
5. Chat窗口选择`Chat Full Stack (pi External Debug)`并按F5。
6. 在Chrome打开Chat，发送会被路由到`pi_readonly`或`pi_workspace`的任务。
7. pi子进程出现后，pi窗口完成附加；按F5越过首行暂停，然后继续到你的TypeScript断点。

如果先启动Chat联合调试也可以，但必须在pi执行分支启动前让pi窗口开始等待附加。否则
`--inspect-brk`会让pi停在首行，Chat页面表现为执行一直没有继续。

### 8.2 推荐的pi断点

| 顺序 | pi源码文件与符号 | 观察内容 |
|---:|---|---|
| 1 | `packages/coding-agent/src/main.ts` → `runRpcMode(runtime)`调用处 | pi确认以RPC模式而不是TUI模式启动 |
| 2 | `packages/coding-agent/src/modes/rpc/rpc-mode.ts` → `runRpcMode` | stdin命令循环和stdout JSONL响应 |
| 3 | 同文件`handleCommand`的`case "prompt"` | Chat发送给pi的本轮任务进入`session.prompt` |
| 4 | `packages/coding-agent/src/core/agent-session.ts`的模型/Tool事件处理 | pi怎样产生Provider请求和内部Tool调用 |

Chat窗口同时保留第7.2节的Python断点。这样可以观察一条边界的两端：pi怎样提出Provider/Tool请求，
以及Chat怎样把请求转为审批、执行和账本记录。

### 8.3 验证Inspector确实生效

Chat后端启动后再次查询：

```bash
curl -s http://127.0.0.1:8030/api/health \
  | jq '.pi_agent | {enabled, available, runtime_source, debugger_enabled}'
```

预期`debugger_enabled=true`。在Chat的`PiExecution.start`断点中还应看到：

```text
--enable-source-maps
--inspect-brk=127.0.0.1:9230
.../packages/coding-agent/dist/cli.js
--mode
rpc
```

不要记录或复制完整`arguments`、环境变量、Provider Body或System Prompt；其中可能包含短期令牌和本轮
私密内容。只核对上述非敏感字段。

## 9. 停止与异常恢复

正常停止：

1. 先停止Chat窗口的联合调试组合。
2. 再停止pi窗口的Attach会话。
3. 下次日常调试直接选择`Chat Full Stack`，其前置任务还会再次确保Inspector关闭。

如果VS Code异常退出，Chat的`postDebugTask`可能来不及执行。在Chat窗口运行：

```text
Terminal -> Run Task -> chat: disable pi source debug
```

该任务通过`scripts/configure-pi-debug.py disable`原子修改私有配置，只关闭
`node_debug_port/node_debug_break`，不会打印或改动Provider密钥。之后重新启动`Chat Full Stack`。

## 10. 常见故障判断

| 现象 | 最可能原因 | 处理 |
|---|---|---|
| 普通Chat调试进入pi后一直不动 | 上次异常退出，`node_debug_break`仍开启 | 运行`chat: disable pi source debug`，再启动`Chat Full Stack` |
| 联合调试中页面停在pi启动 | pi在`--inspect-brk`首行等待 | 在pi窗口启动Attach并按F5继续 |
| pi断点灰色或不命中 | 在Chat窗口调pi、Source Map归属错误，或源码未重新构建 | 用pi仓库窗口Attach，确认预启动构建完成 |
| 9230已占用或第二条pi任务失败 | 固定调试端口只允许1个活动执行 | 先完成/停止第一条pi执行，不并发调试 |
| 根本没有pi子进程 | 本轮Execution Route不是`pi_readonly/pi_workspace`，或尚未批准RunSpec | 在Workflow运行视图核对执行路由和暂停点 |
| Chat断点未命中，任务却在运行 | 启动了旧后端、独立Worker或其他进程领取Job | 停止旧进程，使用`Chat Full Stack`的清理任务重新启动 |
| React断点不命中 | 当前组合只启动Vite，没有自动附加Chrome调试器 | 在Chrome DevTools中对Vite源码设置断点 |

## 11. 代码链

按实际时间顺序：

```text
Chat .vscode/launch.json
-> Chat .vscode/tasks.json
-> scripts/configure-pi-debug.py
-> config._pi_runtime
-> PiRuntimeManager.start
-> PiExecution.start
-> asyncio.create_subprocess_exec
-> pi main.ts
-> runRpcMode
-> handleCommand("prompt")
-> pi AgentSession模型/Tool循环
-> Chat Provider Gate / Tool Gate
-> Product Run结果提交
```

普通模式在`configure-pi-debug.py disable`后走这条链；联合模式在`enable --port 9230`后走同一条链。
业务链没有换，只有`create_subprocess_exec`的Node参数多了Inspector。

## 12. 亲手验证

完成两个最小实验：

### 实验A：证明“只调试Chat”仍然使用pi

1. 启动`Chat Full Stack`。
2. 确认健康投影的`debugger_enabled=false`。
3. 在Chat侧命中`PiRuntimeManager.start`、`PiExecution.start`和`accept_provider_call`。
4. 确认pi子进程参数没有`--inspect*`。
5. 不打开pi窗口，完成一次pi只读执行并看到ToolExecution终态。

### 实验B：证明联合调试能跨越进程边界

1. pi窗口在`runRpcMode`和`case "prompt"`设置断点并启动Attach。
2. Chat窗口启动`Chat Full Stack (pi External Debug)`。
3. 确认健康投影的`debugger_enabled=true`。
4. 发起一次pi只读执行，先命中Chat的`PiExecution.start`，再命中pi的`runRpcMode`。
5. 继续后命中`case "prompt"`，最后回到Chat的`accept_provider_call`。

这5个断点形成一个可观察的跨进程序列：

```text
Chat准备执行
-> Chat创建带Inspector的Node子进程
-> pi进入RPC模式
-> pi接收prompt命令
-> pi的Provider请求回到Chat治理边界
```

## 13. 掌握验收

不看文档回答：

1. 为什么`Chat Full Stack`里pi仍能执行，但pi TypeScript断点不命中？
2. 哪个任务保证普通调试不会遗留`--inspect-brk`？
3. 为什么pi窗口要使用Attach，而不是自己启动一个独立pi进程？
4. 联合调试卡在pi启动时，怎样区分“等待Inspector”和“等待模型审批”？
5. 修改pi源码后，为什么普通`Chat Full Stack`可能仍执行旧逻辑？

能独立完成实验A和实验B，并在10分钟内回答5题，算掌握这两种调试模式。

## 关键文件

| 文件 | 职责 |
|---|---|
| [Chat `.vscode/launch.json`](../../.vscode/launch.json) | 定义普通Chat、Chat+pi和分布式调试组合 |
| [Chat `.vscode/tasks.json`](../../.vscode/tasks.json) | 清理进程并启用/关闭pi Inspector |
| [configure-pi-debug.py](../../scripts/configure-pi-debug.py) | 原子切换私有配置中的pi调试字段，不输出密钥 |
| [backend/app/config.py](../../backend/app/config.py) | 启动时解析pi运行快照和调试端口 |
| [backend/app/pi_gateway.py](../../backend/app/pi_gateway.py) | 创建并登记单次pi执行，限制固定调试端口并发 |
| [backend/app/pi_runtime.py](../../backend/app/pi_runtime.py) | 组装Node参数、启动pi、处理JSONL-RPC和治理边界 |
| `/Users/xulater/Code/opc-os/pi/.vscode/launch.json` | 构建后附加Chat创建的9230 Inspector进程 |
| `/Users/xulater/Code/opc-os/pi/packages/coding-agent/src/main.ts` | 根据`--mode rpc`进入RPC运行模式 |
| `/Users/xulater/Code/opc-os/pi/packages/coding-agent/src/modes/rpc/rpc-mode.ts` | 接收Chat JSONL命令并驱动pi AgentSession |

## 补充记录

（暂无）
