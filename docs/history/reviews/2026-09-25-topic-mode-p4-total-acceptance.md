# 主题模式 P4 总验收记录

日期：2026-09-25。范围：P2＋P3 收口后的**总验收**（执行中恢复、真实模型完整故事、浏览器 fork）。
前置：[P2/P3 阶段收口](2026-09-24-topic-mode-real-model-verification.md)、[P2 任务书](../../development/topic-mode-p2-taskbook.md)、[开发计划](../../development/topic-mode-plan.md) §4。

## 1. 结论

**整体达标**：原清单的功能主链、数据一致性、授权与真实浏览器用户链均有对应证据；本轮发现并修复 1 处主链一致性问题（见 §3）。无越权、无数据损坏、无第二执行路径。

## 2. 证据（区分自动化 / 真实模型 / 浏览器）

| 原需求 | 自动化 | 真实模型 | 浏览器 |
|---|---|---|---|
| T1 每轮 work→remember | `test/workflows/session-memory-workflow.test.mjs` | `verify-p4` S2 节点轮 `roundMemory` | 节点对话结构化渲染 |
| T2 remember 只投影当前轮 | `test/workflows/session-memory-round-context.test.mjs` | — | — |
| T3 节点创建幂等＋来源 | `test/long-agents/topic-node-creation.test.mjs`、`topic-integration.test.mjs` | `verify-p4` S1（`read_fulltext`/`read_memory`→`create_topic`/`create_node`，根节点初始记忆带来源） | 初始来源只读展示 |
| T4 分叉/多亲/防环 | `test/long-agents/topic-api.test.mjs`、`topic-node-creation.test.mjs` | `verify-p4` S2（真实锚点 fork 出父边） | **fork 步骤**：选父锚点→提交→服务端新节点+父边+锚点→进入子节点续聊 |
| T5 relay＋生命周期 | `test/tools/topic-manage.test.mjs`、`test/long-agents/topic-lifecycle*.mjs` | `verify-p4` S3（R4 relay 真实轮次 completed、1 条原生消息、1 个新锚点）、S5（**有 settled 锚点**的节点归档后 relay 拒绝，且无新增节点/边） | relay 徽章＋已受理/已完成 |
| T6 权限（含绕行） | `test/long-agents/scope.test.mjs`、`topic-api.test.mjs`、`test/tools/tools.test.mjs` | `verify-p4` S5（归档 integration 拒绝） | — |
| T7 记忆开关 | `test/workflows/session-memory-workflow.test.mjs`、`topic-integration.test.mjs` | — | 开关读写服务端 `sessionMemory` |
| T8 后端端到端 | `test/long-agents/topic-integration.test.mjs`、`scripts/dev-server.test.mjs` | `verify-daily`（自然语言 `request_topic`）、`verify.mjs`、`verify-p4` S1–S3 | — |
| T9 随附业务 workflow | `test/workflows/problem-diagnosis.test.mjs` | `verify-p4-workflow`（**真实 dev server**＋真实模型：`workflow_call` 成功、子 run `completed`、子会话属冻结项目 `collab`、有诊断 assistant 文本） | — |
| T10 节点派发子 Workflow | `scripts/dev-server.test.mjs`（`DIRECT_CALL_DIAGNOSIS`，真实 Workflow runtime 子 run） | `verify-p4-workflow`（真实模型在真实服务入口发起并完成） | — |
| T11 relay 执行与重放边界 | `topic-integration.test.mjs`、`topic-manage.test.mjs` | `verify-p4` S3 | relay 徽章＋刷新恢复 |
| T12 R4＋跨进程 | `topic-integration.test.mjs`、`topic-restart.test.mjs` | `verify-p4` S3 | 补充整合表单（memory/relay） |
| **执行中恢复（本轮补齐）** | `test/long-agents/topic-interruption-recovery.test.mjs`（work 中断、remember 写前/写后中断、relay 中断） | — | — |
| P3 用户链 | `frontend/lib/topics-browser.test.mjs`、`lib/*.test.mjs` | — | `scripts/topics-browser.test.mjs`（进节点/结构化执行/记忆 CAS/开关/R4 memory+relay/fork/建题/刷新恢复） |
| 多主题跨树只读＋归档 | `topic-manage.test.mjs`（read 跨树）、`topic-lifecycle` | `verify-p4` S4（**真实节点轮次中的模型**调用 `read_memory`+`read_fulltext`，目标为第二主题节点会话，结果含来源地址）、S5（有锚点后归档并拒绝） | — |

