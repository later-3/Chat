# 架构债务与决定记录

> 状态：**混合**。2026-07-29由代码级架构评审形成；2026-07-30用户批准AD1-AD6中已形成方案的
> 设计方向及AD8/AD9对应的D2/D3，AD7仍维持当前单进程承诺。已批准项只关闭对应设计缺口；实现状态
> 仍以`PROJECT_STATE.md`为准。
> 证据来源：`docs/overall-architecture-proposal.md`、`docs/chat-system-implementation-roadmap.md`、
> 当前源码（`backend/app/`、`frontend/src/`）、`PROJECT_STATE.md`。
> 本文只登记债务与候选决定；稳定产品定义仍归`PROJECT_CONTEXT.md`，当前实现事实仍归`PROJECT_STATE.md`。

## 1. 决定索引

| 编号 | 决定 | 性质 | 当前建议 | 状态 |
|---|---|---|---|---|
| AD1 | Interaction协调器形态：承认"协调器即39节点Workflow"并定义拆分触发条件 | 架构形态 | 显式承认当前形态，写下拆分触发条件，暂不重构 | 已决策 |
| AD2 | 周期工作（Schedule）在目标架构中没有状态所有者 | 架构缺口 | 独立MOD-SCHEDULE；详细设计另行审核 | 已决策（D1） |
| AD3 | Identity实现顺序过晚，公网已在无真实Principal下运行 | 落地排序 | 提前到SD4-D之前或与SD4-D并行 | 已决策（W2-01） |
| AD4 | 6套并行编号/路线体系，没有唯一"下一步" | 计划治理 | W0-W10唯一顶层坐标，其余只做映射 | 已决策（D4） |
| AD5 | 大文件复杂度临界区 | 工程债务 | Q02按事务和状态所有权持续收敛 | 已决策、实施中 |
| AD6 | MAF私有API接合与AG-UI RC版本耦合 | 技术债务 | 私有接合已集中并由安装版升级门约束；升级时优先移除 | 已关闭（W1-01） |
| AD7 | 单进程假设（进程内Store、同进程pi重挂接） | 技术债务 | 维持单进程产品承诺直到F05，不提前泛化 | 待审核（维持现状） |
| AD8 | Web、Obsidian与第三方前端缺少稳定投影/写回合同 | 架构缺口 | 建立APP-PROJECTION与Adapter边界，权威事实仍归领域模块 | 已决策（D2） |
| AD9 | Collaboration大模块与已落地Harness责任切分不一致 | 架构缺口 | 在逻辑架构中显式拆为Work、Knowledge、Protocol与Governance | 已决策（D3） |

---

## AD1：Interaction协调器形态

### 决策原因

已批准总体架构§8.2定义Interaction协调器是**应用层协调者**：不拥有独立领域事实、一次
Interaction可触发0..n个Run、步骤可幂等恢复。当前实现把接纳、Context、意图、规划、草稿、
执行、响应、摘要、提交全部放进**1个39节点MAF Workflow**（`continuous_chat.py`，3,096行，
v1.8.0）。即"协调器即Workflow"。这是架构文档与代码之间最大的形态偏差，至今未被任何文档
显式承认和定性。

### 现有参考源是否涉及

- MAF：Workflow Checkpoint/HITL Interrupt是其原生能力，但MAF不规定"协调器应该住在图内还是图外"。
- pi/nanobot/QwenPaw/LibreChat：4个参考项目的回合协调都在通用Runner/Agent Loop之外
  （pi AgentSession、nanobot AgentLoop、QwenPaw Workspace、LibreChat Route+Job），
  即参考结构支持"协调器在图外"。当前形态没有参考项目先例，属于本项目在MAF能力下的推导。

### 全部可行选择

