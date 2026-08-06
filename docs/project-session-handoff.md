# Chat 项目跨 Session 续接入口

> 更新日期：2026-08-06

## 1. 当前停点

1. 产品定义和完整目标范围已固定。
2. 前端、后端、实时交互、Workflow和Agent Runtime技术选型已批准并写入合同。
3. P0工程与合同骨架已完成并合并；仓库已有Workspace、共享合同、Web/API空应用、测试、CI和依赖锁，但没有业务Schema、Product Store、Workflow或pi Adapter实现。
4. 当前分支为`codex/chat-workflow-foundation`。
5. 唯一下一工作包是P1第一条Chat纵向链；3个入口决定尚未关闭。

## 2. 新 Session 读取顺序

1. [AGENTS.md](../AGENTS.md)
2. [PROJECT_LESSONS.md](../PROJECT_LESSONS.md)
3. [PROJECT_CONTEXT.md](../PROJECT_CONTEXT.md)
4. [PROJECT_STATE.md](../PROJECT_STATE.md)
5. [PROJECT_PLAN.md](../PROJECT_PLAN.md)
6. [技术合同](./architecture/technology-contract.md)
7. [系统边界](./architecture/system-boundaries.md)
8. 本文件

## 3. 当前技术基线

```text
React + TypeScript + Vite + PWA
REST Query/Command + Chat SSE Event Feed
AG-UI compatible Agent events
Node.js + TypeScript + Hono
Vercel Workflow
pi-agent-core + pi-ai + pi-coding-agent
```

## 4. 唯一下一工作包

P1必须先关闭：

1. 冻结pi源码`10e99ae`的可验证工件方案。
2. P1 Product Store使用内存Reference Adapter还是冻结真实数据库，以及对应保证范围。
3. 真实Workflow/pi Adapter与确定性Fake Model的CI合同，及私有Provider Smoke边界。

入口决定关闭后，P1交付Send Message Command、最小产品对象与Coordinator、一个Workflow/pi节点、Product Commit、Runtime Journal/SSE和React恢复链。完成门是重复命令不重复调用、刷新从Product Store恢复、SSE重连不重复调用、私有Runtime ID不泄漏、失败不产生假消息或假成功。

## 5. 禁止事项

1. 新增实现必须从当前合同出发，不引入未获批准的兼容层、Schema或方案资产。
2. 不让浏览器直接连接Vercel Workflow或pi。
3. 不并行建立多套实时事件协议。
4. 不把Workflow Run、Checkpoint或pi Session当成Product Session/Product Run。
5. 不在P1顺手实现HITL、Memory、Workflow编辑器、外部Tool、语音、日历或Canvas。
6. 不读取、输出或提交私有配置、数据库和运行数据。
7. P1入口决定关闭前，不安装Workflow/pi运行时依赖，不创建会冻结未决方案的业务Schema。

## 6. 可复制续接指令

```text
继续Chat项目。按AGENTS.md顺序读取治理文件，再读取
docs/project-session-handoff.md、docs/architecture/technology-contract.md和
docs/architecture/system-boundaries.md。P0已经完成并合并，唯一下一工作包是P1第一条Chat纵向链。
先关闭pi工件、Product Store证明级别和测试运行合同3个入口决定；不要提前实现HITL、外部Tool、Memory或Workflow编辑器。
```
