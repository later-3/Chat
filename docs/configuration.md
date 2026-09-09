# Chat 系统配置

本文说明 Chat 的网页登录、模型、Workflow、Agent 和项目资源配置放在哪里，以及最常用的写法。它面向 Chat 用户和协助用户管理 Chat 的外部 AI；开发者若要修改配置机制，应另读[架构文档](./architecture/README.md)。

本文的 JSON、文件位置和 HTTP 接口描述当前实现。Long Agent 的完整目标见[使用与配置](./long-agents.md)、[定义与配置模型](./architecture/chat-long-agent-capability-model.md)；独立 Agent 目录、独立 Daily、按日 Session、完整历史/调度/Docker 尚待实施，不能直接向现有 schemaVersion 1 添加目标字段。

共享项目概览、长期职责（灵魂模式）、自由活动和 Social 订阅的配置领域见[共享认知与自主工作](./architecture/chat-long-agent-awareness-and-autonomy.md)。本轮仅形成设计要求与机制评审稿，现有 JSON/API 尚不支持直接添加这些目标字段。

## 1. 配置范围

Chat 的配置入口按作用域分为进程/部署、Personal、Project、Session/本轮和产品源码。网页登录必须在进入产品前生效，因此由进程或部署环境配置；用户通常只需要网页登录、Personal 与 Project 配置。Session 由 Chat 保存，产品源码配置只供开发内置 Workflow 和 Agent 时修改。

以下内容不是同一种系统配置：

- Rule 和 Experience 是可选择的 Prompt 资源，位于 `<CHAT_HOME>/prompt-resources` 或 `<CHAT_HOME>/projects/<projectId>/prompt-resources`。
- Memory 是独立的持久化事实，不应写入配置文件。
- `AGENTS.md`、`AGENTS.override.md`、`CLAUDE.md` 是 Agent Context。Chat 只读取 Personal Agent 目录和用户明确打开的项目根目录中的对应文件。

## 2. Chat Home

用户数据根目录由环境变量 `CHAT_HOME` 决定，未设置时是 `~/.chat`。部署或测试需要改位置时，建议使用绝对路径：

```bash
export CHAT_HOME=/srv/chat-data
```

下文中的 `<CHAT_HOME>` 均指这个目录。不要把整个 Chat Home 提交到 Git，其中包含 Session、认证和其他私有运行数据。

Chat会在启动和读取Project列表时保证Daily Project存在：工作目录固定为`<CHAT_HOME>/workspaces/daily`，运行数据位于`<CHAT_HOME>/projects/daily`。`daily`是用户的个人日常Project，也是没有更具体归属时的默认Project；Chat不再另建“个人模式”或无Project模式。不要把外部目录手工声明为`daily`，也不要删除或移动Managed Workspace。Daily仍使用普通的`.chat/project.json`、`.chat/config.json`、Session、Memory和资源合同，没有另一套专用配置。

### Long Agent注册与配置管理（当前实现）

以下共享 daily、long-agents.json、NanoClaw Group 身份和唯一 primarySessionId 是迁移前用法，不是新目标。已确认目标要求每个 Agent 独立空间、文件配置统一身份、业务项目多 Session 和 Docker 工具环境；具体差距见[实施状态](./architecture/chat-long-agent-roadmap.md)。

Chat使用`<CHAT_HOME>/long-agents.json`登记可选择的长期Agent及其NanoClaw本机实例。这个文件属于Personal产品配置，不属于某个Project；每个Agent的`defaultProjectId`决定IM首次来信缺少更具体归属时在哪个Project建立Chat Session，通常使用`daily`。

