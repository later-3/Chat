# Chat Context与Resource统一模型

## 1. 文档地位

本文是Chat中Project、Session、Workflow、Agent、Memory、Skill、Extension、Tool、Prompt和配置共同遵守的基础协议。具体领域文档只能扩展本文，不能为同一个概念重新定义身份、作用域、路径或加载规则。

Chat在Pi Agent公开能力之上增加管理层，不改变Pi的`SKILL.md`、Extension、`registerTool()`、`ToolDefinition`、`ResourceLoader`、`SettingsManager`、`SessionManager`或`AgentSession`合同。

## 2. 核心不变量

1. 当前执行上下文不等于操作目标。
2. 资源归属不等于可见范围，可发现不等于已加载，已加载不等于允许执行。
3. Project长期身份只能使用稳定`projectId`；`cwd`只是当前机器上的可变路径。
4. 浏览器和Agent提交身份与目标，物理路径只能由后端Resolver产生。
5. 默认行为可以使用“个人+当前Project”，底层接口必须支持显式个人、当前Project和其他已登记Project。
6. 跨Project访问不改变资源原归属，并保留发起Project、Session、Workflow、Agent和Turn来源。
7. Credential只属于个人；Project只能引用Provider和Model，不能保存密钥。
8. 所有持久变更和实际运行装配都必须保留来源、版本和必要日志。

## 3. Context、Target与Address

一次运行拥有不可变上下文：

```ts
interface ChatExecutionContext {
  readonly personalId: string;
  readonly projectId: string;
  readonly projectRoot: string;
  readonly cwd: string;
  readonly sessionId?: string;
  readonly workflowId?: string;
  readonly workflowInvocationId?: string;
  readonly agentId?: string;
  readonly turnId?: string;
}
```

操作目标与上下文独立：

```ts
type ResourceTarget =
  | { readonly type: "personal" }
  | { readonly type: "project"; readonly projectId: string }
  | { readonly type: "session"; readonly projectId: string; readonly sessionId: string }
  | { readonly type: "invocation"; readonly invocationId: string };

interface ResourceAddress {
  readonly kind: "memory" | "config" | "skill" | "extension" | "tool" | "prompt";
  readonly target: ResourceTarget;
  readonly id?: string;
}
```

每个领域服务接收`ChatExecutionContext`和显式`ResourceTarget`。缺省Target由该领域的默认策略补全，而不是由存储层猜测。

## 4. 用户级与Project级目录

```text
~/.chat/
├── config.json
├── agent/
│   ├── auth.json
│   ├── models.json
│   ├── settings.json
│   ├── skills/
│   ├── extensions/
│   └── prompts/
├── memory/
│   └── personal/
│       ├── catalog.db
│       └── vector-store.db
├── projects/
│   ├── registry.json
│   └── <projectId>/
│       ├── sessions/
│       ├── memory/
│       │   ├── catalog.db
│       │   └── vector-store.db
│       └── prompt-resources/
├── runtime/
│   ├── workflow-data/
│   └── skills/
├── cache/
│   └── fastembed/
└── logs/

<project-root>/.chat/
├── project.json
├── config.json
├── skills/
├── extensions/
└── prompts/
```

`~/.chat`保存当前用户的私有运行数据。Project仓库中的`.chat`只保存可移植声明和资源，不保存Credential、Session、Memory数据库或运行日志。

## 5. Project Registry与Context解析

`<project-root>/.chat/project.json`提供可移植身份；`~/.chat/projects/registry.json`提供当前机器路径、打开时间和可用状态。

除“打开/登记Project”外，API不能把cwd作为Project身份。正常请求提交`projectId`；服务端从Registry解析路径，并在请求同时携带cwd时验证二者一致。

所有Workflow、Session、Memory、配置、资源和文件访问共用一个`ChatProjectContextResolver`，不得各自从`process.cwd()`推导Project。

## 6. Resource Catalog与运行时加载

Resource Catalog使用限定地址，例如：

```text
personal:skill/review
project/chat:skill/review
project/ziji-content-lab:extension/content-tools
workflow/memory/memory-agent:tool/memory_search
```

Chat限定地址只用于管理、冲突检测和日志。传给Pi时仍是原生文件和Tool名称。

默认发现与装配：

```text
Pi内置能力
  + 个人资源
  + 当前可信Project资源
  + Workflow Agent私有资源
  + 本次Session/Run显式激活资源
```

