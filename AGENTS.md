# Chat 项目协作规则

## 1. 产品身份

Chat 是独立开发、独立运行、独立运营并持续演进的完整产品。它以对话为入口，自己承担工作推进、耐久执行、人工审核、知识沉淀、证据、交付和治理责任。

不得把 Chat 缩小为聊天页面、Agent 外壳、Workflow Demo 或外部系统的适配器。

## 2. 当前阶段

前端、后端、Workflow 与 Agent Runtime 技术基线已经冻结。P0、P1.1、P1.2及B1调试/Trace基线均已合并；仓库已有TypeScript Workspace、响应式PWA、严格Trace与固定端口调试能力。

P1响应式PWA与B2真实规划—确认—执行纵向闭环已经完成并合入`main`。当前进入“长期上下文与知识复用”阶段：真实接入多个Memory项目、把BMAD项目推进方法转化为Chat拥有的Project上下文与文档维护能力、实现带标签的用户规则集并注入规划Workflow。实现前必须先复核本地参考项目和既有分析，形成可审核的小任务书；每个实现任务使用独立worktree、分支和PR，并以真实服务、真实模型和浏览器E2E证明用户结果。

当前事实以[PROJECT_STATE.md](./PROJECT_STATE.md)为准，技术边界以[技术合同](./docs/architecture/technology-contract.md)为准。

## 3. 每次项目回复前的读取顺序

1. `AGENTS.md`
2. `PROJECT_LESSONS.md`
3. `docs/product/concept-space.md`
4. `PROJECT_CONTEXT.md`
5. `PROJECT_STATE.md`
6. `PROJECT_PLAN.md`
7. `docs/product/flywheel.md`
8. `docs/product/design-guidelines.md`
9. 与任务直接相关的 `docs/`

新 Session 或用户说“继续 Chat 项目”时，再读取`docs/project-session-handoff.md`。

## 4. 已冻结架构规则

1. 前端使用 React + TypeScript + Vite，目标形态为响应式 PWA。
2. 后端使用 Node.js + TypeScript；Hono只负责HTTP、认证上下文、校验和流式传输，不拥有产品事务。
3. Vercel Workflow负责耐久步骤、暂停、恢复、重放和运行时Checkpoint。
4. `pi-agent-core`作为Workflow中的Agent节点；它不拥有产品会话、产品运行、审批、记忆或完成事实。
5. 产品资源通过REST Query/Command访问；写命令必须携带幂等身份和预期revision。
6. 活动运行通过一条Chat拥有的SSE事件流投影；Agent事件使用AG-UI兼容类型，不再建立第二套竞争的Agent事件协议。
7. Product Store拥有权威产品事实；Workflow Store、pi Session、事件Journal和浏览器缓存分别只拥有自己的运行责任。
8. 浏览器不得直接调用Workflow或pi，不得把Workflow Run ID、Hook Token或pi Session ID作为授权或产品身份。
9. HITL决定先经过Chat权限、版本、Hash和幂等校验并提交产品事实，再由后端恢复Workflow Hook。
10. 外部副作用必须有幂等、结果未知、查询对账和人工处置语义；不得把普通异常重试用于未知副作用。

## 5. 模块与依赖

目标代码按以下责任拆分：

```text
apps/web           React交互与服务端状态投影
apps/api           Hono协议入口与组合根
packages/contracts 网络合同与事件类型
packages/domain    产品对象、状态机与不变量
packages/application 用例协调与事务边界
packages/product-store-json 当前JSON Product Store Adapter与迁移
packages/memory-runtime Memory Port的memmy与Tencent MemoryCore Adapter
packages/realtime  当前Trace与Replay；未来Runtime Journal与SSE投影
packages/workflows Vercel Workflow定义与活动
packages/pi-runtime pi适配与Agent节点
packages/testing   合同、Fixture与测试工具
```

依赖方向必须指向内部：Adapter依赖Application，Application依赖Domain/Port；Domain不能依赖Hono、React、Vercel Workflow、AG-UI或pi。

## 6. 产品不变量

1. 模型输出只是候选，不自动成为长期事实。
2. 高影响动作执行前必须经过可读、可修订、版本绑定的决定。
3. 前端只显示和提交动作，不拥有权威历史、审批或运行终态。
4. 完整历史是证据，不是每轮默认模型上下文。
5. 失败不能产生假成功、半提交或无记录自动重试。
6. Trace只保存可观察事件和证据，不保存模型隐藏推理。
7. Product Session、Product Run、Run Attempt、Workflow Run、Workflow Checkpoint、pi Runtime Session和Realtime Connection不能合并。

## 7. 工程规则

1. TypeScript开启`strict`，网络边界和外部结果必须运行时校验。
2. Router、React页面和Workflow Step不直接写产品数据库；Application Coordinator拥有用例事务。
3. 不建立万能Service、Repository-per-table、Service-per-method或无真实替换价值的接口。
4. 日志放在命令入口、状态转换、外部调用、暂停/恢复、对账和失败边界；不得记录密钥、完整Provider Payload或隐藏推理。
5. 修改行为同时更新合同测试、状态机测试和端到端场景。
6. 新依赖必须说明用途、所有权边界、退出方式和许可证。
7. 密钥、数据库、运行事件、构建产物和本地配置不得进入Git。
8. 关键跨层路径、数据结构、身份转换、事务/幂等和结果未知边界必须有解释“是什么、为什么、怎样失败”的中文注释；行为变化同步更新对应as-built交互与调试文档，不能只留在任务书或聊天里。

详细标准见[工程规范](./docs/engineering-standards.md)。

## 8. 源码证据

涉及pi能力时，优先读取固定本地源码`/Users/xulater/Code/opc-os/pi`及其`AGENTS.md`、类型、测试和示例。涉及Vercel Workflow、AG-UI、Hono、React和Vite时使用匹配版本官方文档或源码，不凭模型记忆猜API。

参考项目只为真实覆盖范围背书，不决定Chat的产品对象和事实所有权。

## 9. 变更与安全

1. 保留用户已有改动；不重置、不覆盖、不删除任务范围外的数据。
2. 删除、迁移、推送、部署和外部副作用必须在用户授权范围内执行。
3. 私有配置只检查存在性和合同，不读取到回复、文档、日志或Git。
4. 默认中文沟通，先给结论，再给证据和下一步。
