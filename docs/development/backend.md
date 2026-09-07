# Backend 开发

本文面向 Chat Backend 贡献者和协助开发的外部 AI，说明服务端代码的位置、开发方式和必须保持的边界。配置文件的具体位置与写法见 [Chat 系统配置](../configuration.md)；跨模块设计见 [Chat 当前架构](../architecture/chat-current-architecture.md)。

## Backend 的职责

Backend 是 Frontend 与本地运行能力之间唯一的服务端边界，负责：

- 通过 HTTP API 接收请求，并校验输入、权限和状态转换；
- 解析 Project、Session、Workflow、Agent 与资源的服务端事实；
- 启动和恢复 Workflow，统一装配 Pi AgentSession；
- 在 Chat Home 与 Project 允许的目录中安全、可靠地持久化数据；
- 向 Frontend 返回不含服务端实现和敏感信息的结构化投影。

Frontend 不能直接访问文件系统、导入 Pi SDK 或自行推导 Workflow 和资源状态。Backend 也不应把确定性业务状态机、安全门禁或持久化责任交给 Prompt。

## 源码入口

| 位置 | 职责 |
|---|---|
| `src/routes/` | Nitro HTTP 路由、请求解析和 HTTP 状态映射 |
| `src/projects/` | Project Manifest、Registry 与 `ChatProjectContext` |
| `src/workflows/` | Workflow 注册、运行、配置解析和 Agent 装配 |
| `src/tools/` | Chat 系统 Tool 的声明、解析与执行记录 |
| `src/resources/` | Tool、Skill、Extension、Plugin 等资源目录与访问控制 |
| `src/prompt-resources/` | Rule、Experience 等 Prompt 资源的版本化存储 |
| `src/memory/` | Personal 与 Project Memory 服务及存储 |
| `src/files/` | 授权文件根目录、路径校验和文件索引 |
| `src/session-*.ts`、`src/chat-session.ts` | Session 读写、状态、导出和生命周期 |
| `src/middleware/`、`src/plugins/` | 认证和进程级初始化 |

增加能力时先找到所属模块的公共入口，不在路由、Workflow Step 或 Frontend 中复制已有解析、授权或持久化逻辑。

## 本地开发

首次准备仓库：

```bash
git submodule update --init --recursive
pnpm pi:prepare
pnpm install --frozen-lockfile
```

启动 Backend：

```bash
pnpm dev
```

Backend 默认监听 `http://127.0.0.1:43112`。需要同时调试浏览器页面时，在另一个终端运行 `pnpm dev:frontend`；Vite 会把 `/api` 和 `/runs` 转发到 Backend。运行时数据默认写入 `~/.chat`，测试或隔离开发环境使用 `CHAT_HOME` 显式覆盖。

## HTTP 合同

路由入口读取到的 body、query、path parameter 和外部服务响应都应视为 `unknown`。使用所属模块的 Parser 或 Validator 完成运行时校验后，才能传给领域服务；TypeScript 类型断言不能替代运行时校验。配置和版本化对象应拒绝未知字段，并校验 Schema Version、标识符、枚举、必填字段及相互约束。

返回值应是稳定、可序列化且对浏览器安全的结构，不直接暴露函数、内部路径、Credential 或 Pi 运行时对象。新增或修改 HTTP 响应时，应同步更新 Frontend 的运行时解析器和合同测试；执行接口与检查接口必须从同一个 Backend 事实源生成结果。

## ProjectContext 与路径边界

HTTP 边界通过 `src/projects/` 的公共入口将 `projectId` 解析为 `ChatProjectContext`。后续服务应传递这个可信上下文，而不是重复接收或推导 `cwd`、Session 目录和数据目录。