```json
{
  "schemaVersion": 1,
  "instances": [
    {
      "id": "local",
      "name": "Local NanoClaw",
      "executionMode": "chat-pi",
      "gatewayBaseUrl": "http://127.0.0.1:3000/webhook/chat-backend"
    }
  ],
  "agents": [
    {
      "id": "nexus",
      "name": "Nexus",
      "description": "默认长期助手",
      "avatar": { "kind": "emoji", "emoji": "🦉" },
      "enabled": true,
      "instanceId": "local",
      "nanoclawAgentGroupId": "ag-example",
      "defaultProjectId": "daily",
      "inbox": {
        "messagingGroupId": "mg-example",
        "channelType": "telegram",
        "instance": "telegram",
        "platformId": "telegram-user-or-chat-id",
        "threadId": null
      },
      "definition": {
        "schemaVersion": 1,
        "id": "nexus",
        "name": "Nexus",
        "description": "默认长期助手",
        "thinkingLevel": "high",
        "systemPrompt": { "mode": "pi-default" },
        "customInstructions": [
          "你是Nexus，负责持续协助用户处理Daily Project中的学习、工作和生活事务。"
        ],
        "tools": {
          "mode": "pi-default",
          "addresses": [
            "system:tool/memory_search",
            "system:tool/memory_record",
            "system:tool/workflow_call",
            "system:tool/agent_memory_search",
            "system:tool/agent_memory_read",
            "system:tool/agent_memory_write"
          ]
        },
        "resources": { "mode": "inherit" }
      }
    }
  ]
}
```

`executionMode`固定为`chat-pi`：该NanoClaw Instance中的全部Chat Long Agent都由Chat Pi执行，不支持逐Agent选择Runtime。Registry `schemaVersion: 1`只允许一个NanoClaw Instance，由该Host承载多个Agent Group；当前服务Token是单一Host信任边界，不能把多个信任域伪装成已经隔离。`gatewayBaseUrl`是NanoClaw提供给Chat Backend的窄HTTP Gateway，本期使用loopback HTTP。Agent ID和Instance ID只能使用小写字母、数字、点、下划线或连字符；`defaultProjectId`必须是已经登记的稳定Project ID。同一个NanoClaw Agent Group不能重复映射成两个Chat Long Agent。`nanoclawAgentGroupId`既是Channel路由键，也是Long Agent独立身份、Workspace、Markdown Agent Memory和NanoClaw生态资源的稳定引用。Chat Web通过Backend管理Agent Group展示身份、Standing Instructions与OKF Markdown Memory，不直连NanoClaw。

`name`与`description`是Chat Web列表使用的显示别名和摘要，不是Long Agent运行身份事实源；兼容期内`definition.name/description`仍与它们保持一致。`avatar`是可选的Chat展示头像：`{ "kind": "auto" }`（缺省，按稳定Agent ID派生固定配色和首字符）、`{ "kind": "emoji", "emoji": "🦉" }`或`{ "kind": "image", "file": "avatar.png", "revision": 1 }`。图片二进制不写入该文件，而是保存在受管目录`<CHAT_HOME>/long-agents-assets/<longAgentId>/avatar.<png|jpg|webp>`；只能上传PNG/JPEG/WebP且不超过2MB。展示头像通过`PUT /api/long-agents/:id/config`（auto/emoji，随完整表单带`expectedRevision`）和`PUT/DELETE /api/long-agents/:id/avatar?expectedRevision=…`（图片raw bytes上传/删除）修改，两者保存后都返回新的配置revision；浏览器经`GET /api/long-agents/:id/avatar?v=<revision>`读取图片，配置投影只暴露`kind/emoji/revision`，不暴露宿主绝对路径或资产文件名。图片头像只能经上传接口设置，配置表单回读`image`表示保持不变。头像属于纯展示配置，保存即生效，不等下一轮。NanoClaw Agent Group的`name`才是运行身份名称，`standingInstructions`才是长期职责事实源，两者在每轮Pi装配时优先注入。为控制模型上下文，每轮最多注入Standing Instructions的32,000个Unicode code point，以及`index.md`、`system/definition.md`各16,000个；截断提示会要求Agent按需使用`agent_memory_read`读取全文，而管理API与Snapshot仍保留完整内容。`definition`只保存Chat拥有的Pi运行策略，使用与Workflow Agent相同的Model、Thinking Level、System Prompt、自定义Prompt、Tool和Resource结构。省略时Chat会生成具备`memory_search`、`memory_record`、`workflow_call`、3个`agent_memory_*` Tool和6个`project_*` Tool的默认定义。`memory_*`访问Chat Personal/Project共享Memory；`agent_memory_*`只访问当前Long Agent映射的NanoClaw Agent Group，模型不能在Tool参数中指定另一个Group。Chat Web和所有NanoClaw入口都使用同一份Pi运行策略。