真实模型证据文件：`.data/verification/topic-mode/evidence.json`、`evidence-daily.json`、`evidence-p4.json`（S1–S5）、`evidence-p4-workflow.json`（S6，真实 dev server 内）。

## 3. 本轮发现并修复的主链问题

**事故一（评审复现）**：节点轮次正常完成时会在同一分支上**同时保留** `running` 与 `completed` 两个 `chat.topic-round` 标记。原先的恢复检查用 `some(status !== "completed")` 遍历全部历史标记，因此旧的 `running` 永远命中——「整轮完成标记已落盘、队列完成状态尚未落盘」的窗口会被误判为中断（turn=`interrupted`，锚点仍为 1），造成用户看到中断却仍可分叉的矛盾。

**修复**（`src/long-agents/daily-maintenance.ts`）：按 `roundId` 归并并**取最新有效标记**（分支顺序，后写覆盖先写）；只有该轮的最新标记不是 `completed` 才判为未完成。已有 `completed` 时收敛队列为 `completed`；未完成时才标 `interrupted` 且不自动重放。非主题轮次行为不变。

**事故二（同一处，早期版本）**：工作段结束会先写 `chat.long_agent_turn=completed`；进程若随后死在 `remember` 段，恢复曾只看该 turn marker 就把轮次判完成。修复后该判断在「未完成 round」之后，因此这类轮次判 `interrupted`。

**验证**：`topic-interruption-recovery.test.mjs`（5 条）：
- work 中断、remember 写前中断、remember 写后中断、relay 中断：被杀时 turn `running`/锚点 0；恢复后 `interrupted`/锚点 0；记忆不因恢复增加；relay intent 与原生消息各恰好 1；后续新轮次恰好 +1 锚点、+1 记忆；
- **完成窗口回归**：真实跑完一轮（round=`[running, completed]`、锚点 1、记忆 N），只在队列侧还原「未落盘」（turn 回到 `running`，冻结输入补回）后恢复 → turn **`completed`**、锚点仍 **1**、消息与记忆**均不增加**、round 标记不新增。

## 4. 门禁

- `pnpm verify` exit=0：**56 / 632 / 188 / 30 / 9**（后端 632＝含执行中恢复 5 条；`test:dev` 含浏览器链）。
- `pnpm check:architecture` exit=0。
- 父仓库与 `frontend` 的 `git diff --check` 干净。
- 真实模型脚本为手动证据，不入 `pnpm verify`（依赖本机 `~/.chat/agent`，只读 symlink，不读取/打印凭据）。

## 5. 证据脚本的自检约定

`verify-p4.mjs` 的每个场景都有业务断言（`assert`），任一断言失败或 setup 异常都会把 `process.exitCode` 置为 1；不再以「函数没抛异常」作为成功。`verify-p4-workflow.mjs` 同理，并只在真实 dev server（已初始化 Workflow runtime）里运行，断言 `workflow_call` 成功、子 run `completed`、子会话属冻结项目、子会话有诊断文本。

## 6. 如实标注的未覆盖项

- 子 workflow 的**诊断产物质量**未做人工评审（本轮只验收「真实模型在真实服务入口发起并完成子 run」）。
- 前端节点对话仍是「节点控制器＋共享 `MessageView`」，非完整 `ChatWindow`（架构替代方案，接受条件＝结构化消息不丢失，已满足）。
- 执行中恢复证明的是「不提前 settled、不重复业务产物、状态一致」，恢复语义仍是**不自动重放**（原始历史保留，需用户重新发起），这是既有设计，非本轮新增。