| 选择 | 优点 | 缺点 |
|---|---|---|
| A. 维持"协调器即Workflow"，显式承认并写下拆分触发条件 | HITL/Checkpoint/节点Trace免费获得；已验证39节点、跨进程审批恢复；不推翻已批准切片 | 图签名升级使在途Run失败关闭（一周v1.4→v1.8，每次升级在途Run不可恢复）；跨Run澄清已需特殊机制；协调逻辑持续向图内堆积（3,096行）；多Run Interaction、周期任务将继续加节点 |
| B. 拆成"应用层协调器 + 多个小Workflow"（理解图、执行图、沉淀图） | 符合目标架构§7.6；图更小、版本更稳；多Run Interaction自然 | 需要自建跨图HITL串联、跨图Trace关联和跨图恢复；MAF Interrupt/Checkpoint要在图外重新接一次；推翻已验证的纵向切片，返工大 |
| C. 混合：回合内单Workflow不变，把"跨回合/跨Run"步骤（澄清带回、回合沉淀、周期触发）移到图外应用层 | 不动已验证主链；把最不适合图内的部分先拿出来；为B积累接口 | 需要明确定义"图内/图外"的分工线，否则形成第二套协调语义 |

### 批准结果（2026-07-30）

先选A+C的组合：**现在显式承认当前形态（A），同时把AD1的拆分触发条件写下来**：
当以下任一条件成立时启动C方向设计审核——(1) 一次Interaction需要多个独立Product Run
（多Intent分支执行落地）；(2) 周期任务/Schedule接入；(3) 主Workflow超过约50节点或
单文件协调逻辑继续膨胀。不建议现在直接做B：已验证的HITL/Checkpoint合同是项目最有价值的
资产之一，返工风险大于收益。

### 信心与未验证项

信心：中高（基于代码现状和版本升级事实）。未验证：MAF图外串联多个Workflow的Interrupt/
Checkpoint合同成本没有Spike过；50节点的阈值是经验估计，不是测量结论。

---

## AD2：周期工作（Schedule）没有状态所有者

### 决策原因

产品能力7（`PROJECT_CONTEXT.md`§9）确认"处理周期资讯、提醒和交付失败，不依赖Agent自己
记得下次运行"。在2026-07-24批准的11模块历史基线中，没有任何模块拥有Schedule定义、下次触发
时间、错过补跑策略；§4的Scheduler/Reconciler是Run恢复角色，不是业务调度。roadmap阶段D
提到"实现Schedule、周期Run"，但目标架构里这个已确认用户场景没有明确落点。

### 现有参考源是否涉及

- MAF：不涉及业务调度。
- pi/nanobot：nanobot有cron式提醒能力的简单形态（需回查agent_knowledge确认范围）；其余未涉及。
- LibreChat：未涉及。本决定主要本项目需求推导。

### 全部可行选择

| 选择 | 优点 | 缺点 |
|---|---|---|
| A. Schedule作为Collaboration的子能力（绑定WorkItem/TaskPlan） | 周期工作天然是"工作的下一行动"；复用Work状态机和提交门 | Collaboration模块职责继续扩大 |
| B. 独立第12个模块（Schedule/Reminder） | 状态所有权清晰；错过补跑、时区、暂停都是独立生命周期 | 新增模块的合同、投影、恢复都要设计 |
| C. 作为Delivery的触发侧扩展 | 周期资讯最终是Delivery问题 | 触发计划与送达是两个变化原因，合并会混淆 |

### 当前建议