`long-agents.json`只保存Chat到NanoClaw的稳定映射、默认Project和Pi运行策略，不复制Agent Group身份、Standing Instructions或Memory。最后一次成功读取的Agent Group Snapshot作为派生缓存保存到`<CHAT_HOME>/runtime/long-agents/<longAgentId>/agent-group-snapshot.json`；每个实际进入Turn的Snapshot还按内容Revision不可变保存到同目录的`snapshots/<sha256>.json`。Turn的schemaVersion 2 Marker冻结`contextRevision`、Group/Core Revision、stale和fetchedAt；同一Turn重试只按该内容Revision读取历史Snapshot，不会静默换成后来更新的身份或Memory。只有明确的网络错误、超时或NanoClaw 5xx才使用最后有效缓存，并标记`stale=true`。认证失败、对象不存在、版本冲突或响应合同不匹配都会关闭失败，不能被旧缓存掩盖；缓存也不能反向覆盖NanoClaw事实源。

不可变Snapshot当前不做自动删除，因为运行中或失败后可重试的Turn可能长期引用旧Revision。其单份体积受Agent Group文本与核心Memory上限约束，但长期更新次数会增加存储；后续GC必须扫描所有保留Session的Turn Marker，只删除没有任何活动、失败或保留期内Session引用的Snapshot，不能简单按latest或文件年龄清理。

网页登录后的管理接口为`GET/PATCH /api/long-agents/:id/agent-group`与`GET/PATCH /api/long-agents/:id/agent-memory`。Memory GET使用`operation=list|read|search`；PATCH使用`operation=write|delete`并要求`expectedRevision`完成乐观并发控制。搜索词不超过512个字符和32个空白分词；Markdown内容上限为900 KiB UTF-8数据，为Gateway JSON Envelope保留空间。接口只接受Memory根内的Markdown相对路径，不返回Gateway URL、Token或NanoClaw宿主绝对路径。Agent Group更新、Web Memory写入/删除和Pi `agent_memory_write`都会进入`<CHAT_HOME>/logs/audit.jsonl`，记录可信的Long Agent、Agent Group、Project/Session/Turn来源和结果Revision，但不记录Token或宿主路径。

NanoClaw Token、Bot Token、OAuth和模型Credential不写入该文件。Telegram Token仍由NanoClaw环境管理；Chat的Bot Credential注册表也不能通过Long Agent API返回给浏览器。

Chat Web在当前Project上下文中提供互斥的“会话 / 长期同事”侧边栏导航面板，默认显示“会话”。“会话”保留旧有普通Session的布局、列表信息和新建入口，不为Long Agent预留占位；“长期同事”只展示同事在当前Project的专属主Session入口和设置操作。用户手动切换这两个导航面板时，中央区已打开的会话不变；打开或新建普通Session时自动回到“会话”，打开Long Agent或刷新读取到`session.owner.type === "long-agent"`时自动切到“长期同事”。

Long Agent配置入口位于“长期同事”面板的同事条目中。入口位于Project上下文中，但它编辑的`LongAgent`定义是Personal配置，对该Long Agent所有Project生效；页面必须明示这个作用域。可编辑字段包括显示名称与描述、Personal全局启停、`defaultProjectId`、Model、Thinking Level、System Prompt/自定义Prompt、Tools和Resources；稳定`id`不可改名。

配置页使用两个后端合同：

| 接口 | 作用 | 并发与安全边界 |
|---|---|---|
| `GET /api/long-agents/:id/config` | 读取Personal LongAgent定义与可见的Channel Gateway摘要 | 返回`revision`；Channel adapter/gateway只读，不返回Gateway地址、Credential或Token |
| `PUT /api/long-agents/:id/config` | 替换可编辑配置 | 请求必须带`expectedRevision`；过期revision返回`409`，保存采用串行化原子替换 |

`PUT`会先离线刷新本地模型与认证快照，再校验`defaultProjectId`、Model与Provider认证、Tool地址以及完整Agent Definition，不接受未知字段。保存成功后以返回的新`revision`替换页面基线；冲突时重新读取，不得用过期表单覆盖新配置。

