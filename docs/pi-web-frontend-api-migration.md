# Pi Web 前端 API 迁移清单

## 1. 目的

Pi Web 的浏览器源码已经进入 Chat 的 `frontend/`。Pi Web 原来的 Next.js 后端不进入 Chat，也不再作为运行依赖；Pi Web 的现有前端功能全部保留为 Chat 的目标能力，由 Chat 后端逐项接管。

状态定义：

- **已接入**：接口已经由Chat实现并完成自动化验证。
- **部分接入**：页面可以使用，但原Pi Web的全部读写语义尚未覆盖。
- **待迁移**：前端源码和入口保留，后续必须由 Chat 后端实现。
- **由Chat替代**：不再保留原Pi Web中转路由，浏览器改为调用等价的Chat公开接口。

## 2. 所有权边界

```text
Chat/frontend（纯浏览器）
  → Chat HTTP API
    → Chat用例或Pi能力
      → 文件系统、Git、Credential、Pi Session与Workflow Runtime
```

浏览器不得导入Pi SDK、读取文件系统、接触Provider Credential、解析Pi Session文件或直接调用Workflow Runtime内部接口。Chat路由负责网络输入校验和响应投影；具体能力优先复用Pi，不在路由中重写一套实现。

## 3. 已接入的运行与会话能力

| 前端能力 | Pi Web原接口 | Chat接口 | 当前实现 | 最终责任 |
|---|---|---|---|---|
| 发送普通文本Prompt | `POST /api/chat-workflow` | `POST /runs` | 已接入，由Chat替代 | 浏览器提交Workflow及每个Agent的配置选择，Chat启动对应Workflow并由浏览器轮询Run状态 |
| 取消运行 | 原Adapter转调Chat | `DELETE /runs/:runId` | 已接入 | 浏览器取消请求时同步取消Chat Workflow Run |
| 查询运行 | 原Adapter轮询Chat | `GET /runs/:runId` | 已接入 | Chat返回Workflow状态和最终结果 |
| 展示Agent执行过程 | 原Agent RPC事件 | `GET /runs/:runId/events` | 已接入，由Chat替代 | Chat按Stage流式返回Thinking、文本、Tool Call和Tool Result事件 |
| Session列表 | `GET /api/sessions` | `GET /api/sessions` | 已接入 | Chat只扫描`Chat/.chat/sessions` |
| Session详情 | `GET /api/sessions/:id` | 同路径 | 已接入，只读 | Chat按Session ID读取Pi Session |
| Session上下文 | `GET /api/sessions/:id/context` | 同路径 | 已接入，只读 | Chat投影消息、节点ID、模型和Thinking Level |
| 默认目录 | `GET /api/home` | 同路径 | 部分接入 | 当前返回Chat进程工作目录 |
| 工作目录校验 | `POST /api/cwd/validate` | 同路径 | 部分接入 | Chat校验目录存在且为目录 |
| 本机设备 | `GET /api/devices` | 同路径 | 部分接入 | 当前只有本机Chat实例 |
| 模型展示 | `GET /api/models` | 同路径 | 部分接入 | 当前模型以Workflow实际返回值为准 |
| 项目信任 | `GET/POST /api/project-trust` | 同路径 | 部分接入 | Chat拥有授权判断，不允许前端伪造 |

## 4. 必须支持的后续接口

### 4.1 Session完整能力

| 接口 | 前端用途 | 状态 | 后续实现方向 |
|---|---|---|---|
| `PATCH /api/sessions/:id` | Session重命名 | 待迁移 | Chat按Session ID调用Pi Session元数据能力 |
| `DELETE /api/sessions/:id` | 删除Session | 待迁移 | Chat校验目标与并发状态后删除 |
| `GET /api/sessions/:id/entries/:entryId/thinking` | 延迟加载Thinking | 待迁移 | Chat只返回指定Session节点的展示内容 |
| `GET /api/sessions/:id/export` | 导出Session | 已接入 | Chat基于Pi导出完整历史，并按Workflow、Stage和Agent整理输入、Thinking、工具调用与输出和最终回复 |
| `GET /api/sessions/:id/state` | 页面状态恢复 | 待迁移 | 评估保留Pi格式或改为Chat前端偏好 |

### 4.2 文件、目录与Git

| 接口 | 前端用途 | 状态 | 后续实现方向 |
|---|---|---|---|
| `GET /api/cwd/browse` | 目录选择器 | 待迁移 | Chat校验根目录和可见范围后列目录 |
| `GET /api/default-cwd`、`POST /api/default-cwd` | 默认工作目录 | 待迁移 | Chat配置，不写入浏览器或Pi Session |
| `GET /api/file-index` | `@file`搜索 | 待迁移 | 优先复用Pi/独立文件索引能力 |
| `GET /api/files/[...path]` | 文件列表、读取、元数据、下载、预览和文件变化监听 | 已接入 | 已迁入Pi Web实现；Chat验证允许根目录、路径穿越和符号链接真实路径 |
| `POST /api/files/[...path]` | 文件上传与冲突处理 | 待迁移 | 迁入原上传大小、文件名、覆盖策略和真实路径校验 |
| `GET /api/git/status` | Git状态 | 待迁移 | 复用Git命令能力并限制cwd |
| `GET /api/git/diff` | Diff查看 | 待迁移 | 返回结构化或文本Diff投影 |
| `GET/POST/DELETE /api/worktrees` | Worktree查看、创建和移除 | 待迁移 | Chat执行Git并校验破坏性操作 |

### 4.3 模型、Provider与认证

