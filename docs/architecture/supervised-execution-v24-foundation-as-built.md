# 监督执行 v24 基础事实

> As-built：2026-08-26。本页只描述阶段1已经落盘的Contracts、Domain与Product Store基础，
> 不把尚未接线的Application、Workflow、Pi、API、Bridge、Trace或UI写成已完成能力。

## 1. 产品事实与版本

Product Store当前写入`chat-product-store.v24`。v24从真实v23只增加监督业务空集合；迁移不读取
Pi Journal、Workflow、Workspace、Provider或模型正文，不猜测历史Run属于哪个监督Epoch。
旧v20/v22/v23 Reader显式只读Prompt Assembly v1–v4，不能把新v5反向塞进旧literal。

监督合同使用独立v3代际，并在每个业务对象中携带完整的：

`Product Run → Planning Epoch → Execution Contract → Step → Step Revision/Round`

Step State按版本追加，不覆盖旧状态。每个后继状态引用前态ID、revision、stepRevision和Hash；
因此旧Attempt、Review、Decision和`outcome_unknown`证据不会因为“当前状态”更新而失去来源。

## 2. Agent治理链

每个Planning Epoch精确冻结Executor与Reviewer两个角色。每个角色必须同时绑定：

1. Principal拥有的不可变`agent-version.v2` ID与Hash；
2. Run级`prompt-assembly.v5`中的对应角色Assembly与Hash；
3. 完整有序的qualified Capability Snapshot及Manifest Hash；
4. Pi `full-operation.v3` Journal代际。

`prompt-assembly.v5`是新的Run级监督角色计划，不扩张v1–v4字段含义，也不是Provider Payload。
动态Step、Candidate与Evidence输入后续必须由阶段2的Input Manifest冻结。

## 3. Review与Evidence边界

Product Review拥有独立的Review Request、Human Decision ID、`decisionBoundary=product_review`和
动作集合，只解释Candidate、Reviewer Verdict与`outcome_unknown`。它不复用Tool Intent、Tool
Decision或Tool Result，Prompt批准也不会成为Tool授权。

Evidence只允许声明来自已验证的Pi `full-operation.v3` Tool Result，并绑定Attempt、qualified
Capability、toolCall、输入Hash、结果Hash和成功标准。阶段1不让Direct专属ToolExecution v1解释
监督Attempt；高影响Tool Evidence必须等待阶段2新增独立ToolExecution v2产品闭环。当前若出现
未来v2 Result引用或高影响Capability Evidence，Store失败关闭。模型自报“测试通过”没有入口。

## 4. Store不变量

- Epoch、Carry Forward、Step State Version、Evidence、Candidate、Verdict、Human Decision、
  Outcome Observation与Execution Result是追加式不可变事实；
- Agent Attempt只允许从`running`单调收敛到唯一`success/failure/outcome_unknown`；
- Product Review只允许从`open`一次性收敛为`decided/expired`；
- Store打开和每次事务提交统一验证Map key、Hash、Run/Epoch/Contract/Step、Version、Assembly、
  Capability、Round与主体引用；跨对象或跨Step拼接失败关闭；
- v23非空快照的所有旧实体、Receipt、Outbox、storeRevision与committedAt逐字等价保留，首次迁移后
  重复打开字节幂等；未知代际和v23同名新集合碰撞保留原文件并拒绝启动。

## 5. 当前明确未实现

阶段1没有监督Application Command、Workflow定义、Pi执行客户端、ToolExecution v2、API、Bridge
State、Trajectory/Trace投影或UI，也没有独立监督Journal/Service、裸Tool或模型Evidence旁路。
这些能力只能在后续阶段复用现有AgentVersion、Prompt Assembly、Pi full-operation.v3、Journal-first、
claim、`outcome_unknown`与Product Tool治理链接入，不能从donor直接搬运旧落盘格式。
