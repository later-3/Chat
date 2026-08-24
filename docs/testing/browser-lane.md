# 确定性 Browser lane

Browser lane只复用[`playwright.dsh-real.config.ts`](../../apps/dsh-web/playwright.dsh-real.config.ts)、
[`preflight-dsh-real.mjs`](../../scripts/e2e/preflight-dsh-real.mjs)和
[`run-dsh-mode.mjs`](../../scripts/e2e/run-dsh-mode.mjs)这一套Harness。没有第二份Playwright配置、
第二套端口监督或另一个前端。

## 当前覆盖

| 模式 | Chromium测试 | 主要证据 |
| --- | ---: | --- |
| PWA + Mobile | 7 | manifest/SW/离线边界、移动抽屉/FAB、桌面零影响 |
| Planning Faux | 1 | 真实DSH/API/Product Store/Workflow/Pi AgentSession与`full-operation.v3`，Plan审核、刷新恢复、批准与正式Assistant |
| Prompt Studio | 5 | 编辑、版本/来源、Agent最低只读配置表面 |
| Trajectory | 1 | 原生Trajectory、正式Assistant、刷新、双源Session记录 |
| Project Bootstrap | 1 | 真实Message/Run/Candidate、一次决定、关页执行、重开与下一轮普通消息 |
| Capability Governance | 3 | Tool Intent/Decision、一次handler、响应未知后重启恢复、拒绝零执行 |

根命令`pnpm test:browser`顺序运行上述18项。完整付费Planning和三层Provider Prompt Review仍在
`:paid` lane；Workbench只在`beta` lane。旧付费Planning spec已移除Workbench步骤，独立
Workbench spec继续复用同一配置的`workbench-only`模式。

## 进程与凭据边界

确定性模式从空环境构造显式allowlist，只保留Node/pnpm工具链；每轮使用`.data/e2e/`受管目录、
45xxx隔离端口、独立HOME/TMP、真实DSH Host/Client和适用的真实Chat Runtime。所有模式冻结：

- `CHAT_ALLOW_PAID_TESTS=0`、`CHAT_ALLOW_EXTERNAL_WRITES=0`；
- Memory与Workbench关闭；
- Provider、GitHub、Plane和SSH凭据不进入子进程；
- DSH Telemetry关闭，不继承宿主`process.env`作为子进程起点。

Capability与Planning Faux在真实子进程内落0600环境sentinel；合同测试还用注入假Key的反例验证
allowlist。Provider只使用进程内Faux，不发起真实网络模型调用；Project Bootstrap的Plane与
Workspace写仅发生在隔离fixture，并使用确定性Provider。

CI的browser Job必须先运行`pnpm managed-sources:prepare`，再安装固定Chromium并执行根Browser
lane。普通CI不运行paid、external或beta。
