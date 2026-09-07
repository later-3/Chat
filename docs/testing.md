# Chat 测试说明

本文说明 Chat 父仓库的测试层级、常用命令和新增回归测试的原则。Frontend、Pi与NanoClaw是独立Submodule；修改它们时还要遵守各自仓库的测试要求。

## 测试层级

Chat 的测试从快到慢分为四层：

1. **针对性测试**：验证一个模块或一次修复，适合开发中的快速反馈。
2. **父仓库测试与类型检查**：验证 Backend、Frontend 合同和 TypeScript 类型。
3. **生产构建与构建产物测试**：验证 Frontend 与 Nitro 能构建，并检查生产服务的 HTTP、资源、Session、Workflow 和 Pi 装配链。
4. **Nitro 开发链测试**：启动真实开发服务，验证开发环境生成的 Step bundle、Workflow Runtime、Frontend Run 合同和本地假模型能够走到完成状态。

相邻层级通过不能代替用户实际经过的链路。尤其是 Workflow 在普通 Node 测试中通过，不代表 Nitro 开发 Step bundle 或生产构建一定可用。

## 常用命令

在父仓库根目录运行：

```bash
# 单个 Backend node:test 文件
node --import ./scripts/typescript-test-loader.mjs \
  --experimental-strip-types --test src/example.test.mjs

# 架构导航、Skill单一来源与开发启动脚本
pnpm check:architecture
pnpm test:tooling

# 全部 Backend 测试
pnpm test:backend

# 全部 Frontend 测试
pnpm test:frontend

# 父仓库与 Frontend 类型检查
pnpm typecheck

# Frontend 与 Nitro 生产构建
pnpm build

# 测试已经生成的 .output 生产服务
pnpm test:built

# 测试 Nitro 开发服务和真实 Workflow 开发链
pnpm test:dev

# 完整验证链
pnpm verify
```

`pnpm test:built` 依赖 `pnpm build` 生成的 `.output`，不要把旧构建产物的通过结果当成当前源码的验证结果。

Frontend 单个测试可在需要时直接运行：

```bash
node --experimental-strip-types --test frontend/lib/example.test.mjs
```

## 什么改动跑什么

| 改动 | 开发中至少运行 | 完成前运行 |
|---|---|---|
| 纯文档/架构Skill | 链接与示例检查；Skill变更做有界只读场景问答 | `pnpm check:architecture`、`git diff --check` |
| 开发启动与调试配置 | `pnpm test:tooling`；核对VSCode配置 | 隔离Chat Home的真实启动/停止冒烟；源码映射与断点需单独验证 |
| 单个 Backend 模块 | 对应的单文件测试 | `pnpm test:backend`、`pnpm typecheck` |
| Backend API 或持久化合同 | 相关模块与 API 测试 | `pnpm verify` |
| Frontend 逻辑或 Backend/Frontend 合同 | 对应 Frontend 测试 | `pnpm test:frontend`、`pnpm typecheck`；完成前通常运行 `pnpm verify` |
| 构建、路由、静态资源或生产启动 | 相关测试 | `pnpm build`、`pnpm test:built` |
| `src/workflows/**`、Workflow SDK、Builder Patch、Agent 装配或 Workflow 可达资源 | 对应单元/合同测试 | `pnpm verify`，并确认 `pnpm test:dev` 实际覆盖目标启动链 |
| `frontend/` 或 `pi/` 的 gitlink | 子仓库自身验证 | 父仓库 `pnpm verify` |
| `nanoclaw/` 源码或 gitlink | 源码改动运行NanoClaw自身测试/构建及受影响桥接合同；更新gitlink时确认Commit已存在于公开Fork的`chat`分支 | 父仓库Submodule与差异检查；涉及Chat桥接运行的改动运行父仓库`pnpm verify`并验证两侧合同 |

完成代码修改后还应运行：

```bash
git diff --check
git -C frontend diff --check
```

测试通过只说明已覆盖的行为通过。提交前仍要检查架构、配置、Frontend 合同和生产装配路径是否与改动一致。

## 测试隔离

测试不得读写用户真实的 `~/.chat` 或正式 Project 数据。

- 为每次测试创建临时根目录，并通过绝对路径 `CHAT_HOME` 指向其中的 Chat Home。
- Project 应在临时目录中创建自己的 `.chat/project.json` 和所需 Fixture。
- Session、Memory、Prompt 资源、模型配置和 Workflow 数据都应留在该临时目录。
- 测试结束后关闭 Server、文件句柄和监听端口，并清理测试创建的数据。
- 不依赖开发者当前工作目录中碰巧存在的配置、模型或凭据。

涉及文件访问时，应同时测试允许路径、越界路径、符号链接或规范化后的真实路径；不能只验证正常输入。

## 模型与外部服务

自动化测试必须可重复、可离线控制，并且不能产生真实费用或外部副作用。

- 不读取或写入正式 Provider 密钥、Credential、Cookie 或 Token。
- 不调用付费模型，也不把真实模型可用性作为测试前提。
- 需要验证 Agent 或 Workflow 时，在测试进程内启动本地假模型服务，返回确定性的流式响应和固定 Token 用量。
- 需要 Embedding 或其他外部协议时，使用本地受控服务模拟实际 HTTP 合同。
- 假模型应只模拟测试需要的协议和分支；不要在测试中复制完整 Provider 实现。
- CI 不执行外部写操作，也不依赖实时模型目录刷新。

## 新增回归测试

优先测试用户可观察的场景和模块合同，而不是私有函数的实现细节。一个有效的回归测试通常包含：

1. 构造最小但真实的输入、Project 和 Chat Home。
2. 经过生产代码使用的公开入口或同一装配路径。
3. 断言结果、持久化状态和必要的错误边界。
4. 覆盖导致事故的条件，并证明旧问题不会静默复发。
5. 保持输出确定，不依赖时间竞态、网络状态或正式数据。

新增 API 时，应覆盖有效请求、无效结构、Project 边界、失败状态和不会泄露敏感字段的响应。新增持久化行为时，应覆盖中断、重复执行、冲突或恢复语义中与该功能有关的部分。

开发故障如果形成可复用结论，还应在 `docs/development-experiences/` 记录事故背景、原因和门禁；对应自动化测试是结论的一部分，不能只补文档。

## 完整验证

`pnpm verify` 是父仓库完成代码改动后的统一验证入口，当前顺序为：

```text
架构入口与开发启动工具检查
→ Backend 与 Frontend 测试
→ TypeScript 类型检查
→ Frontend 与 Nitro 生产构建
→ 构建产物服务测试
→ Nitro 开发链测试
```

CI 的职责、环境版本和 Submodule 边界见 [Chat CI](./ci.md)。

`pnpm verify`不包含NanoClaw自身测试或所有真实Docker/浏览器路径。Long Agent后续设计必须按[实施前约束与验证](./architecture/chat-long-agent-engineering-baseline.md)明确各入口的门禁，不能用父仓库通过代替子仓库与桥接验证。新增目标场景的测试计划不等于现有命令已覆盖。

## Agent入口的低成本验证

修改架构导航时，用没有前文的Agent读取入口和最多3–4份相关文档，只回答方案，不实施需求。题目至少覆盖新资源如何生效、跨模块合同变化、并发/失败恢复之一。核对它能否区分当前与目标、指出拥有者和实际入口、选择正确门禁、记录未验证项。错误回答先修概念或导航，再复测；不靠增加泛化禁令弥补。结构检查和问答不能证明生产Agent已装配Skill，也不能代替实现验收。审核证据放入`docs/architecture/reviews/`。
