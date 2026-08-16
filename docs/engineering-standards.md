# Chat 工程规范

## 1. Workspace

目标目录：

```text
apps/dsh-web
apps/api
packages/dsh-lifeos-bridge
packages/contracts
packages/domain
packages/application
packages/product-store-json
packages/memory-runtime
packages/realtime
packages/workflows
packages/pi-runtime
packages/testing
```

根目录只放Workspace配置、治理入口和跨包工具。Feature代码不得直接堆到根入口。

## 2. 依赖方向

```text
DSH Bridge/Hono/Vercel/pi Adapters
            ↓
       Application
            ↓
       Domain + Ports
```

- Domain不依赖React、Hono、数据库、Vercel Workflow、AG-UI或pi。
- Application不依赖具体Router和页面。
- Workflow调用Application Port或Activity Adapter，不直接改产品表。
- DSH Client只依赖浏览器安全合同；Bridge Host只调用公开Chat API，不导入Application或Store实现。

通过架构测试固定依赖方向。

## 3. TypeScript

1. 开启`strict`、`noUncheckedIndexedAccess`和`exactOptionalPropertyTypes`。
2. 禁止在网络、存储和外部SDK边界使用未经校验的类型断言。
3. Zod Schema拥有运行时合同，TypeScript类型从Schema推导或通过测试保持一致。
4. `unknown`优于`any`；必须先缩窄再使用。
5. 公共状态机、Command、Event和Port使用JSDoc解释不变量与失败语义。

## 4. 事务与状态

1. Application Coordinator是一个用例的唯一产品事务所有者。
2. Repository不自行提交事务。
3. 外部网络调用不放进数据库事务。
4. 本地事实与Outbox同事务提交。
5. 写命令必须支持`commandId`幂等和`expectedRevision`并发控制。
6. 所有终态转换必须有状态机测试和非法转换测试。

## 5. Workflow与副作用

1. Workflow Step输入输出必须可序列化、版本化和校验。
2. Step不接收数据库连接、HTTP Context或浏览器对象。
3. 外部副作用必须有稳定幂等Key和明确的未知结果语义。
4. Hook Token、Workflow Run ID和Checkpoint ID只存在于Runtime Adapter。
5. Workflow Definition变更发布新版本；历史Run继续引用原版本语义。

## 6. 实时事件

以下条款约束目标Runtime Journal/SSE实现。当前仓库的`packages/realtime`只拥有严格Trace和Replay，DSH Bridge仍使用受控Query轮询；在SSE纵向任务完成前不得把本节当作已交付事实。

1. Runtime Journal是公开事件顺序的唯一Owner。
2. 每个Product Run的sequence严格递增。
3. 重放相同eventId必须内容一致。
4. 前端发现缺口或冲突时停止应用Delta并重新Hydrate。
5. Product资源完整内容通过Query读取；事件只携带运行投影或失效提示。

## 7. 错误与日志

- HTTP使用稳定Problem Detail错误族。
- 日志包含`requestId`、`productRunId`、`attemptId`及适用的Workflow/Tool关联引用。
- 日志记录命令入口、状态转换、外部调用、暂停/恢复、接管、对账和失败边界。
- 不记录密钥、Cookie、完整Prompt、完整Provider Payload、用户无关正文或隐藏推理。
- 用户错误与内部诊断分开；浏览器只获得可执行恢复信息。

## 8. 测试门

每个纵向能力按风险覆盖：

1. Domain状态机与纯规则单元测试。
2. Command/Query/Event Schema合同测试。
3. Product Store事务、CAS、幂等和并发测试。
4. Workflow重放、Hook和Checkpoint测试。
5. pi Adapter真实事件归一化测试。
6. SSE断线、Cursor重放、缺口和重复测试。
7. DSH Host/Client插件的加载、错误、窄屏、键盘和可访问性测试。
8. Playwright端到端正常与恢复场景。

Mock只能证明调用合同；真实Workflow、真实pi和真实浏览器证据不能被Mock代替。

## 9. 规模审查

以下只触发责任审查，不机械拆文件：

- TypeScript模块超过800行。
- Client插件组件或Hook超过500行。
- 函数超过80行。

拆分必须依据状态所有权、事务边界、失败恢复和变化原因。禁止万能`utils`、Repository-per-table和Service-per-method。

## 10. 依赖与升级

新增依赖必须记录：

- 解决的问题。
- 所在Adapter或核心边界。
- 为什么标准库或现有依赖不足。
- 许可证与维护状态。
- 退出或替换方式。

升级DeepSeek Harness、code-server、Vercel Workflow或pi之前，必须先运行对应插件、代理、事件、Hook、Checkpoint、Tool和恢复合同测试。

## 11. 中文注释与当前实现文档

1. 跨前端、HTTP、Application、Store、Outbox、Workflow、Provider或外部服务的关键边界必须有中文JSDoc或块注释，说明“进入什么、离开什么、谁拥有事实、失败怎样恢复”。
2. 注释优先解释原因和不变量：身份为什么不能混用、为什么需要CAS/Hash/Outbox、为什么不能自动重试；不为显而易见的赋值和语法逐行翻译。
3. 关键数据结构要说明字段角色，尤其是`commandId`、各种revision/Hash、产品ID、Attempt、Outbox与Runtime私有ID；同名或相近对象必须明确“是什么/不是什么”。
4. 新增或改变纵向交互时，同步更新最接近行为的as-built文档。前后端数据流更新`docs/architecture/frontend-backend-interaction.md`，Workflow节点更新`runtime-workflows.md`，启动、断点或排障更新`docs/debug/local-debug.md`。
5. 调试文档以“文件 + 函数/路由 + 观察变量”为稳定入口；行号只能作为临时提示，不能作为唯一定位方式。
6. 当前实现、目标架构和历史任务书必须分开。注释与调试指南只描述当前代码已存在的行为，不把未来SSE、生产Store或未实现节点写成现状。
