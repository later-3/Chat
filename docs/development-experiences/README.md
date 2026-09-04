# 开发经验案例

这里归档已经发生、可复用且会影响后续工程决策的开发问题。案例不是第二套规则系统；需要长期影响 Agent 的结论会同时归档为 `experience` Prompt 资源，继续通过现有规则与经验库发现、选择和装配。

每个案例必须包含：

1. 现象与影响。
2. 已验证的直接根因。
3. 为什么现有验证没有发现。
4. 正确实现与验证姿势。
5. 至少一条自动化回归门禁。

当前案例：

- [Workflow 开发 Step 产物外置 Agent JSON](./workflow-builder-json-import-attribute.md)
- [Workflow Step复用与Registry依赖必须保持运行时边界](./workflow-step-runtime-boundary.md)
- [本地运行时升级掩盖部署 Node.js 语法不兼容](./deployment-runtime-version-parity.md)
- [Planner 未区分任务澄清与可执行计划](./planner-readiness-contract.md)
