# Tool能力与执行

## 文档治理信息

| 项目 | 内容 |
|---|---|
| 目的 | 区分真实Tool能力、模型可见定义、模型提议、用户批准、实际副作用和执行结果。 |
| 概念状态 | 有效。 |
| 实现状态 | 局部实现并验证：pi Agent Tool具有Provider Gate、Tool Gate、参数编辑和执行统计；通用Catalog、Ledger、结果未知对账尚未完成。 |
| 事实所有者 | 产品规则见[项目上下文原则11](../../PROJECT_CONTEXT.md#8-产品原则)，实现见[pi Agent Tool手册](../../docs/pi-agent-tool.md)。 |
| 维护责任 | Tool Catalog、Policy、Approval、Execution Gateway、Ledger和Reconciler共同维护。 |

## 一句话理解

**Tool Definition只是向模型声明真实能力的合同；模型返回Tool Call只是提议；只有经过权限、参数、风险和审批后，Tool Execution才可以产生副作用。**

## 为什么需要

允许用户或AI自由填写Tool名称，相当于向模型承诺系统拥有一个可能不存在的能力。模型提议调用也不代表当前用户有权执行；如果不建立执行账本和结果未知语义，超时或进程崩溃会造成重复副作用。

## 定义与边界

| 概念 | 定义 | 不是什么 |
|---|---|---|
| Tool Catalog / 工具目录 | 服务端已注册、可定位执行器或Provider原生能力的目录 | 不是前端自由文本列表 |
| Tool Capability / 工具能力 | Tool能做什么、在哪些范围运行、风险和副作用属性 | 不是某个用户当前拥有的权限 |
| Tool Definition / 模型可见定义 | 从Catalog投影给模型的名称、说明和输入Schema | 不是执行授权，也不能与执行器合同漂移 |
| Tool Policy / 工具策略 | Principal、范围、风险和运行条件的授权规则 | 不是模型Instructions |
| Tool Call Proposal / 工具调用提议 | 模型根据Definition生成的结构化名称和参数 | 不是已批准或已执行事实 |
| Tool Approval / 工具批准 | 对具体Tool、参数版本、Hash、范围和风险的决定 | 不是对该Tool未来调用的永久授权 |
| Tool Execution / 工具执行 | 一次具体调用的长期产品事实和副作用账本 | 不是Tool Call Proposal，也不是Product Run本身 |
| Idempotency Key / 幂等键 | 外部系统用于识别同一次操作的稳定键 | 不能保证所有外部系统Exactly-once |
| Tool Result / 工具结果 | 执行器返回的规范内容、错误或结果未知状态 | 不是Evidence本身；需要来源和校验 |
| External Receipt / 外部回执 | 外部系统返回的操作ID、版本或送达证明 | 不是仅凭HTTP 200推断的成功 |
| Reconciliation / 对账 | 对结果未知执行查询外部状态并决定恢复、补偿或人工处理 | 不是盲目重试 |

## 概念关系

```text
Tool Catalog + Capability + Policy
-> 当前Run可见的Tool Definition
-> 模型产生Tool Call Proposal
-> 参数/权限/风险校验
-> Tool Approval
-> Tool Execution + Idempotency Key
-> External Receipt / Tool Result / Outcome Unknown
-> Reconciliation
-> Evidence
-> 如需再问模型，生成新的ModelCallDraft
```

## 人和系统怎样使用

1. 审批页只能从服务端Catalog选择Tool身份，不能自由创建`new_tool`或改名。
2. 允许用户修改参数，但保存时必须重新验证Schema、权限、工作目录和风险，并生成新Hash。
3. MAF FunctionTool或Middleware必须把真实执行转交Chat Tool Gateway，不能绕过产品Ledger。
4. Tool发送前失败可安全不执行；发送后断线可能Outcome Unknown，先对账再决定重试。
5. Tool Result进入模型时只是下一份上下文内容，会触发新的模型调用审批。

## 正例与反例

正例：pi提出读取`README.md`，用户把参数改为`PROJECT_STATE.md`，服务端验证仍在允许根目录后记录新版本并执行。

反例：前端允许手填`delete_database`，虽然没有执行器，仍把Definition发给模型。

反例：模型返回Tool Call后，MAF自动执行Python函数，跳过用户批准和Ledger。

反例：Tool请求超时后立即重做，因为系统把“没有响应”解释为“没有发生”。

## 当前状态与未知

pi Tool纵向切片已验证7个真实内置Tool选择、参数改写、Provider/Tool两道审批和Token/耗时/调用统计。通用Tool Catalog/Policy、跨进程Execution Ledger、外部副作用幂等、结果未知查询、补偿和人工处置仍未完成。

## 来源、维护与验证

来源：[项目经验反例011](../../PROJECT_LESSONS.md#14-反例-011允许声明系统无法执行的tool)、[pi Agent Tool手册](../../docs/pi-agent-tool.md)和[项目计划阶段6](../../PROJECT_PLAN.md#11-阶段-6toolworkflow-与-hitl-恢复)。

验证覆盖不存在Tool被拒、名称/Schema绑定、参数越权、重复批准、请求前失败、请求后断线、幂等重放、外部回执、对账和Tool Result触发下一次模型审批。
