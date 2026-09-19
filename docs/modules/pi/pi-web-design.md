# Pi Web架构与源码分析

## 1. 目的、基线与结论

本文回答两个问题：Pi Web原来如何把浏览器接到Pi Coding Agent，以及Chat把它改成纯前端后，哪些能力已经迁移、哪些只是保留了界面。

源码基线：

| 形态 | Git引用 | Commit | 含义 |
|---|---|---|---|
| 迁移前的Later Pi Web | `frontend/main` | `46afbc20742b7eaa37ce3ada22e144c5f528f27e` | 基于Pi Web 0.8.9的Next.js前后端一体应用，包含Later已有适配 |
| 当前Chat前端 | `frontend/codex/chat-frontend` | `f48774eb187ebfda4130c0f279b20b8bceb98475`之后的未提交状态 | Vite + React纯浏览器前端，不运行Pi SDK |

先给出结论：

1. 原Pi Web不是一个通用前端协议，也不是一个薄Adapter。它是Pi Coding Agent的本地Web产品，React页面、Next.js API、进程内`AgentSession`和本机文件访问都在一个进程中。
2. 原Pi Web没有定义独立的“Agent配置模型”。它把页面选择的模型、Thinking Level和工具集合转成RPC命令；其余能力来自Pi的`SettingsManager`、`ResourceLoader`和`PackageManager`。
3. 原Pi Web的`rpc-manager.ts`是产品适配层：它不实现模型循环，但负责创建和缓存`AgentSession`、翻译命令、桥接事件、适配Extension UI以及维护运行状态。
4. 当前Chat前端已经删除这套服务端控制面。浏览器改为选择Workflow并调用Chat的`/runs`、`/api/sessions`等公开接口。
5. 当前页面仍保留Skills、Plugins、Extensions等入口，不代表Chat后端已经支持这些能力。必须以Chat路由和测试为准。

## 2. 原Pi Web的产品定位

原README把Pi Web定义为“Pi Coding Agent的本地浏览器界面”，并明确复用Pi的本地配置和Session文件。它不是要把Pi抽象成一个可编排的多Agent平台，而是让用户从浏览器完成原本Pi Coding Agent终端中的主要操作：

- 新建、恢复、分支、重命名、导出和删除Pi Session。
- 发送Prompt、Steering、Follow-up和Shell命令。
- 查看模型、Thinking、上下文用量、工具调用和压缩状态。
- 管理模型、Provider认证、Skill、Extension和Pi Package。
- 浏览项目文件、Git状态和Worktree。

这决定了它原来的边界：浏览器只是交互界面，Next.js服务端才是Pi Coding Agent宿主。

## 3. 原Pi Web整体架构

```text
浏览器 React
  ├── useAgentSession：消息、运行状态、事件、命令
  ├── Session / File / Model / Resource 页面
  └── EventSource客户端
          │
          │ HTTP JSON + SSE
          ▼
Next.js Route Handlers
  ├── /api/agent/*       Agent命令和实时事件
  ├── /api/sessions/*    JSONL Session读取与管理
  ├── /api/skills        Skill发现与文件设置
  ├── /api/extensions    Extension发现与启停
  ├── /api/plugins       Pi Package安装与资源统计
  └── /api/files、git、models、auth等
          │
          ▼
Pi Web服务端适配
  ├── rpc-manager.ts / AgentSessionWrapper
  ├── 进程内Session Registry和启动锁
  ├── AgentSessionEvent → 浏览器事件
  └── Extension RPC UI适配
          │
          ▼
Pi Coding Agent
  ├── ModelRuntime
  ├── SettingsManager
  ├── DefaultResourceLoader / PackageManager
  ├── SessionManager
  └── AgentSession → Agent → Provider / Tools
          │
          ▼
本机配置、Session、项目文件和Git仓库
```

这里有两条不同的数据路径：

1. 运行路径：浏览器命令进入一个活着的`AgentSession`，事件再实时推回浏览器。
2. 历史路径：Session页面从内存中的`SessionManager`或JSONL文件生成历史投影。

