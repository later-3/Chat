# Chat Development Rules

## 项目定位

Chat是围绕Agent构建的本地系统，主执行链固定为：

```text
Frontend → Backend → Workflow → Agent装配 → Pi Agent / Pi Coding Agent
```

- Workflow组织一次执行需要的Node、Agent、Stage和资源，不是第二套Agent运行时。
- Agent能力由Model、Thinking Level、System Prompt、自定义Prompt、Skill、Tool、Extension、Plugin和Session上下文组成。
- 规则与经验是Agent自定义Prompt资源；Memory是独立持久化能力。不要把它们实现成与Agent平行的新执行系统。
- Pi SessionManager、ResourceLoader和AgentSession是底层事实源。Chat只增加产品配置、Project作用域、Workflow组织和前后端管理。

## Rule系统

- `AGENTS.md`只声明Chat的元规则和Rule机制；面向具体任务或Agent的可复用约束应保存为`rule` Prompt资源，事故结论保存为`experience` Prompt资源，不把完整规则重复复制进`AGENTS.md`或多个System Prompt。
- Rule定义“必须遵守什么”，Skill定义“这类任务如何完成”，Tool提供可执行动作，Memory提供历史事实；它们可以共同装配给Agent，但不能相互冒充或替代。
- 当前由用户或Workflow配置Agent所需Rule；Agent可以生成有来源、有理由、待用户确认的选择建议。未来开放自主选择时仍必须使用同一Prompt资源引用，并遵守Personal/Project作用域、资源状态、记录链和授权边界。
- Agent只接收本次任务实际选中的Rule和固定revision。每轮Workflow在执行前冻结选择，并记录`target`、`id`、`revision`、`selectedBy`和`reason`到Session；同一轮的检查页面与执行必须解析到相同内容。
- Rule通过`resolveWorkflowAgentDefinition()`进入Agent自定义Prompt，再由`createWorkflowAgentSession()`装配到Pi AgentSession；不得另建Rule运行时、在Workflow节点手工拼接，或要求Frontend维护第二份资源清单。
- 新增具体规则时，应进入Personal或Project Prompt资源库，具备明确purpose、适用范围、可执行内容和版本；是否设为某个Agent的默认能力必须单独评审，不能因为规则存在就全局注入。

## Project与数据边界

- 用户级事实位于`~/.chat`，测试和部署只能通过`CHAT_HOME`覆盖，业务代码不能用`process.cwd()`推断Chat Home。
- 每个Project在源码根目录使用`.chat/project.json`和`.chat/config.json`声明身份与配置；Session、Memory和Prompt资源按稳定`projectId`保存到`~/.chat/projects/<projectId>`。
- Agent上下文只能来自`~/.chat/agent`和用户明确打开的Project根目录中的Pi Context文件（`AGENTS.override.md`、`AGENTS.md`或`CLAUDE.md`变体）。父目录和子目录Context都不得自动继承。
- Project源码不移动到Chat仓库。不同Project的配置、Session、Memory和资源默认隔离，跨Project访问必须显式指定目标。
- 用户主动打开的Project直接提供自己的配置和资源；Agent的资源策略、路径授权和Project隔离决定实际加载范围。

## Pi集成规则

- 优先复用Pi公开接口和默认数据结构，不在Chat重复实现Session、Agent、Tool或ResourceLoader能力。
- 所有Workflow Agent通过`createWorkflowAgentSession()`统一装配；执行和检查页面必须走同一装配路径。
- Chat产品身份、Project、Workflow和前端状态留在Chat；可复用的Pi能力修改进入`pi/`源码和测试，不修改生成的`dist`文件。
- 修改`pi/`前完整阅读并遵守`pi/AGENTS.md`。
- Agent配置中的Tool名称必须对应实际注册的Pi Tool；新增Workflow或Agent不能要求前端维护另一份Tool清单。

## 前后端职责

- Frontend是浏览器客户端，只通过Backend API读取和修改服务端事实。
- 不在Frontend加入Node文件系统访问、Pi SDK运行时、Next.js后端或第二套Agent控制面。
- Workflow、Agent、Tool、Skill和Prompt资源由Backend统一解析并通过结构化接口提供；所有新增HTTP响应都要做运行时结构校验。
- Session、Workflow、Agent配置和资源选择不能只保存在React内存；刷新后必须从Backend和Pi Session恢复。

## 代码质量

- 先阅读相关架构文档和现有实现，再修改统一入口；不要为单个需求旁路现有框架。
- 保持模块职责单一、接口窄、数据流明确。不要用抽象掩盖简单逻辑，也不要把简单问题扩展成新的子系统。
- TypeScript保持严格类型，不使用`any`规避设计问题，不忽略输入校验、路径边界、并发和持久化错误。
- 运行数据写入必须具备原子性或明确的冲突保护；不能把Credential、Cookie、Token、模型密钥或正式数据提交到Git。
- 保留用户已有改动。不要使用`git reset --hard`、`git clean -fd`、`git checkout .`或其他会破坏工作区的命令。
- 不创建无规则归属的备份文件。数据迁移必须可恢复、可重试，并由明确的迁移标记管理。

## 验证

后端或前端代码修改完成后运行：

```bash
pnpm verify
git diff --check
git -C frontend diff --check
```

针对性测试应覆盖真实业务场景和边界，不能只断言实现细节。测试通过不代表架构正确，提交前还要核对文档、配置、Frontend契约和生产装配路径是否一致。

- 修改`src/workflows/**`、Workflow SDK、Builder Patch、Agent装配或Workflow可达资源时，必须分别检查Builder单层转换、Nitro开发Step bundle、生产构建和真实Runtime；不能用某个相邻链路通过代替用户实际启动链。除Node装载开发Step产物外，还必须运行`pnpm test:dev`，通过Frontend的Run合同验证Workflow、Agent节点、Pi SDK和本地假模型进入`completed`。
- 开发故障中可复用的结论应归档到`docs/development-experiences/`并形成`experience` Prompt资源；每个案例至少增加一条自动化回归门禁。

## Git与部署

- `frontend/`和`pi/`是固定Commit的Submodule；父仓库记录的Commit才是部署事实。
- 只暂存当前任务明确修改的文件，不使用`git add .`或`git add -A`。
- 未经用户明确要求，不提交、不推送、不部署。
- 用户要求部署时，先完成`pnpm verify`，再按`docs/deployment.md`使用现有单一Chat生产进程，部署后验证本机和公网健康。