`ProjectLongAgent`不复制上述Agent Definition，也不保存Project级Model、Prompt或Resource覆盖；它只保存该Long Agent在当前Project的`active/paused`状态和唯一`primarySessionId`。Personal的`enabled=false`会使整个Long Agent不可执行，Project启停只影响当前Project的挂载。

Chat把ProjectLongAgent、Channel Binding、HTTP Ingress待处理事件和有限幂等账本写入`<CHAT_HOME>/runtime/long-agent-state.json`。NanoClaw调用`POST /api/internal/channel/v1/events`后，Chat只有在事件耐久保存成功后才返回`202`；Backend自己的恢复Worker负责执行和退避重试，普通Session读取不会触发Channel同步。Pi瞬时失败会保留append-only失败记录，并从同一原生User/ToolResult节点建立重试分支，不重复追加用户消息；完成后的Turn重放只恢复既有结果。该状态文件不应手工编辑或提交。每个`projectId + longAgentId`只有一个`primarySessionId`；普通Project Session不绑定Long Agent。Frontend通过`GET /api/long-agents`读取经过裁剪的Agent与当前Project状态，通过`POST /api/long-agents/:id/start`创建或打开专属主Session，通过`POST /api/long-agents/:id/messages`发送文本消息。

NanoClaw Host以Instance为单位配置Chat Backend、实例身份和共享服务Credential：

```text
NANOCLAW_EXECUTION_MODE=chat-pi
CHAT_BACKEND_URL=http://127.0.0.1:43110
CHAT_INTEGRATION_INSTANCE_ID=local
CHAT_CHANNEL_GATEWAY_TOKEN=<至少32个字符的随机值>
```

同一份`CHAT_CHANNEL_GATEWAY_TOKEN`也要进入Chat Backend的私有进程环境，不能写入`long-agents.json`、Frontend响应或日志。该模式接管整个NanoClaw Instance；NanoClaw中的Session只作为Channel、Thread和Mailbox路由坐标，不再表示Agent运行Session。Host启动时完全跳过NanoClaw Session Runtime、Docker可用性检查、旧容器接管、Docker事件监听、OneCLI Agent审批订阅和Egress网络维护。`container_configs`的数据迁移仍会执行，因为当前调度时区也复用该表；这不是容器Runtime初始化。缺少Backend URL、服务Credential、合法Instance ID或配置未知execution mode时Host必须启动失败，不能静默回退Docker。NanoClaw先耐久保存Inbox与Event Outbox，再主动通过HTTP提交给Chat；若两种SQLite事实之间发生瞬时失败，外部执行唤醒会从仍待确认的Inbox重建缺失Event。Chat先耐久接收，再使用与Web相同的LongAgent Runtime运行Pi。Chat完成后调用NanoClaw窄HTTP Gateway持久化Delivery，最后单独确认Inbound。

从独立NanoClaw切换到`chat-pi`属于显式迁移：启用前先停止旧Host及其Agent容器。进入Channel Gateway模式后的日常启动不再访问Docker，也不承担清理旧容器的责任。

### 微信通道与多个 Long Agent

微信通道通过 NanoClaw 的 `add-wechat` Skill 安装，包含 `src/channels/wechat.ts`、通道注册及固定版本 `wechat-ilink-client@0.1.0`。在 NanoClaw 私有 `.env` 中设置 `WECHAT_ENABLED=true`；扫码登录凭据保存在该 Host 的 `data/wechat/auth.json`，不进入 Chat 配置、Git 或浏览器 API。登录入口保存在 `data/wechat/qr.txt`。

当前适配器使用一份微信账号登录，不等于只能连接一个 Long Agent。NanoClaw Wiring 支持一个 Messaging Group 对应多个 Agent Group；每条 Wiring 独立匹配触发规则，同一消息可以触发多个 Agent。初次接入建议只绑定 Nexus。后续可以通过互斥的消息前缀配置多个 Agent，例如 `^Nexus[：:]` 和 `^Coder[：:]`；不要给多个 Agent 同时使用匹配所有消息的 `.`，除非希望全部回答。

微信接入复用现有 `chat-pi` Host 和 HTTP Event/Delivery/Ack 合同，不修改 Long Agent 的 Telegram 默认 inbox，也不新增 Agent Runtime。当前 Chat 自动建立的是私聊与默认 Project 的绑定；群聊仍需要显式 Project Binding，不能以适配器声明群聊能力代替端到端验收。微信文本收发须在扫码、Wiring 和发送者权限配置完成后进行真实验收。未知发送者默认 `strict`，绑定 Agent 不自动授予陌生人访问权限。