原Pi Web没有把实时事件当作历史事实源。最终对话历史仍以Pi Session为准。

## 4. 一次新会话的真实调用链

### 4.1 创建运行时

浏览器在`hooks/useAgentSession.ts`中调用：

```text
POST /api/agent/new
{
  cwd,
  type: "ensure_session",
  toolNames,
  provider?,
  modelId?,
  thinkingLevel?
}
```

服务端`app/api/agent/new/route.ts`完成：

1. 校验cwd、模型参数和Thinking Level。
2. 使用随机临时Key调用`startRpcSession()`，避免并发新建请求共用同一启动锁。
3. 返回Pi生成的真实Session ID、实际模型和Thinking Level。
4. `ensure_session`只创建运行时，不发送Prompt；Pi可能还没有写出JSONL文件。

`startRpcSession()`在`lib/rpc-manager.ts`中完成真正装配：

```text
SessionManager.create(cwd)
  ↓
SettingsManager.create(cwd, agentDir)
  ↓
createAgentSessionServices()
  ├── ModelRuntime
  ├── ResourceLoader.reload()
  └── Extension Provider注册
  ↓
解析可见模型、默认模型和Thinking Level
  ↓
createAgentSessionFromServices()
  ↓
AgentSessionWrapper
  ↓
以真实Session ID写入进程内Registry
```

Pi Web先创建Services，再创建AgentSession，是因为Extension可能注册Provider；恢复已有Session模型前必须先完成这些注册。

### 4.2 建立事件通道

浏览器随后连接：

```text
GET /api/agent/:sessionId/events
Accept: text/event-stream
```

`AgentEventConnection`等待服务端发送`connected`事件后才认为运行时可用。服务端`createAgentEventStream()`先订阅`AgentSessionWrapper.onEvent()`，再发送当前快照和缓冲事件，从而缩小冷启动期间丢事件的窗口。

服务端不会原样发送所有Pi事件：

- 过滤`turn_start`和`turn_end`。
- `message_update`移除完整`partial`快照，只保留增量；Tool Call增量补出`id`和`toolName`。
- `tool_execution_update`只保留浏览器需要的字段。
- `agent_end`只保留结束语义。

这说明Pi Web的事件合同是Pi事件的UI投影，不等同于Pi完整事件类型。

### 4.3 发送Prompt

事件通道就绪后，浏览器调用：

```text
POST /api/agent/:sessionId
{ type: "prompt", message, images? }
```

`AgentSessionWrapper.send()`把命令翻译成`AgentSession.prompt()`。HTTP请求只等到Pi同步校验和Extension preflight接受Prompt，不等待模型完成。后续Thinking、文本和工具过程都走SSE。

一轮结束后，浏览器重新调用`GET /api/sessions/:id`，以持久Session重新校正页面历史。SSE负责低延迟展示，Session负责最终一致性。

## 5. 已有Session的恢复方式

浏览器向`POST /api/agent/:id`发送命令时，服务端按以下顺序查找：

```text
尚未落盘但已注册的运行时
  ↓ 没找到
Session ID对应的JSONL文件
  ↓
仍然活着的进程内运行时
  ↓ 没找到
SessionManager.open(filePath) + startRpcSession()
```

恢复不是浏览器把完整历史重新提交给服务端，而是服务端用Session ID解析JSONL，再由Pi的`createAgentSession()`恢复消息、模型和Thinking Level。

原Pi Web还处理一个Pi行为：新Session在第一条可持久内容产生前可能没有JSONL文件。因此它把已接受但未落盘的Session临时保存在Registry中，并把运行中的内存Session合并进Session列表。

## 6. `rpc-manager.ts`实际负责什么

`AgentSessionWrapper`不是另一个Agent。它是Pi Web为了HTTP产品形态写的适配层，职责包括：

