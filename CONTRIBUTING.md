# Contributing to Chat

先读[0–15分钟接手入口](./docs/getting-started/quick-context.md)和仓库根`AGENTS.md`。Chat按独立worktree与
`codex/`分支交付；保留已有改动，不直接在主checkout叠加实现。push、PR、部署、真实Provider、付费模型
和外部写都需要当前用户明确授权。

## 最小变更闭环

1. 写清用户结果、不做事项、事实Owner与完成门；历史计划不授予实现权限。
2. 非核心能力先给出直接使用、Hosted/Sidecar、窄Adapter、拒绝或Chat自研的证据结论。
3. 行为变化同步更新合同测试、中文导航注释和唯一as-built事实源。
4. 新测试必须在[`config/test-lanes.json`](./config/test-lanes.json)中有且只有一个主要lane。
5. 公共路由、Schema或历史持久格式变化必须同步更新其Owner包的合同/迁移测试；CI运行这些真实测试，
   不维护另一套内部调用图或手抄接口事实。
6. 跨模块长期决定才使用[ADR](./docs/decisions/README.md)，普通小改动不写ADR。

## 提交前检查

- `pnpm build && pnpm lint && pnpm format:check && pnpm typecheck && pnpm test`
- 与风险相称的lane；跨层确定性变化最终仍由根`pnpm test`覆盖
- UI产品变化运行`pnpm test:browser`；Workbench单独在beta门
- 依赖变化运行标准`pnpm audit --prod`；Fork固定点变化还要运行`pnpm managed-sources:verify`和接缝测试
- `git diff --check`并确认没有密钥、运行数据、构建产物或本地配置

付费入口必须同时满足`:paid`命令名、`CHAT_ALLOW_PAID_TESTS=1`和精确Provider凭据；外部服务使用各自
显式开关。普通CI和普通本地验证不设置这些开关。