## 3. Web 登录认证

Chat 默认启用网页登录。本地开发未设置任何 Web 认证环境变量时，初始账号为：

```text
用户名：chat
密码：123456
```

这组初始凭据只用于本机首次访问和开发调试，不是生产密码。公开或共享部署必须在启动 Chat 前覆盖密码；修改用户名、密码或 Session 签名密钥后，已有登录 Cookie 会失效，需要重新登录。

Web 登录属于 Chat 系统配置，但必须在用户登录前可用，并且包含 Credential，因此由进程环境配置，不写入 Project 配置，也不通过浏览器配置 API 返回：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CHAT_WEB_AUTH_ENABLED` | `1` | 是否启用网页登录；仅受信任的本地开发环境可以设为 `0` |
| `CHAT_WEB_AUTH_USERNAME` | `chat` | 登录用户名，最长 128 个字符 |
| `CHAT_WEB_AUTH_PASSWORD` | `123456` | 本地初始密码；生产环境必须改为强密码 |
| `CHAT_WEB_AUTH_SESSION_DAYS` | `30` | “保持登录”的有效天数，可配置范围为 1～90 天 |
| `CHAT_WEB_AUTH_SESSION_SECRET` | 由用户名和密码派生 | Cookie 签名密钥；生产部署应使用至少 32 个字符的独立随机值 |

本地临时覆盖示例：

```bash
export CHAT_WEB_AUTH_USERNAME=chat
export CHAT_WEB_AUTH_PASSWORD='replace-with-a-strong-password'
export CHAT_WEB_AUTH_SESSION_SECRET='replace-with-at-least-32-random-characters'
pnpm dev
```

Linux 安装使用权限受限的 `/etc/chat/chat.env` 保存这些变量；`chatctl` 会生成独立的 Session 签名密钥，并拒绝带着示例密码占位符启动。完整操作见[部署指南](./deployment.md#用户配置web登录和provider)。Provider 的 API Key 或 OAuth 是 Agent 调用模型使用的另一类认证，不是这里的 Chat 网页登录。

## 4. 模型与 Provider 认证

Personal 默认 Provider、模型和 Thinking Level 位于 `<CHAT_HOME>/agent/settings.json`：

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5",
  "defaultThinkingLevel": "high"
}
```

Thinking Level 可使用 `off`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`，实际可用级别取决于模型。此文件是用户私有设置，不建议提交到项目 Git。

项目根目录中的 `.pi/settings.json` 可以覆盖这个 Project 使用的 Pi 默认设置。例如只为当前 Project 改默认模型：

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-5",
  "defaultThinkingLevel": "high"
}
```

这是 Pi 兼容配置。若要为某个 Workflow 的某个 Agent 固定模型，使用第 7 节的 Project 私有 Agent 配置，不要用 `.pi/settings.json` 代替 Agent 级选择。Long Agent 的模型管理必须经由 Chat 的 Agent 配置及模型目录；本段不授权它寻找或修改 `~/.pi`，目标中也不会用 Project 的 Pi 兼容设置覆盖其有效 Agent 定义。

Long Agent 的模型是其自身定义的一部分，与头像/身份一样可逐 Agent 配置：定义中的 `model`/`thinkingLevel` 为显式选择；未显式配置时，运行时按同一默认链解析（`agent/settings.json` → 项目 `.pi/settings.json`）。`GET/PUT /api/long-agents/:id/config` 在 `agent.effective` 中返回解析后的生效模型、生效思考等级及其来源（`explicit` 或 `chat-default`），设置页始终展示并可直接配置；保存时选择的具体模型写入定义。