| 职责 | 具体行为 |
|---|---|
| 生命周期 | 创建、注册、空闲十分钟后销毁、进程退出清理 |
| 命令翻译 | `prompt`、`abort`、`set_model`、`set_thinking_level`、`compact`、`steer`、`follow_up`、`set_tools`、`bash`等转为AgentSession方法 |
| 运行状态 | 汇总Prompt、Streaming、Compaction和Bash状态，广播运行Session ID |
| 事件桥接 | 订阅AgentSession事件并交给SSE Route |
| Extension准备 | 给当前AgentSession绑定RPC模式UI、命令上下文和错误回调 |
| Extension UI | 把select、confirm、input、editor、widget和custom UI转换为浏览器事件与响应命令 |
| Web特有策略 | 项目信任、每Session禁用Extension、网页完成通知、Web Shell环境 |

其中最后两行不是Pi Agent Core的通用职责。它们是Pi Web的产品策略。

## 7. Pi Web如何使用Pi的能力

### 7.1 模型、Thinking和工具

Pi Web没有保存一份独立Agent定义。新Session页面把用户显式选择传入`startRpcSession()`：

```text
initialModel   → createAgentSessionFromServices({ model })
thinkingLevel → createAgentSessionFromServices({ thinkingLevel })
toolNames      → createAgentSessionFromServices({ tools })或setActiveToolsByName()
```

未显式选择的值仍由Pi的Session恢复和Settings默认值决定。运行期间的切换走`set_model`、`set_thinking_level`和`set_tools`命令。

### 7.2 Skill

`GET /api/skills?cwd=...`创建`DefaultResourceLoader`并执行与AgentSession启动一致的`reload()`，然后返回`loader.getSkills()`。

页面的“允许模型调用”开关直接修改`SKILL.md` Frontmatter中的`disable-model-invocation`。这会改变Skill是否出现在模型可发现列表中，但没有创建一个新的Agent配置对象。

安装和更新Skill是Pi Web额外接入的包管理流程；它与“当前AgentSession加载了哪些Skill”不是同一个动作。

### 7.3 Extension

原Pi Web区分两种启停：

1. 文件级全局启停：把`foo.ts`重命名为`foo.ts.disabled`，让Pi自动发现不再匹配它。
2. Pi Web每Session禁用：把Extension路径写入`agentDir/pi-web-config.json`，然后通过ResourceLoader的`extensionsOverride`过滤。

第二种是Pi Web自己的配置机制，不是Pi Session原生字段。过滤后还必须让当前AgentSession执行`reload`才生效。

### 7.4 Plugin

Pi Web页面中的Plugin对应Pi Package，不是独立运行时插件协议。`/api/plugins`使用：

```text
SettingsManager中的packages
  + DefaultPackageManager
  → 安装、删除、更新和解析Package
  → 汇总其中的extensions / skills / prompts / themes
```

禁用Package的实现是把该Package四类资源过滤列表都设为空。Package是安装和分发单元；Extension和Skill才是AgentSession最终消费的资源。

## 8. 原Pi Web的接口分层

| 接口组 | 页面提交或获取的数据 | 服务端事实源 | 是否直接控制AgentSession |
|---|---|---|---|
| `/api/agent/new` | cwd、初始模型、Thinking、工具、首条命令 | Pi运行时服务与SessionManager | 是 |
| `/api/agent/:id` | Prompt和运行命令 | 进程内AgentSessionWrapper | 是 |
| `/api/agent/:id/events` | 无；SSE事件 | AgentSession事件 | 只读实时投影 |
| `/api/sessions/*` | Session ID、Leaf ID、名称等 | 活SessionManager或JSONL | 主要读取和Session管理 |
| `/api/models*`、`/api/auth*` | 模型配置和Provider凭证状态 | ModelRuntime和Agent目录 | 间接；下次创建或显式切换生效 |
| `/api/skills` | cwd、Skill文件开关 | ResourceLoader和SKILL.md | 间接；reload后生效 |
| `/api/extensions` | cwd、路径、Session ID | Package解析、文件名、Pi Web配置 | 间接；reload后生效 |
| `/api/plugins` | Package来源、Scope和动作 | SettingsManager和PackageManager | 间接；资源重载后生效 |
| `/api/files`、`/api/git`、`/api/worktrees` | 项目路径与操作 | 本机文件系统和Git | 不直接控制Agent |