- 用户明确打开的目录就是 Project 根目录；不自动搜索父目录或子目录。
- `projectId` 必须与 Registry、Project Manifest 和实际目录一致。
- 不用 `process.cwd()` 推断 Chat Home 或用户 Project；Chat Home 只通过 `CHAT_HOME` 或默认值解析。
- 浏览器提供的任意路径都不直接用于文件操作。先解析真实路径，再使用 `src/files/` 的授权根目录和边界检查，防止 `..`、符号链接或跨 Project 访问。
- Session、Memory 和 Prompt 资源始终按稳定 `projectId` 隔离；跨 Project 操作必须显式指定并重新校验目标。

## 持久化与敏感信息

配置、索引和运行状态写入必须使用模块已有的原子替换、写入串行化、版本检查或锁；不要直接覆盖共享 JSON，也不要在并发读写路径中自建无保护的文件写入。新增数据格式时要定义 Schema Version、损坏处理以及可恢复、可重试的迁移方式。

Credential、Cookie、Token、模型密钥和正式用户数据不得写入仓库、日志或浏览器响应。用户级运行数据写入 Chat Home；Project 仓库只保存允许随源码移动的声明式配置。API 若需展示配置，应返回安全投影，而不是原始认证文件。

## Workflow 与 Pi 的装配边界

Backend 的主执行链是：

```text
HTTP → ProjectContext → Workflow Registry → Workflow → Agent 装配 → Pi AgentSession
```

- Workflow 负责编排 Node、Stage 和领域服务，不是第二套 Agent Runtime。
- 所有 Workflow Agent 都通过公共 `createWorkflowAgentSession()` 装配；执行与配置检查复用同一路径。
- Model、Prompt、Tool、Skill、Extension、Plugin 和 Session 上下文最终交给 Pi `ResourceLoader`、`AgentSession` 与 `SessionManager`。
- Tool 使用 Pi `ToolDefinition`，由 Extension 注册或通过公共 SDK Custom Tool 路径注入；不要新增重复的 Tool 类型或旁路注册表。
- 修改 `pi/` 前阅读并遵守 [`pi/AGENTS.md`](../../pi/AGENTS.md)。修改 Workflow 框架时先阅读 [Chat Workflow 开发框架](../architecture/chat-workflow-framework.md)。

## 错误处理

领域模块应抛出可识别、可测试的错误；HTTP 路由负责将其转换为合适的状态码和对用户有帮助的简短信息：输入错误通常是 `400`，未授权或越界是 `401/403`，不存在是 `404`，状态或版本冲突是 `409`，无法继续处理才是 `500`。

不要把预期的用户错误统一包装成 `500`，也不要把堆栈、绝对私有路径、凭证或上游响应原文返回给浏览器。错误路径应与成功路径一样覆盖合同测试，尤其包括未知字段、跨 Project、路径逃逸、重复提交、版本冲突和部分写入。

## 验证

开发时先运行与修改模块对应的 Backend 测试：

```bash
pnpm test:backend
```

Backend 测试与所属模块放在`src/**`中并使用`*.test.mjs`命名；测试运行器会统一发现这些文件。新增行为优先在相邻现有测试中补场景，只有职责独立时才新建测试文件。

交付 Backend 代码前运行完整验证：

```bash
pnpm verify
git diff --check
git -C frontend diff --check
```

`pnpm verify`包含 Backend 与 Frontend 测试、类型检查、生产构建、Built Server 和 Nitro 开发运行链验证。Workflow、Step bundle 或 Agent 装配改动还有额外场景要求，见 [测试指南](../testing.md)。

## 继续阅读

- [开发文档索引](./README.md)：按修改范围选择模块文档。
- [编码规范](./coding-standards.md)：TypeScript、模块、错误、安全与持久化约束。
- [Chat 系统配置](../configuration.md)：模型、Workflow、Agent 与 Project 配置的用户用法。
- [Chat 当前架构](../architecture/chat-current-architecture.md)：当前执行链和事实源。
- [Chat Workflow 开发框架](../architecture/chat-workflow-framework.md)：新增或修改 Workflow 的完整合同。
- [测试指南](../testing.md)：测试分层、命令和 Fixture。
- [根 `AGENTS.md`](../../AGENTS.md)：项目级强制规则与文档同步要求。
