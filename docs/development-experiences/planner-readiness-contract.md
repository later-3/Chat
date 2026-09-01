# Planner 未区分任务澄清与可执行计划

## 现象与影响

2026-09-01，用户使用规划执行Workflow购买咖啡豆。Planner生成的审核计划把“确认口味、冲煮方式、预算和购买量”列为Executor的第一步，同时又允许用户点击“通过并执行”。

如果批准，Executor必须在“猜测用户偏好”和“向用户补问”之间二选一。补问只会产生一条Assistant回复，当前Workflow Run随后结束；用户下一轮回答会启动新的Run，无法恢复原Executor Stage。计划审核因此没有证明计划已经具备执行条件。

## 直接根因

1. Planner System Prompt只要求输出Markdown计划，没有完整任务理解清单，也没有区分可调查事实、非阻塞假设和用户专属阻塞决策。
2. Planner输出只有非空文本，没有`needs_clarification | ready_for_review`机器契约。
3. Review Task对所有计划都展示批准按钮，Backend只校验版本和摘要，不校验执行就绪状态。
4. Executor交接只有用户原话和Planner文本，没有批准版本、授权边界、调查职责和完成报告契约。

## 为什么原验证没有发现

原测试只验证Planner“不是执行Agent”、计划能够等待审核、修改后版本递增、批准后Executor收到最终文本。没有覆盖信息不足的真实场景，也没有断言不完整计划无法批准。

## 正确实现与验证姿势

1. Planner先恢复任务背景、目标、交付物、范围、约束、依赖、授权边界和验收标准。
2. 能由Executor使用工具获得的信息写成调查步骤；非阻塞信息使用显式保守假设；只有用户能决定且会改变主方案的信息进入阻塞问题。
3. `needs_clarification`在同一个耐久Review Task中收集用户原文并回到同一Planner配置；前端隐藏批准动作，Backend拒绝伪造的批准请求。
4. `ready_for_review`不得把开始执行前的需求收集下放给Executor。任务若需要后续人工决策，应明确本轮交付物和停止点。
5. Executor接收版本化任务书，包含用户真实请求、批准计划版本、批准正文、调查规则、授权边界和完成报告要求。

## 自动化门禁

- Planner Prompt测试覆盖任务理解字段、就绪判定、审核模板和禁止下放澄清要求。
- Planner输出解析测试拒绝缺失元数据及就绪状态与阻塞问题不一致的结果。
- Review合同测试断言`needs_clarification`不能批准，但可以提交补充信息。
- Frontend合同测试校验阻塞问题结构；审核卡只在`ready_for_review`展示批准按钮。
- `pnpm test:dev`通过真实Frontend Run合同先产生澄清版本，断言HTTP批准失败，再提交信息生成可执行版本并完成Executor回合。