这个分层非常重要：Pi Web页面展示的“可配置项”来自多套事实源，不是一张统一的Agent配置表。

## 9. 当前Chat前端与原Pi Web的区别

当前`frontend/codex/chat-frontend`删除了Next.js `app/api`、`rpc-manager.ts`、Session读取和本机服务端逻辑，也移除了Pi SDK运行依赖。它现在是Vite构建的浏览器应用：

```text
Pi Web派生React界面
  ├── POST /runs                    首轮创建持久Session并启动Chat Workflow
  ├── GET /runs/:id/events          读取Workflow Stage和Agent事件
  ├── GET /runs/:id                 读取状态与最终结果
  ├── DELETE /runs/:id              取消Run
  └── /api/sessions、files等         读取Chat后端投影
```

当前`useAgentSession()`已经不再：

- 创建Pi AgentSession。
- 连接原`/api/agent/:id/events`。
- 发送`set_model`、`set_tools`、`set_thinking_level`等Pi Web RPC命令。
- 执行Session Fork、Steering、Follow-up、Compaction或Extension UI响应。

它保留原组件所需的返回形状，对尚未迁移的操作明确提示“不支持”或返回空集合。Skills、Plugins、Extensions等页面组件仍存在，但如果Chat没有对应HTTP Route，它们只是尚未接通的目标界面。

## 10. 给Chat需求分析的输入

这里仍然不定义Chat的`AgentConfig`。从Pi Web只能得到以下设计输入：

1. 浏览器不应持有Pi运行时对象，只提交可序列化的用户选择和Workflow输入。
2. Chat后端必须拥有`SessionManager`、`SettingsManager`、`ResourceLoader`和`AgentSession`的生命周期。
3. 实时事件是展示投影，Pi Session是对话历史；Workflow Run是执行状态。三者必须分别定义。
4. 模型、Thinking、工具、Skill、Extension和Package来自不同Pi接口，不能因为它们都出现在设置页面就合并成一个无边界配置对象。
5. Pi Web原有页面可以作为用户场景和交互合同参考，但服务端实现应优先复用Pi公开接口，不复制`rpc-manager.ts`的整个单体控制面。
6. 如果Chat要做到“Workflow中不同Agent使用不同能力”，配置粒度应落到Workflow Stage所引用的Agent能力，而不是复活Pi Web以Session为中心的临时覆盖文件。
7. Extension UI、运行中Steering、Session分支等能力都要求持续存在的AgentSession或等价运行控制面；不能只靠一次Workflow返回值假装已经支持。

## 11. 源码证据索引

| 结论 | 主要源码 |
|---|---|
| 浏览器创建Session并发送Prompt | `frontend/main:hooks/useAgentSession.ts` |
| 新Session HTTP入口 | `frontend/main:app/api/agent/new/route.ts` |
| 已有Session命令入口 | `frontend/main:app/api/agent/[id]/route.ts` |
| SSE入口和快照顺序 | `frontend/main:app/api/agent/[id]/events/route.ts`、`lib/agent-event-stream.ts` |
| AgentSession装配和Registry | `frontend/main:lib/rpc-manager.ts`中的`startRpcSession()` |
| 命令到AgentSession方法的映射 | `frontend/main:lib/rpc-manager.ts`中的`AgentSessionWrapper.send()` |
| Skill发现 | `frontend/main:lib/skills-service.ts`、`app/api/skills/route.ts` |
| Extension启停 | `frontend/main:lib/extensions-service.ts`、`lib/session-extension-config.ts` |
| Pi Package管理 | `frontend/main:app/api/plugins/route.ts` |
| Session读取 | `frontend/main:app/api/sessions/*`、`lib/session-reader.ts` |
| 当前Chat浏览器调用 | `frontend:lib/chat-workflow-browser.ts`、`hooks/useAgentSession.ts` |

下一份文档将以Pi Agent和Pi Web两份上游分析为输入，描述Chat当前实现、用户场景和能力缺口。只有这一层完成并经过评审后，才形成Chat详细设计。
