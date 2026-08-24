# Architecture Decision Records

ADR只记录跨模块、长期且难以从局部代码还原的工程或架构决定。普通修复、测试补充、文档澄清和单包
内部重构不写ADR。需要在落地前讨论多种方案、影响冻结合同或需要用户批准的变更，先写RFC/`proposed`
ADR；决定后改为`accepted`。被后续决定替代时改为`superseded`并链接新记录，不删除历史。

| 编号 | 决定 | 状态 | 记录 |
| --- | --- | --- | --- |
| 0001 | Managed Fork与三仓版本锁 | accepted | [ADR-0001](./0001-managed-forks-version-lock.md) |
| 0002 | 测试lane与付费/外部写隔离 | accepted | [ADR-0002](./0002-test-lanes-and-side-effect-isolation.md) |
| 0003 | API Surface与统一兼容政策 | accepted | [ADR-0003](./0003-api-surface-and-compatibility.md) |

新记录复制[模板](./template.md)，使用`NNNN-kebab-case.md`；状态只能是`proposed`、`accepted`或
`superseded`。编号一经使用不复用。
