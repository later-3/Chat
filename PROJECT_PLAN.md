# Chat 项目计划

## 1. 实施原则

1. 先固定边界，再实现最小纵向链，再逐步增加节点类型和产品能力。
2. 每个阶段同时验证正常、重复、断线、进程退出和权限失败。
3. Product Store、Workflow Store、Runtime Journal和浏览器投影分别验收。
4. 每个阶段明确已经保证什么、仍不保证什么。

## 2. 交付路线

### P0 工程与合同骨架

目标：建立可运行的TypeScript Workspace和依赖方向。

状态：已完成并通过PR #1合并，合并提交`f1274c769bf97dca8834a5d42ff57d1883f01b02`。

- 创建`apps/web`、`apps/api`和核心`packages/*`。
- 配置pnpm Workspace、TypeScript strict、Lint、Format、Vitest和CI。
- 建立共享ID、Problem Detail、Command、Query和Chat Event类型。
- 建立架构依赖测试，禁止Adapter反向污染Domain。

完成门：空应用可启动、构建、测试；合同包能被Web/API共同使用。

### P1 第一条Chat纵向链

目标：从用户发送一条消息到pi回答并恢复正式消息。

入口决定，全部关闭后才能进入实现：

1. pi工件：选择从冻结提交`10e99ae`生成可验证工件，或走合同变更更新冻结提交；只比较`0.82.1`版本号不成立。
2. Product Store证明级别：决定P1使用可替换的内存Reference Adapter，还是同时冻结具体数据库与迁移工具；必须明确是否保证服务进程重启恢复。
3. 测试运行合同：CI使用真实Workflow与真实pi Adapter、确定性Fake Model计数；私有Provider凭据只用于明确的补充Smoke，不进入仓库或默认CI。

实现范围：

1. Contracts：建立Send Message Command、Session/Message/Run Query、SSE Cursor和对应Problem Detail合同。
2. Domain/Application：建立最小Product Session、Interaction、Message、Product Run及Send Message Coordinator；写命令支持`commandId`幂等和`expectedRevision`。
3. Product Store：通过Port保存权威产品事实、Run映射和提交所需引用；具体Adapter遵守入口决定，不让Router或Workflow Step拥有事务。
4. Workflow/pi：一个Product Run只启动一个Workflow Run；Workflow调用一个无Tool能力的pi Agent Node，pi私有身份不出后端。
5. Product Commit：pi结果只是候选；校验后由Application提交Assistant Message和Product Run终态。
6. Realtime：Runtime Journal分配有序sequence/cursor，Hono只暴露一条SSE Feed并把pi事件归一为已采用的AG-UI事件。
7. Web：React提交Command、投影活动事件，并通过Query恢复正式Message和Run；浏览器缓存不推断成功。

完成门：

1. 同一`commandId`重复提交只创建一个Product Run、一个Workflow Run映射和一次pi/Model调用。
2. 浏览器刷新后正式历史来自Product Store Query，不来自TanStack Query、AG-UI Reducer或本地缓存。
3. SSE断开不取消Run；Cursor重连按序重放，不重复Workflow或pi/Model调用。
4. `RUN_FINISHED`和pi成功只结束Agent运行段；Product Run只在Product Commit通过后显示成功。
5. 公开响应和事件不泄漏Workflow Run ID、Hook Token、Checkpoint ID或pi Runtime Session ID。
6. 校验、Workflow、pi或Product Commit失败都不产生假Assistant Message或假成功。
7. 合同、状态机、幂等、真实Workflow/pi Adapter、SSE恢复和Playwright场景在CI通过。

P1不保证：服务进程退出后的持久恢复（除非入口决定选择真实持久Store）、HITL、外部副作用Tool、Worker接管、Checkpoint恢复、完整Workflow编辑器、Memory和业务项目管理。

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

P0已完成。当前只制定并执行P1第一条Chat纵向链。

P1入口决定关闭前，只允许做证据核验、合同细化和无偏向的Spike；不安装Workflow/pi运行时依赖，不创建会反向冻结未决Store或pi工件方案的业务Schema。P1完成并审核前，不提前实现HITL、外部Tool、Workflow编辑器、Memory、语音、日历或Canvas。
