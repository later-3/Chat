# Later 的 AI Agent 学习资料

这个目录保存 Later 需要长期掌握、但不属于 Chat 产品本身的 AI Agent 知识、跨项目源码比较与真实实验材料。

## 与 Chat 项目的边界

放在这里：

- DSH、Pi、Hermes、Codex 等不同 Agent 的机制比较；
- 为理解 Agent 原理而做的真实 Provider、Session、Tool Loop 实验；
- 不直接规定 Chat 对象、状态机、API、Workflow、运行时或验收门的个人学习资料。

继续放在 `docs/`：

- Chat 产品概念、架构合同和所有权边界；
- 当前 as-built、安装、调试、部署与供应链证据；
- 会直接影响 Chat 设计、实现、迁移、测试或用户验收的方法取舍。

## 使用规则

1. 本目录不是实现授权，也不描述 Chat 当前已经完成什么。
2. 跨项目结论必须标注版本、提交或实验日期，不能把一次观测写成永久标准。
3. 学习资料可以被 Chat 架构文档引用为背景证据，但不能反向覆盖 Chat 的冻结合同。
4. Chat 运行代码、构建脚本和测试不得依赖本目录正文。
5. 内容如果开始直接约束 Chat 行为，应提炼成独立的 `docs/` 合同或 as-built，而不是让学习笔记兼任产品规范。

## 当前目录

- [DSH、Pi、Hermes、Codex 上下文区域剖析](./agent-context-management/context-regions.md)：只讨论提示词/上下文区域划分、协议位置和真实首轮例子。
- [Pi、DeepSeek Harness 与 Hermes 的真实上下文组装实验](./agent-context-management/real-request-experiments.md)：保存三套系统的真实三轮、Tool Loop与辅助请求实验事实。
