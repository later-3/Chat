# Chat 工程规范

## 1. Workspace

目标目录：

```text
apps/dsh-web
apps/api
apps/pi-executor
packages/dsh-lifeos-bridge
packages/contracts
packages/domain
packages/application
packages/product-store-json
packages/memory-runtime
packages/project-runtime
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

当前仓库已经交付单机单写者Run Activity Journal，DSH Bridge仍使用受控Query轮询；SSE只是未来传输层，
不能改变下列顺序与重放合同。Debug Trace与Activity Journal是两个物理目录和两个语义边界。

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
正式测试分类、默认内存策略、CI调度及付费/外部写三闸门见
[测试lane](./testing/test-lanes.md)。

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

依赖、锁文件、Managed Fork或CI变化还必须运行`pnpm supply-chain:check`和只读audit。安装期脚本只允许
`pnpm-workspace.yaml`登记且逐项说明理由的包；新生产许可证、`Unknown`许可证或许可证例外必须先审查，
不能仅因构建成功而放行。

## 11. 公共面、兼容与ADR

1. 公共HTTP、Browser合同和workspace export由`pnpm api-surface:check`从真实请求/响应数据流、Application operation和package manifest生成并与baseline比较；不得手写第二份路由或Schema事实表。兼容新增使用精确一次性change record。
2. 网络、Product Store、Bridge State、Workflow/RunSpec、Direct/Generic Journal、Browser DTO/Event统一执行`read old / write current`。
3. 同一`schemaVersion`不得原地新增必填、收窄枚举或改变语义；新写语义升代际，旧代只读不能扩权。
4. breaking change必须有`detect / why / fix / verify / rollback`和用户明确批准；waiver绑定精确before/after digest与diff hash，Agent不得自行写waiver。
5. ADR只用于跨模块、长期且难以从局部代码恢复的决定。普通修复、测试或单包重构不写ADR。

## 12. 中文注释与当前实现文档

### 12.1 Capability与Tool执行

1. 可执行Tool不得只用裸`localName`作为跨边界身份；必须带`runtimeOwner + source namespace`的稳定Capability ID，并冻结descriptor、input schema、实现/工件和scope Hash。
2. Runtime Profile必须来自真实Runtime解析结果。来源碰撞、Extension加载diagnostic、资源不可读或实现Hash缺失时失败关闭，不得静默缩小目录或回退built-in。
   Extension实现Hash必须覆盖受管工件或排序后的本地依赖树；只Hash入口文件不合格。`project_bootstrap_prepare`等受管名字还必须验证精确SourceInfo，不能凭裸名认领身份。
3. `readiness`只表示部署可用性，不代替Principal、Workspace或Run授权。
   `global/workspace_required/provider_defined`必须分别解析；缺Workspace Grant或Provider Scope时不得复制调用方Scope或回退global。
4. `local_write/shell/external_write`在handler前必须提交Product Intent并消费绑定revision、Capability、参数Hash和scope的一次性Decision；Prompt Review不能代替Tool动作审核。
5. Tool已发出后的不确定结果不得自动重放；记录`outcome_unknown`并进入只读对账/人工处置。只有Product Result提交可用同一commandId安全重放。
6. Product Commit只引用结构化Tool Result Hash；模型自述不是执行证据。Pi Journal继续拥有完整运行证据，Product Store只保存必要引用与采用/终态事实。
7. 事件合同使用通用Capability引用；不得在Protocol、Store、Activity、Trace与UI各复制一套Tool名字枚举。
8. 当前新写代际为Product v20、Bridge v16、Prompt Assembly v4、Direct Protocol/Store v2及`full-operation.v3`；历史代际只读，不得借optional字段获得新授权语义。

### 12.2 注释与文档要求

1. 跨前端、HTTP、Application、Store、Outbox、Workflow、Provider或外部服务的关键边界必须有中文JSDoc或块注释，说明“进入什么、离开什么、谁拥有事实、失败怎样恢复”。
2. 注释优先解释原因和不变量：身份为什么不能混用、为什么需要CAS/Hash/Outbox、为什么不能自动重试；不为显而易见的赋值和语法逐行翻译。
3. 关键数据结构要说明字段角色，尤其是`commandId`、各种revision/Hash、产品ID、Attempt、Outbox与Runtime私有ID；同名或相近对象必须明确“是什么/不是什么”。
4. 新增或改变纵向交互时，同步更新最接近行为的as-built文档。前后端数据流更新`docs/architecture/frontend-backend-interaction.md`，Workflow节点更新`runtime-workflows.md`，启动、断点或排障更新`docs/debug/local-debug.md`。
5. 调试文档以“文件 + 函数/路由 + 观察变量”为稳定入口；行号只能作为临时提示，不能作为唯一定位方式。
6. 当前实现、目标架构和历史任务书必须分开。注释与调试指南只描述当前代码已存在的行为，不把未来SSE、生产Store或未实现节点写成现状。
