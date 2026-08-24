# @chat/dsh-web

## 拥有

固定DSH Web分发检查、受管Profile/Host启动入口及唯一Playwright配置。

## 不拥有

不拥有Chat产品事实、业务状态机或第二套前端；不得把Chat业务写进DSH Fork。

## 入口与边界

- executable：根`scripts/dsh/`经本包`dev/start`启动；测试入口在[`e2e/`](./e2e/)。
- 唯一业务集成来自`@chat/dsh-lifeos-bridge`；DSH Session与Product Session保持分离。
- 真实Host/Client可用于确定性Browser lane；Workbench属于Beta，Memory不启动。
- planning与prompt three gates会调用真实Provider，只能由`:paid`受管根命令运行。
- 维护规则见[DSH前端维护](../../docs/architecture/dsh-frontend-maintenance.md)。

## 命令

- `pnpm --filter @chat/dsh-web build`
- `pnpm --filter @chat/dsh-web typecheck`
- `pnpm --filter @chat/dsh-web test`
- `pnpm --filter @chat/dsh-web dev`会启动本地Host；付费测试脚本不得由普通CI调用。
