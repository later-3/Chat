# Chat 项目计划

## 1. 实施原则

1. 先固定边界，再实现最小纵向链，再逐步增加节点类型和产品能力。
2. 每个阶段同时验证正常、重复、断线、进程退出和权限失败。
3. Product Store、Workflow Store、Runtime Journal和浏览器投影分别验收。
4. 每个阶段明确已经保证什么、仍不保证什么。

## 2. 交付路线

### P0 工程与合同骨架

目标：建立可运行的TypeScript Workspace和依赖方向。

- 创建`apps/web`、`apps/api`和核心`packages/*`。
- 配置pnpm Workspace、TypeScript strict、Lint、Format、Vitest和CI。
- 建立共享ID、Problem Detail、Command、Query和Chat Event类型。
- 建立架构依赖测试，禁止Adapter反向污染Domain。

完成门：空应用可启动、构建、测试；合同包能被Web/API共同使用。

### P1 第一条Chat纵向链

目标：从用户发送一条消息到pi回答并恢复正式消息。

- React提交Command。
- Hono校验并创建Product Session、Interaction、Message和Product Run。
- Vercel Workflow启动单次Run。
- Workflow调用pi Agent Node，不开放外部副作用Tool。
- Product Commit保存Assistant Message和Run终态。
- Runtime Journal通过SSE/AG-UI兼容事件投影进度。

完成门：刷新后从Product Store恢复历史；SSE断开不取消Run；重连不重复模型调用。

### P2 HITL纵向链

目标：Workflow能够安全等待并恢复一个人工决定。

- 建立Approval Request和Decision状态机。
- Workflow Hook Token只保存在后端映射。
- 前端渲染AG-UI Interrupt并通过Command提交决定。
- 校验Principal、revision、Hash、过期和幂等。
- 决定提交后恢复Hook。

完成门：重复决定只生效一次；旧页面和越权决定失败；进程退出后仍可恢复。

### P3 Checkpoint、Worker与事件恢复

目标：证明Durability而不是只保存消息。

- Product Run与Workflow Run映射。
- Chat Runtime Journal的sequence、cursor和保留策略。
- Worker接管与Attempt血缘。
- Checkpoint恢复、取消、Retry、Restart和Outcome Unknown。

完成门：活动流可接回；Checkpoint不重跑已确认副作用；未知结果不盲重试。

### P4 产品工作与上下文

目标：让对话持续推进Project和Work。

- Project、Work、Action、Plan和Context Package。
- Workflow Definition目录、选择和版本绑定。
- Context召回、采用、排除和预算。
- 模型候选、用户决定和产品提交分离。

完成门：跨Session继续同一Work；上下文变化使旧授权失效。

### P5 Tool、Artifact与Evidence

目标：安全执行真实动作并证明结果。

- Tool Catalog与Capability。
- Tool Execution Ledger、幂等、结果未知和对账。
- Artifact、Evidence、Validation和完成提交门。

完成门：模型自述不能完成Work；外部副作用不重复；结果可验证。

### P6 Workflow工厂与可视化

目标：用户能够查看、启停和组合Workflow节点。

- 稳定节点类型与端口合同。
- Sequence、Branch、Parallel、Loop和Agent Node。
- Workflow Definition版本、校验和发布。
- Run View投影真实路径、暂停、输入输出和证据。

完成门：定义变更不污染历史Run；图只是投影，不成为运行事实源。

### P7 PWA、文件、语音、日历与Canvas

目标：扩展完整用户交互面。

- PWA离线外壳、后台通知和跨设备恢复。
- 文件与对象存储、Markdown/HTML预览。
- 语音媒体通道与转写事件。
- 日历、提醒和周期Workflow。
- 持久Canvas Artifact与受控Agent修改。

### P8 Identity、外部入口与运营

目标：满足独立产品的安全、集成和运营责任。

- Principal、Role/Grant和Authentication Session。
- 外部Channel Adapter与Delivery回执。
- Super Admin Console、活动口径和访问审计。
- 备份、保留、SLO、告警和灾难恢复。

## 3. 当前工作包

当前只执行P0。P0完成并审核前，不提前建立业务Schema、Workflow编辑器、Memory或外部Tool。