其他Project资源可在Catalog中查询；显式激活后通过Pi的`additionalSkillPaths`、Extension Loader或`customTools`进入本次AgentSession。Extension是代码执行，必须校验目标Project Trust和Tool名称冲突。

## 7. 各领域允许的Target

| 领域 | Personal | 当前Project | 其他Project | Session/Run |
|---|---|---|---|---|
| Memory | 是 | 是 | 显式读写 | 记录来源，不作为独立长期库 |
| Config | 默认 | 覆盖 | 显式管理 | 临时覆盖 |
| Skill/Prompt | 安装/保存 | 安装/保存 | 显式查询、安装、激活 | 临时激活 |
| Extension/Tool | 安装 | 安装 | 信任后显式激活 | 临时启停 |
| Session | 否 | 固定归属 | 通过fork/clone创建新Session | 自身 |
| Credential | 唯一允许位置 | 禁止 | 禁止 | 只能引用 |
| Workflow运行数据 | 否 | 默认 | 不跨Project复用 | 按Invocation记录 |

“框架支持Target”不代表每种资源允许所有Target；允许集合由领域Policy声明并由后端执行。

## 8. Memory命名空间

Memory使用一个`MemoryStoreManager`管理多个独立Store：

```text
Personal Store
Project chat Store
Project ziji-content-lab Store
...
```

每个Store包含自己的Chat事实库和Mem0可重建索引。正常查询并发检索Personal Store和当前Project Store；显式查询可以指定任意已登记Project集合。多Target写入创建独立记录，使用共同`groupId`和Source关联，但允许以后独立更新或删除。

默认策略是“查询个人+当前Project，写入当前Project”。这只是默认策略，不是底层限制。

## 9. 配置解析

```text
Workflow/Agent源码默认
  ↓
~/.chat/config.json Personal默认
  ↓
<project-root>/.chat/config.json Project覆盖
  ↓
Session/本次Run临时覆盖
```

一次Workflow Invocation在启动时解析并冻结配置和资源版本。文件变化从下一次Invocation生效。

## 10. 版本与日志

文件资源至少记录内容Hash、来源和修改时间；Package资源记录包版本；配置记录Schema版本；Memory记录业务版本；Workflow运行记录实际装配的资源地址和版本。

必要管理日志包括配置修改、资源安装/更新/启停、跨Project激活、Memory增删改和显式跨Project读写。日志用于审计和排障，不把整个系统改造成事件溯源架构。

## 11. Skill与代码的关系

架构文档是完整事实源；`chat-architecture` Skill是面向Agent的操作投影；Schema和测试是机器可执行合同。Skill说明如何选择Target和调用能力，但不能授予权限。即使Agent未读取Skill，后端也必须通过Context Resolver、Resource Resolver和Policy保证上述不变量。

## 12. 新能力接入检查

新增Workflow、Agent、Tool、Skill或持久资源时必须回答：

1. 当前`ChatExecutionContext`从哪里注入？
2. 允许哪些`ResourceTarget`，默认Target是什么？
3. 资源的Owner、物理存储和稳定ID是什么？
4. 如何发现、授权、解析、加载和检测冲突？
5. 使用哪个Pi公开接口？
6. 如何记录来源和版本？
7. Project移动、Session恢复、索引重建和跨Project访问如何测试？

## 13. 源码落地映射

| 合同 | 实现入口 |
|---|---|
| Chat Home | `src/chat-home.ts` |
| Project Manifest、Registry、Context | `src/projects/` |
| Personal + Project配置 | `src/chat-config.ts` |
| Project Session分区 | `src/chat-session.ts`、`src/session-read-model.ts` |
| Pi Project Trust与资源装配 | `src/projects/trust.ts`、`src/workflows/agent-definition.ts` |
| Resource Address与文件版本 | `src/resources/version.ts` |
| Personal + 每Project Memory Store | `src/memory/manager.ts`、`src/memory/runtime.ts` |
| 可恢复旧数据迁移 | `src/migrations/project-layout-v1.ts` |
| 管理审计日志 | `src/audit-log.ts`，运行文件为`~/.chat/logs/audit.jsonl` |
| Agent操作投影 | `src/skills/chat-architecture/SKILL.md` |

Pi Web只通过上述后端事实工作：项目选择来自`GET /api/projects`，Memory页选择Personal或任意登记Project，Workflow、Session、Agent Resolve、配置、Trust和资源请求携带同一个`projectId`。