自定义 Provider 和模型位于 `<CHAT_HOME>/agent/models.json`。例如添加本地 Ollama 模型：

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [{ "id": "qwen2.5-coder:7b" }]
    }
  }
}
```

`models.json` 可能包含 API Key、自定义请求头或读取密钥的命令，应视为敏感文件。能使用环境变量或 Chat 认证流程时，不要写入明文 Credential。

Provider 的 API Key 或 OAuth 认证保存在 `<CHAT_HOME>/agent/auth.json`，由认证流程管理。不要在文档、日志、聊天消息或 Git 中展示、复制或提交其内容。

### Memory embedding

Memory 的事实数据保存在独立 Catalog 中；下面这些进程环境变量只配置 Mem0 语义索引使用的 embedding：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `CHAT_MEMORY_EMBEDDER_PROVIDER` | `fastembed` | `fastembed` 或 `openai` |
| `CHAT_MEMORY_EMBEDDING_MODEL` | `fast-bge-small-zh-v1.5` | embedding 模型；`openai` Provider 默认 `text-embedding-3-small` |
| `CHAT_MEMORY_EMBEDDER_BASE_URL` | 空 | OpenAI 兼容 embedding 服务的 Base URL |
| `CHAT_MEMORY_EMBEDDER_API_KEY` | 空 | `openai` Provider 必填的 API Key |
| `CHAT_MEMORY_EMBEDDING_DIMENSION` | 由模型决定 | 自定义服务返回的正整数向量维度 |

FastEmbed 不需要 API Key，模型缓存位于 `<CHAT_HOME>/cache/fastembed`。修改 Provider、模型或向量维度后，在 Memory 管理页对相关 Target 执行“重建索引”。Memory 的存储路径、读写流程和管理方式见[Chat 长期记忆](./memory.md)。

## 5. Personal Chat 配置

Personal 默认 Workflow 位于 `<CHAT_HOME>/config.json`。它必须是完整配置：

```json
{
  "schemaVersion": 1,
  "defaultWorkflowId": "minimal-pi-coding-agent",
  "workflows": {},
  "sessions": { "removedRetentionDays": 30 }
}
```

`defaultWorkflowId` 必须是 Chat 已注册的 Workflow ID。`removedRetentionDays` 是已移除 Session 的保留天数，范围为 1～3650。`workflows` 可为 Workflow 中的 Agent 保存 `primary`、`append`、`promptFiles`、`promptResources`、`tools` 和 `resources` 默认选择；它不能直接写 `model` 或 `thinkingLevel`，也不保存模型目录或 Credential。

例如让一个 Agent 继承 Personal、Project 和 Pi 默认资源：

```json
{
  "schemaVersion": 1,
  "defaultWorkflowId": "minimal-pi-coding-agent",
  "workflows": {
    "minimal-pi-coding-agent": {
      "agents": { "pi-coding-agent": { "resources": { "mode": "inherit" } } }
    }
  },
  "sessions": { "removedRetentionDays": 30 }
}
```

## 6. Project 配置与资源

每个项目在根目录使用以下结构：

```text
<project-root>/.chat/
  project.json
  config.json
  skills/
  extensions/
  prompts/
