# S7.2 容量与性能证据（工作树基线）

> 测量日期：2026-08-10。状态：自动容量门4/4通过。本文只记录脱敏尺寸和时延，不包含用户正文、Provider payload、Credential或Hook token。

## 1. 参考环境与方法

参考机为 macOS 15.5（Darwin 24.5.0）、Apple M4 Pro、24 GiB、arm64、Node.js 24.8.0。工作树 HEAD 为 `895060ecc7c8de4ed6f00d819d3b654a76162134`，测试时源码为 dirty，因此数字只用于本机回归预算，不冒充可复现的发布工件证据。

自动门位于 `packages/testing/src/s7-capacity-quality-gate.test.ts`：

- 最大 Kernel Definition 编译 30 次；记录 p50/p95。
- 同一脱敏 Store 文件打开 20 次；事务追加 40 个 Session；Run View 与 Node Detail 各查询 30 次。
- View/Detail 响应按 UTF-8 JSON 字节计数；Store 按落盘 UTF-8 字节计数。
- 这是本地文件系统 warm-cache 参考值，不是网络、浏览器渲染或冷启动 SLO。

## 2. 本次测量

| 路径 | p50 | p95 | 门槛 |
| --- | ---: | ---: | ---: |
| 64 节点 Kernel compile | 0.879 ms | 1.764 ms | p95 < 250 ms |
| Store open | 1.594 ms | 1.993 ms | p95 < 1,000 ms |
| Store transact | 11.969 ms | 13.318 ms | p95 < 500 ms |
| Run View query | 0.273 ms | 0.467 ms | p95 < 100 ms |
| Node Detail query | 0.283 ms | 0.452 ms | p95 < 100 ms |

| 脱敏产物 | 字节 | 门槛 |
| --- | ---: | ---: |
| Store（Note终态Fixture + 40 Session） | 72,387 | 尚未批准生产告警阈值 |
| Run View | 2,319 | < 262,144 |
| Node Detail | 2,901 | < 131,072 |

## 3. 已执行的最终合同与 limit+1

| 参数 | 有效上限 | 自动反证 |
| --- | ---: | --- |
| Definition request | 131,072 bytes | 既有 Kernel 合同门 |
| Definition node / depth / branch | 64 / 12 / 24 | 64 编译成功、65 为 `definition.max_nodes_exceeded`；其余由 Kernel 边界测试 |
| loop / nested loop / iteration | 8 / 2 / 5 | Kernel 正反例 |
| 总 Node execution / Composite children / waits | 256 / 32 / 16 | Kernel/Runner 合同门 |
| Manifest slots | 30 | 30 成功、31 strict parse 失败；Contracts、Domain 和 Manifest Schema 共用同一常量 |
| Run View nodes / Node timeline | 500 / 500 | 500 strict parse 成功、501 失败 |
| Note Markdown | 100,000 chars | limit 成功、limit+1 失败 |
| Plan steps | 8 | limit 成功、limit+1 失败 |
| Artifact inline content | 200,000 chars | limit 成功、limit+1 失败 |
| Preview budget | 16,384 bytes | Kernel 常量已声明，但当前 DTO 没有统一的 Preview 截断/资源链接语义 |

系统 Planning Blueprint 当前只有 9 个受控节点；64 是 Kernel 的跨 Blueprint 结构预算。测试用独立、受 Catalog 约束的容量 Blueprint 证明 64/65，未放宽产品 Planning 可选节点“每类最多一次”的语义。

## 4. Checkpoint 与秘密扫描

Planning 与 Note 已收敛为单 Step 内 `load → model → persist`，Workflow 外层只保留产品引用。Vercel Hook token 是 Workflow Store 自有的耐久身份，允许存在于 Workflow 私有 checkpoint；门禁要求它不得进入 Product Store、Trace、公开 API、HTML 或浏览器缓存。

本次源码门确认Planning、Note、Execution外层Workflow均不含已知正文跨Step字段；正文由单一Step执行`load → model → persist`，外层只得到产品ref/outcome/identity。自动门同时扫描workflow bundle中的硬编码`sk-*`/`Bearer *`，本次未命中。该扫描是代表性防回归，不替代凭据轮换、产物清单或Workflow Store自身的访问控制。

## 5. 尚未收敛的容量边界

1. JSON Store 的建议对象数、文件字节告警点、备份建议和冷启动峰值内存尚未由必要规模样本批准；73 KB 探针不能外推为生产容量声明。
2. Preview 的服务端截断、cursor/完整资源链接语义尚未接入统一 DTO，不能把 16 KiB 常量当成已完成产品行为。
3. LR 布局、Composite 折叠、浏览器 render p50/p95 与 375/390 px 极限画布属于 S7.4/S6 浏览器证据，本文件不以 Node Query 代替。
4. Trace 保留期与产品 Timeline 的长期保留策略仍需发布文档确认；产品 Decision/Revision/Node 事实不得随 Trace 清理。

因此当前容量结论是“4/4自动门通过，核心limit、脱敏本机性能和durable-scope代表扫描有证据；4类生产预算仍未批准”，不是发布批准。