用户批准B（独立模块），完整选择、取舍和影响见
[能力架构地图D1](./product-capability-architecture-map.md#6-d1schedule归属)。
目标架构缺口已关闭；Schema、Worker、Trigger/Misfire字段和时区策略仍须W4-04详细设计。

### 信心与未验证项

信心：中。未验证：周期触发的Worker拓扑、与Lease/Reconciler的关系、跨时区语义都未设计。

---

## AD3：Identity实现顺序

### 决策原因

Identity在历史11模块与当前14个状态所有者中都是安全前置责任，但落地方案把它排在阶段7/阶段E（最后一批）。当前事实：
公网HTTP+Basic Auth手机访问已在真实使用；固定`local-user` Scope；Super Admin、Delivery、
Channel Binding全部依赖真实Principal。继续使用越久，存量数据迁移和边界修正成本越高。

### 现有参考源是否涉及

- LibreChat有真实用户/认证模型可参考；其余参考项目对完整Identity链涉及有限。已在
  `overall-architecture-research.md`登记。

### 全部可行选择

| 选择 | 优点 | 缺点 |
|---|---|---|
| A. 提前Identity（最小Principal/Auth Session/Scope），先于SD4-D | 堵住公网无身份运行的产品风险；解锁F07/F09/W10；迁移成本低（数据量还小） | 打断当前SD4-D/E节奏 |
| B. 维持现状顺序，HTTPS+Basic Auth继续过渡 | 不打断SD4-D | 公网无正式身份的时间拉长；后续所有权限语义要回头改 |
| C. 只做传输层HTTPS，身份仍推迟 | 缓解窃听风险 | 不解决Principal/授权/审计问题 |

### 批准结果（2026-07-30）

选A：把"最小Identity纵向切片"（真实Principal、Authentication Session、单Scope、
现有固定用户迁移）排在SD4-D之前或与其并行；HTTPS与Identity同属一个部署工作包。
字段、Cookie/CSRF边界、迁移阶段和验证门已在
[W2-01详细设计](./identity-https-auth-session-scope-migration-detailed-design.md)固定；正式实现仍缺。

### 信心与未验证项

信心：中高。未验证：最小切片的字段范围、与现有`scope_id=local-user`数据的迁移方案未设计。

---

## AD4：编号/路线体系统一

### 决策原因

当前并存6套坐标：项目阶段0-8（PROJECT_PLAN）、实现阶段A-F（roadmap）、Session Phase 0-8、
Chat开发Chat SD0-SD6/SDx-A~E、Q0（Q01-Q07）、F01-F10。"当前最重要的下一件事"没有唯一答案，
需要人在Q02/SD4-D/F02/F07之间自行裁决。反例047已认识到数字漂移并给Workflow学习阶段建了
机器口径，但计划层面没有对应收敛。

### 全部可行选择

| 选择 | 优点 | 缺点 |
|---|---|---|
| A. 1个主依赖序 + 专项只做映射 | 任何时刻唯一"下一步"；专项路线不删除 | 需要一次性的映射整理 |
| B. 维持多套，靠PROJECT_PLAN §16推荐序 | 不改动现有文档 | 推荐序不是机器校验的，继续漂移 |
| C. 全部合并成一张表 | 最简 | 丢失Session/SD/Q0各自的验收粒度 |

### 当前建议

用户批准A：W0-W10作为唯一顶层交付坐标，`Wn-xx`作为可执行工作包；Session/SD/Q0/F专项路线只保存
能力和验收映射，不再分别决定全局先后。完整候选见
[能力架构地图D4](./product-capability-architecture-map.md#9-d4唯一主开发依赖序)。
机器清单检查工作包依赖、环和主序完整性；W0-02与W1-01已完成，当前下一工作包为W2-01。

### 信心与未验证项

信心：高（纯治理改动）。未验证：无。

---

## AD5：大文件复杂度临界区

### 决策原因

实测：`continuous_chat.py` 3,096行、`governance/service.py` 2,840行、
`harness/service.py` 1,987行、`model_call_review.py` 1,749行、
`execution_dispatch/service.py` 1,581行、`product_sessions/service.py` 1,548行，
均超800行审查线。每轮新能力（SD4-D/E、多Intent分支执行）默认堆进这些文件，
回归成本非线性上升。`App.tsx` 806行已触发一次未通过的审查门。

### 批准结果（2026-07-30）

Q02在SD4-D之前完成一轮收敛，优先级：`governance/service.py`（治理查询/命令/事务分离）→
`harness/service.py`（命令协调/查询/状态机已部分拆出，继续）→ `continuous_chat.py`
（按S阶段或职责拆Executor模块，图连接保持factory唯一）。拆分必须遵守无行为重构门
（指纹、架构测试、合同测试、生产构建），不改变Schema/节点ID/审批Hash。

### 信心与未验证项

信心：高。未验证：`continuous_chat.py`的拆分线与MAF Checkpoint图签名的相互影响需先固定指纹。

---

## AD6：MAF私有API与AG-UI RC耦合

### 决策原因

历史实现曾在8个Executor中重复导入/继承私有`RequestInfoMixin`，并散落Checkpoint编码、类型判断和
Runner恢复调用；AG-UI RC8仍不转发`checkpoint_id`。W1-01已经移除可替代接合，把不可替代部分收敛
到单一Runtime Adapter，并用安装版合同测试把“升级即爆点”变成显式失败门。

### 当前建议

1. 把私有接合点集中到一个适配模块并标注版本合同；2. 建立MAF/AG-UI升级门：每次升级先跑
   版本锁定测试（Checkpoint/HITL/恢复桥），优先移除私有接合；3. 跟踪AG-UI正式版是否转发
   `checkpoint_id`，一旦支持即迁移。

### 实施结果（2026-07-31）

采用上述方向；完整合同、错误/ID链和升级门见
[W1-01详细设计](./module-public-contract-error-id-upgrade-detailed-design.md)。生产代码中的私有MAF导入现在
只允许位于`backend/app/runtime_adapters/maf_compat.py`；架构测试禁止再次扩散，启动/CI锁定
`agent-framework-core 1.11.0`、`agent-framework-ag-ui 1.0.0rc8`和`agent-framework-openai 1.10.1`，
并覆盖Checkpoint往返、类型白名单、pending request、恢复桥和版本漂移失败关闭。AD6关闭；未来版本
升级仍要先跑同一门，并在AG-UI公开转发`checkpoint_id`后删除恢复桥。

### 信心与未验证项

信心：高。持续观察项：正式版AG-UI的checkpoint转发行为未知，但该未知不再是未受控私有依赖。

---

## AD7：单进程假设

### 决策原因

`InMemoryModelCallReviewStore`（旧Workflow）、pi同进程Checkpoint重挂接、进程内Gateway
注册表都假设单后端进程。F05（跨进程恢复）未做。

### 当前建议

**维持现状**：单进程是当前部署事实，文档已诚实标注。不建议提前泛化——跨进程执行所有权
路由是多实例问题，当前本地优先部署没有该需求。F05设计时再统一解决，现在要做的是
**防止新代码继续默认单进程而不自知**：新的持久化点默认走Product Store，不新增进程内
权威状态。

### 信心与未验证项

信心：高。未验证：F05的跨进程Gateway路由和副作用对账未设计。

---

## AD8：多呈现方式缺少稳定投影与写回合同

### 决策原因

用户需要在Web看板、Obsidian目录/Markdown和潜在第三方前端中查看同一Project、Work、Note、
Schedule、Evidence和进度事实。当前Web直接组合多组REST投影，Obsidian只有本地学习资料目录，尚无
产品Read Model、增量游标、版本标识、权限过滤、编辑Diff/CAS或冲突恢复合同。若让每个前端直接理解
内部表，模块演进会同时破坏所有呈现方式；若让Markdown成为第二事实源，又会产生双写和静默覆盖。

### 当前建议

用户批准[能力架构地图D2](./product-capability-architecture-map.md#7-d2多前端投影与obsidian合同)：
`APP-PROJECTION`负责稳定Read Model和受治理命令入口，Web/Obsidian/第三方只做Adapter；领域事实仍由
各状态所有者拥有。外部编辑必须携带revision并经过权限、Diff、CAS、必要HITL、Validation和Evidence。

### 信心与未验证项

信心：中高。未验证：Obsidian首批支持只读导出还是双向编辑、Markdown Frontmatter最小字段、增量同步
协议和离线冲突体验；这些都属于D2获批后的详细设计，不在本轮实现。

---

## AD9：Collaboration与Harness责任切分不一致

### 决策原因

2026-07-24批准的历史总体架构把Project/Work/Plan、Intent/Approval和协作协议大量归入一个Collaboration模块；当前
Product Harness实现已经出现不同状态机、事务与变化原因：Work推进、Note知识修订、Protocol定义与绑定、
Intent/ExecutionDraft/Approval治理并不共享同一个生命周期。继续以一个大模块描述，会让后续开发者无法
判断Repository、Application Coordinator、失效传播和测试边界应该放在哪里。

### 批准结果（2026-07-30）

用户批准[能力架构地图D3](./product-capability-architecture-map.md#8-d3product-harnessworkknowledgeprotocol与governance边界)：
目标逻辑状态所有者显式区分`MOD-WORK`、`MOD-KNOWLEDGE`、`MOD-PROTOCOL`和`MOD-GOVERNANCE`。
这不要求立即移动现有目录或拆事务；先批准逻辑所有权，再由各工作包详细设计决定物理迁移顺序。

### 信心与未验证项

信心：中高。未验证：Note与Memory之间的跨模块失效事务、Protocol Binding与Work作用域的原子边界，
以及现有Harness服务的最小无行为拆分路径。