```

`project.json` 声明可移植的项目身份：

```json
{
  "schemaVersion": 1,
  "id": "example-project",
  "name": "Example Project",
  "description": "由 Chat 维护的示例项目"
}
```

`id` 只能使用小写字母、数字和单个连字符分隔段，创建后保持稳定。项目移动或重新克隆时不要另换 ID。

项目 `config.json` 只写需要覆盖的字段。例如覆盖默认 Workflow：

```json
{
  "schemaVersion": 1,
  "defaultWorkflowId": "planning-execution"
}
```

也可以覆盖一个 Workflow Agent 的配置选择。例如只让直接执行 Agent 使用明确选择的资源：

```json
{
  "schemaVersion": 1,
  "workflows": {
    "minimal-pi-coding-agent": {
      "agents": {
        "pi-coding-agent": {
          "resources": {
            "mode": "explicit",
            "skillPaths": [".chat/skills/project-review"],
            "extensionPaths": [],
            "pluginSources": []
          }
        }
      }
    }
  }
}
```

项目资源分别放入 `.chat/skills`、`.chat/extensions` 和 `.chat/prompts`。Skill 使用标准 `SKILL.md` 结构，Extension 使用 Pi Extension 格式；采用 `resources.mode: "inherit"` 的 Agent 可以继承这些资源。

`project.json`、项目 `config.json`、`.pi/settings.json`以及团队需要共享的 Skill、Extension、Prompt 是否提交，由各项目自己的版本控制策略决定，并且必须确认其中没有 Credential。先检查项目的`.gitignore`，不要用强制暂存绕过既有策略；需要共享原本被忽略的配置时，应明确评审并修改该项目的跟踪规则。

Chat 源码仓库当前只跟踪`.chat/project.json`和`.chat/skills/**`，默认忽略`.chat/config.json`与整个`.pi/`。这是 Chat 项目自身的策略，不代表其他 Project 必须采用相同规则。Session、Memory、认证和运行状态不应放入项目`.chat`，也不应提交。

### Project 管理 Skill 与 Tool

Backend 初始化会把随产品发布的 `project-management` 安装到 `<CHAT_HOME>/agent/skills/project-management/SKILL.md`。下一轮继承资源的 Agent 可发现；已有同名用户 Skill 或用户修改的内容不会被升级覆盖。安装版本收据位于 `<CHAT_HOME>/runtime/builtin-skills/`，它不属于 Skill 目录。

Long Agent 未提供自定义 Definition 时，默认拥有 `project_search`、`project_read`、`project_create`、`project_open`、`project_update`、`project_configure`。已经保存显式 Definition 的 Agent 保留原选择；需要时在长期同事配置页选择这六个 `system:tool/project_*` 地址，资源用 inherit 或明确选择 Skill 路径。普通 Workflow Agent 也可通过同一 Tool 配置入口启用。

例如直接说“创建学习道德经项目”或“创建云南旅游规划，预算8000元，两个人”。不指定目录时，工作目录为 `<CHAT_HOME>/workspaces/<生成的projectId>`；`.chat/project.json` 保存身份和用途，`.chat/config.json` 默认继承。首次接入外部目录仍需先通过 Chat 项目选择器授权打开。

`project_read` 的 configuration 视图提供版本；`project_configure` 修改指定字段或通过 unset 恢复继承。创建结果提供进入新项目会话的链接，不修改当前会话归属。现有 Long Agent 的模型配置仍属于 Personal，不受 Project Workflow Agent 配置影响。完整参数和并发合同见 [Project 管理 Skill 与 Tool](./architecture/chat-project-management-design.md)。

## 7. Project 私有 Agent 配置

某个 Project、Workflow、Agent 的持久配置位于 Chat Home，而不在项目仓库：

```text
<CHAT_HOME>/projects/<projectId>/workflows/<workflowId>/agents/<agentId>.json
```

例如：

```json
{
  "schemaVersion": 1,
  "model": { "provider": "anthropic", "modelId": "claude-sonnet-4-5" },
  "thinkingLevel": "high",
  "tools": { "mode": "pi-default" }
}
```

模型必须已存在于内置或自定义模型目录中，并具有有效认证。该文件至少包含 `model`、`thinkingLevel` 或 `tools` 之一。通常应通过 Chat 界面或 API 修改，以便保存前验证模型、认证和 Tool；不要提交到项目 Git。

`PUT /api/workflows/:workflowId/agents/:agentId/model-config` 只覆盖请求中出现的字段：传对象或字符串表示设置，传 `null` 表示只清除该字段并保留其他覆盖，省略的字段保持不变；`model`、`thinkingLevel` 和 `tools` 全部移除后该文件自动删除。`DELETE` 一次清除 `model` 和 `thinkingLevel`，保留 `tools`。界面上“使用Workflow默认”对应逐字段清除，“恢复Workflow默认模型与思考等级”对应 `DELETE`。

## 8. Session、本轮调整与优先级

Session 位于 `<CHAT_HOME>/projects/<projectId>/sessions/*.jsonl`。它会记住该 Session 中各 Workflow 最近使用的 Agent 选择，并保存每一轮的冻结快照。它是运行历史，不是供用户手工维护的配置文件。

界面中的本轮调整只改变请求中明确指定的 Agent；空选择表示恢复该 Agent 的默认配置。本轮配置在运行开始时固定，文件变化从下一轮起生效。请通过 Chat 界面或 API 操作，不要编辑 Session JSONL。

配置作用域可按以下顺序理解，越靠后越具体：

```text
内置 workflow.json / agent.json
→ Personal <CHAT_HOME>/config.json
→ Project <project-root>/.chat/config.json
→ 当前 Session 最近选择
→ 本轮明确调整
```

Project 私有 Agent 文件单独覆盖该 Agent 的模型、Thinking Level 和 Tool；Session 或本轮若明确选择 Tool，则以更具体的选择为准。Agent 没有指定模型时，才使用 Session 恢复结果或 `agent/settings.json` 的默认模型。

修改 Personal 默认不会重写已有 Session 的最近选择。若要立即恢复新默认，请在界面中重置对应 Agent，或新建 Session。

显式Tool策略是完整选择：`names: []`加上`addresses: ["system:tool/memory_search"]`表示只启用Memory搜索，不会继承内置Planner的`read`。Planner需要读取Skill或Project文档时，应在该项目的Tool配置中保留`read`；运行时不会绕过用户覆盖偷偷增加工具。修正配置不修改历史Session，后续Run重新解析默认值；Session/本轮若另有明确覆盖，仍按上述优先级生效。

## 9. Workflow 源码配置

内置 Workflow 的开发配置位于：

```text
src/workflows/<workflowId>/workflow.json
src/workflows/<workflowId>/agents/<agentId>/agent.json
```

`workflow.json` 声明名称、节点和 Agent 引用；`agent.json` 声明 Agent 的默认 Prompt、模型、Thinking Level、Tool 和资源策略。它们属于产品源码，不是普通用户的 Personal 或 Project 配置入口。

新增或修改内置 Workflow 时，应遵守[Workflow 开发框架](./architecture/chat-workflow-framework.md)并更新测试；不要为了改变一个项目的模型或资源而修改内置源码配置。

## 10. 常见操作速查

| 目的 | 配置位置 |
|---|---|
| 使用本地初始网页登录 | 用户名 `chat`、密码 `123456` |
| 修改网页登录账号、密码或 Cookie 有效期 | 进程环境；Linux 部署为 `/etc/chat/chat.env` |
| 修改所有项目的默认模型 | `<CHAT_HOME>/agent/settings.json` |
| 修改一个项目的 Pi 默认模型 | `<project-root>/.pi/settings.json` |
| 添加自定义 Provider 或模型 | `<CHAT_HOME>/agent/models.json` |
| 管理 Provider 认证 | `<CHAT_HOME>/agent/auth.json`，使用认证流程 |
| 管理Long Agent身份、全局启停、默认Project与Agent能力 | Project侧边栏切到“长期同事”面板后使用同事设置；Personal事实在`<CHAT_HOME>/long-agents.json` |
| 修改Long Agent显示头像 | 同事设置页的身份区域；图片资产在`<CHAT_HOME>/long-agents-assets/` |
| 查看Long Agent的Telegram/NanoClaw Host信息 | 同一配置页的只读摘要；不返回Credential或Token |
| 修改 Personal 默认 Workflow | `<CHAT_HOME>/config.json` |
| 修改一个项目的默认 Workflow | `<project-root>/.chat/config.json` |
| 添加项目 Skill、Extension、Prompt | `<project-root>/.chat/{skills,extensions,prompts}` |
| 修改某项目中某 Agent 的模型或 Tool | Chat 界面/API；数据在 `<CHAT_HOME>/projects/<projectId>/workflows/...` |
| 临时调整当前一轮 | Chat 运行界面/API |
| 新增内置 Workflow 或 Agent | `src/workflows/<workflowId>/`，仅限开发者 |

修改 JSON 前先备份私有配置并保持 `schemaVersion: 1`。若 Chat 报告未知字段、无效 Workflow/Agent ID、找不到模型或缺少认证，应修正配置，不要绕过校验。

## 系统生命周期与运行实例（已认可目标）

完整Chat的启动、停止、就绪、在途收尾和恢复见[系统生命周期合同](./architecture/chat-system-lifecycle.md)。运行实例统一解析Chat Home、Nano数据范围、端点、服务归属和启用组件；具体字段与Schema尚待实现，不能直接把概念字段写入当前配置。

该合同沿用Chat配置体系，避免脚本、VSCode、Nano服务和Web各自维护一份组件清单或启停策略。运行实例不是Long Agent；同一实例仍可承载多个独立Agent。当前开发脚本只管理Backend/Vite，生产Chat与Nano服务仍独立管理，完整协同尚未实现。
