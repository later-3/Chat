# 2026-09-17 上游维护审核

## 范围与结论

本轮选择会影响现有使用路径的兼容修复；不整体合并上游重构，也不引入 Workflow 5 beta。维护版本为 Chat 0.3.1、Pi 0.85.1、Frontend 0.5.1、NanoClaw 2.4.1。子仓库提交到各自个人分支，父仓库固定其确定 Commit；此更新不包含 npm 发布或运行环境部署。

| 组件 | 起点与采用项 | 来源 |
| --- | --- | --- |
| Workflow | 4.8.5 → 4.8.9；builders 4.1.10 → 4.1.14，nitro 4.1.11 → 4.1.15；保留现有 Builder 补丁 | [官方发布](https://github.com/vercel/workflow/releases/tag/workflow%404.8.9) |
| Pi | 基于个人分支 109eb78fa；停止压缩/分支摘要、60 秒重试上限、直接排队输入经过扩展处理、显式缓存模型使用正确长缓存字段 | [abort](https://github.com/earendil-works/pi/commit/bea67d90d)、[retry](https://github.com/earendil-works/pi/commit/c37b0e03b)、[input](https://github.com/earendil-works/pi/commit/faa9863cb)、[cache 子集](https://github.com/earendil-works/pi/commit/17de82d7b) |
| Pi Web / Frontend | 基于个人快照 193869f；保护切换项目、历史会话和自动恢复时的文字/图片草稿，并覆盖连续新建会话 | [draft](https://github.com/agegr/pi-web/commit/77ffe3c) |
| NanoClaw | 基于个人分支 5108502；迁移加锁后重查版本、投递与 reconcile 有界并发 8、固定节拍、单会话失败隔离 | [migration](https://github.com/nanocoai/nanoclaw/commit/1d5179b2)、[concurrency](https://github.com/nanocoai/nanoclaw/commit/f4598c01) |

Workflow 仍然是包依赖，升级 package.json、锁文件和版本对应补丁即可，不维护其源码 Fork。此次升级包含取消流、构建和序列化依赖修复；补丁对应的 JSON 导入和开发 Step 装载门禁继续保留。

Pi 的 0.85.1 是个人分支维护版本，并非完整合并官方 0.85.1；工作区包版本、内部依赖和安装锁同步更新，生成模型目录保持不变。只移植兼容修复，缓存测试通过显式 compat 参数验证，不依赖尚未引入的新模型。NanoClaw 补齐了一个已有测试的日志 mock，避免无 `.env` 的干净工作区中错误失败。

## 场景、机制与边界

依据 [贡献流程](../../development/agent-contribution.md)、[模块合同](../chat-module-contracts.md)、[Workflow](../chat-workflow-framework.md) 和各 Submodule 规则审核：

- 取消、输入扩展和重试属于 Pi AgentSession/SDK；修改 Pi 原实现及测试，不在 Chat 新建运行时。公共装配入口保持不变。
- 新会话草稿属于 Frontend 页面状态；按 cwd 暂存并恢复文字/图片，不复制服务端 Session、不声称整页刷新后持久化。测试执行真实导航回调和卸载清理。
- 迁移版本重查与 DDL 同属一次写事务；并发启动只执行一次迁移。投递跨 Session 并行，每个 Session 的队列顺序和防重入继续由原合同保障。
- NanoClaw 的 `chat-pi` 实例保护仍在：不开启原生 Agent/Session Runtime、不探测或恢复 Docker；已有无 Docker 回归测试继续执行。
- Workflow 只组织执行，Backend 仍通过公共装配调用 Pi。Builder 保留 import attribute、本地 JSON 打包与 source map，并分别验证开发和生产真实执行链。

未采用：Pi 新 Harness/存储重构、Pi Web 的旧 SSE 恢复代码（Chat 已使用 Workflow Run 事件）、非必要 UI/键盘增强、NanoClaw 原生容器能力和 Workflow 5 beta。这些不是本轮兼容维护的前置依赖。

## 验证

在独立工作树安装和构建，避免覆盖当前开发服务的 node_modules、Pi dist 与 Nitro 产物。源码和锁文件随后回填原工作区；运行中的安装及构建产物未切换。

- Pi：`npm run check`、`npm run build:offline`；6 个针对性测试文件共 126 项通过，另 4 项既有条件测试跳过。
- NanoClaw：`pnpm build`；`pnpm exec vitest run --maxWorkers=2 --testTimeout=30000`，215 文件、2379 项通过。首次默认并发运行有脚本超时，限定并发后全量通过，未修改默认测试门槛。
- Frontend：草稿测试覆盖正常目录与不同 worktree 自动恢复；包含于父仓库前端测试与构建。
- Chat：完整 `pnpm verify` 通过：工具链 23、后端 285、前端 129、生产 Runtime 28、开发 Runtime 1，共 466 项；类型检查、前后端构建均通过。Builder 单层转换、Nitro 开发 Step JSON 内联及 Node 装载、生产和开发真实 Workflow → Pi → 本地假模型均通过。
- 根仓库及 3 个 Submodule 均执行 `git diff --check`。
- NanoClaw 额外全量 lint 有 11 个既有错误、189 个警告，错误所在 5 个文件与 HEAD 逐字一致；本轮 11 个 TypeScript 变更文件的定向 lint 为 0 错误、12 个警告。全量 lint 不能报告为通过，遗留问题不混入本轮上游维护。

## 提交与版本固定

- Pi `0.85.1`：`0343d486d8d8c4622384fa18e93c7f1398cbd749`，`later-3/pi` 的 `codex/later-custom`。
- Frontend `0.5.1`：`78e9553821afd43bc6f7eff4c4630b98a8034286`，`later-3/chat-frontend` 的 `main`。
- NanoClaw `2.4.1`：`b86d3b7795eb677e83eb222e604ba5003208874f`，`later-3/nanoclaw` 的 `chat`。
- Chat `0.3.1` 固定以上三个 Submodule Commit，Workflow 包固定为 `4.8.9`。
- 版本变更后重新通过 Pi check/offline build、NanoClaw 2379 项测试和 Chat 完整 verify。运行环境的安装、重启和部署另行执行。
