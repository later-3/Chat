# Chat 项目跨 Session 续接入口

> 更新日期：2026-08-06

## 1. 当前停点

1. 产品定义和完整目标范围已固定。
2. 前端、后端、实时交互、Workflow和Agent Runtime技术选型已批准并写入合同。
3. P0工程与合同骨架已完成并合并；仓库已有Workspace、共享合同、Web/API空应用、测试、CI和依赖锁，但没有业务Schema、Product Store、Workflow或pi Adapter实现。
4. 当前分支为`codex/chat-workflow-foundation`。
5. P1现在表示“第一次可用的Chat闭环”阶段目标，已拆成8个独立任务；当前先审核P1.1响应式Chat与工作流界面任务书。

## 2. 新 Session 读取顺序

1. [AGENTS.md](../AGENTS.md)
2. [PROJECT_LESSONS.md](../PROJECT_LESSONS.md)
3. [Chat概念空间](./product/concept-space.md)
4. [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md)
5. [PROJECT_STATE.md](../PROJECT_STATE.md)
6. [PROJECT_PLAN.md](../PROJECT_PLAN.md)
7. [Chat项目飞轮](./product/flywheel.md)
8. [技术合同](./architecture/technology-contract.md)
9. [系统边界](./architecture/system-boundaries.md)
10. 本文件

## 3. 当前技术基线

```text
React + TypeScript + Vite + PWA
REST Query/Command + Chat SSE Event Feed
AG-UI compatible Agent events
Node.js + TypeScript + Hono
Vercel Workflow
pi-agent-core + pi-ai + pi-coding-agent
```

## 4. P1任务顺序

P1的用户目标是：安装并打开Chat，发送一条消息，看见后台处理进度，得到正式回复，并在页面刷新或短暂断线后恢复。

按顺序交付：

1. P1.1：响应式Chat与工作流界面；纯前端，同时建立对话区和工作流运行区，当前[任务书](./tasks/p1.1-responsive-chat-workflow-shell.md)待审核。
2. P1.2：可安装PWA与离线边界。
3. P1.3：消息由服务端保存并可读回。
4. P1.4：后台Workflow能独立跑通。
5. P1.5：网页显示后台状态。
6. P1.6：实时进度与断线续接。
7. P1.7：接入一次无工具的Agent回答。
8. P1.8：整条链验收与失败加固。

每个任务一个独立PR，只证明一个主要结果。存储保证在P1.3说明，Workflow测试方式在P1.4说明，本地与CI使用同一份pi代码以及可控模型测试在P1.7说明；这些技术项不再作为整个P1的前置阻塞。

## 5. 禁止事项

1. 新增实现必须从当前合同出发，不引入未获批准的兼容层、Schema或方案资产。
2. 不让浏览器直接连接Vercel Workflow或pi。
3. 不并行建立多套实时事件协议。
4. 不把Workflow Run、Checkpoint或pi Session当成Product Session/Product Run。
5. 不在P1顺手实现HITL、Memory、Workflow编辑器、外部Tool、语音、日历或Canvas。
6. 不读取、输出或提交私有配置、数据库和运行数据。
7. 不在早期任务提前安装后续依赖：P1.1～P1.2不安装Workflow/pi，P1.3不冻结未来数据库，P1.4不提前接pi。

## 6. 可复制续接指令

```text
继续Chat项目。按AGENTS.md顺序读取治理文件，再读取
docs/project-session-handoff.md、docs/architecture/technology-contract.md和
docs/architecture/system-boundaries.md。P0已经完成并合并。P1是第一次可用Chat闭环，
已拆成8个独立任务；当前先审核P1.1响应式Chat与工作流界面任务书。一次只做一个P1.x，
不要提前实现后续Workflow、pi、HITL、外部Tool、Memory或Workflow编辑器。
```
