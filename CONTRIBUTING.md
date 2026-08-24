# Contributing to Chat

先读[0–15分钟接手入口](./docs/getting-started/quick-context.md)和仓库根`AGENTS.md`。Chat按独立worktree与
`codex/`分支交付；保留已有改动，不直接在主checkout叠加实现。push、PR、部署、真实Provider、付费模型
和外部写都需要当前用户明确授权。

## 最小变更闭环

1. 写清用户结果、不做事项、事实Owner与完成门；历史计划不授予实现权限。
2. 非核心能力先给出直接使用、Hosted/Sidecar、窄Adapter、拒绝或Chat自研的证据结论。
3. 行为变化同步更新合同测试、中文导航注释和唯一as-built事实源。
4. 新测试必须在[`config/test-lanes.json`](./config/test-lanes.json)中有且只有一个主要lane。
5. 公共路由、Schema或export变化先运行`pnpm api-surface:diff`；`api-surface:check`还会对Git base baseline
   复核，不能用同分支更新baseline绕过breaking change；按[兼容政策](./docs/architecture/compatibility-policy.md)
   取得用户批准。
6. 跨模块长期决定才使用[ADR](./docs/decisions/README.md)，普通小改动不写ADR。

## 提交前检查

- `pnpm verify:core`
- 与风险相称的lane；跨层确定性变化运行`pnpm test:all:deterministic`
- UI产品变化运行`pnpm test:browser`；Workbench单独在beta门
- `pnpm build && pnpm lint && pnpm format:check && pnpm typecheck`
- 依赖、Fork或CI变化运行`pnpm supply-chain:check`和只读audit
- `git diff --check`并确认没有密钥、运行数据、构建产物或本地配置

付费入口必须同时满足`:paid`命令名、`CHAT_ALLOW_PAID_TESTS=1`和精确Provider凭据；外部服务使用各自
显式开关。普通CI和普通本地验证不设置这些开关。