| 接口 | 前端用途 | 状态 | 后续实现方向 |
|---|---|---|---|
| `GET/PUT /api/models-config` | 模型配置 | 待迁移 | 复用Pi模型配置服务，Chat控制配置目录 |
| `GET /api/models-config/catalog` | 模型目录 | 待迁移 | 复用Pi模型目录 |
| `POST /api/models-config/discover` | Provider模型发现 | 待迁移 | 后端执行网络发现，不暴露Credential |
| `POST /api/models-config/test` | 模型连接测试 | 待迁移 | 后端执行显式Provider测试 |
| `GET /api/auth/providers` | 已配置Provider | 待迁移 | 只返回脱敏状态 |
| `GET /api/auth/all-providers` | Provider目录 | 待迁移 | 复用Pi Provider定义 |
| `POST /api/auth/login/:provider` | OAuth登录 | 待迁移 | Chat后端持有流程和回调状态 |
| `POST /api/auth/logout/:provider` | 退出Provider | 待迁移 | Chat清理对应Credential |
| `POST/DELETE /api/auth/api-key/:provider` | API Key配置 | 待迁移 | 密钥只进入Chat后端安全存储 |
| `GET/POST/DELETE /api/auth/session` | Web登录、状态和退出 | 已接入 | Chat签名HttpOnly Cookie；与Provider认证分离 |

### 4.4 Skills、Plugins与Extensions

| 接口 | 前端用途 | 状态 | 后续实现方向 |
|---|---|---|---|
| `GET/PATCH /api/skills` | Skill列表与模型调用开关 | 已接入 | 使用Chat的`.chat/agent`和Pi ResourceLoader；只修改已解析Skill的frontmatter |
| `POST /api/skills/search` | Skill搜索 | 已接入 | 后端访问skills.sh，失败时使用参数化npx调用 |
| `POST /api/skills/install` | Skill安装 | 已接入 | 后端校验cwd并执行参数化npx调用 |
| `POST /api/skills/check` | Skill更新检查 | 待迁移 | 后端检查版本 |
| `POST /api/skills/update` | Skill更新 | 待迁移 | 明确升级与失败恢复 |
| `GET/POST /api/plugins` | Plugin列表、安装、删除、更新和启停 | 已接入 | 直接使用Pi SettingsManager与DefaultPackageManager |
| `GET/POST /api/extensions` | Extension列表与文件级启停 | 已接入 | 使用Pi Package解析；本地单文件通过`.disabled`切换 |
| `POST /api/workflows/:workflowId/agents/:agentId/resolve` | 查看Agent最终能力 | 已接入 | 创建不发送Prompt的内存Pi AgentSession，返回最终Prompt、Tool和资源事实 |

### 4.5 其他现有前端功能

| 接口 | 前端用途 | 状态 | 后续实现方向 |
|---|---|---|---|
| `GET /api/provider-requests` | Provider请求审阅 | 待迁移 | Chat读取脱敏的请求证据 |
| `GET/POST/DELETE /api/push` | Web Push状态、订阅和取消 | 待迁移 | Chat持有订阅和通知发送 |
| `GET /api/app-update` | 前端更新提示 | 待迁移 | 改为Chat版本与发布来源 |
| `POST /api/devices/select` | 多设备切换 | 待迁移 | Chat设备目录和连接策略 |
| `GET /api/health` | 健康检查 | 已接入 | 匿名返回Chat进程的轻量健康状态 |

## 5. 迁移规则

1. 所有表中接口都必须保留在迁移清单，不能因为当前功能未使用而删除前端功能。
2. 优先保持Pi Web现有URL和JSON合同；只有原合同泄漏服务端路径、Credential或Pi内部对象时才收窄，并同步修改前端调用。
3. 不复制Pi Web Next.js Route实现。每项迁移都先确认它依赖的Pi公开能力，再决定直接复用或写窄的Chat路由。
4. “部分接入”不是完成状态。只有原界面全部交互、失败行为和权限边界通过测试后才能标为完整。
5. 每完成一项，更新本表状态，并添加对应的网络合同测试和真实浏览器验证。

## 6. 当前质量门

当前测试直接参考Pi Web原有的`session-reader`、`file-access`、`file-types`、`chat-workflow-contract`和构建路由用例，保留了以下关键边界：

- Chat只扫描自己的`.chat/sessions`，不读取其他Session目录。
- Pi压缩、分支与消息节点ID保持对齐。
- 历史Thinking和Tool Result图片按请求延迟投影。
- Pi Tool Call字段在进入浏览器前完成转换。
- 文件路径拒绝目录前缀伪装、`..`穿越和符号链接逃逸。
- 前后端对图片、音频、PDF和DOCX类型的判断一致。
- Workflow输入区分新Session与已有Session，并只接受`minimal-pi-coding-agent`或`planning-execution`两个注册值。
- Workflow过程通过可恢复读取的NDJSON事件流传给浏览器，Planner输出不会在Executor开始后被替换。
- 完整历史保留Pi实际持久化的Thinking与工具数据，并展示每个Agent Stage收到的真实输入来源。
- 构建后的单进程同时提供前端、Session API和文件API。
- 默认Web账号可以登录，未认证请求不能访问Session、文件和Workflow API。
- PWA manifest、Service Worker、离线页和图标在构建产物中保持可安装。

执行快速测试：

```bash
pnpm test
```

执行完整交付门：

```bash
pnpm verify
```

`pnpm verify`依次运行后端测试、前端合同测试、类型检查、完整构建和隔离生产服务器HTTP测试。真实模型调用不放进确定性测试；Workflow到Pi Coding Agent的付费调用在明确需要时单独执行。
