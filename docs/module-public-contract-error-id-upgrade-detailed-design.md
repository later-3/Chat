# 模块公开合同、错误、ID 与升级门详细设计

> 状态：**已批准并完成W1-01基础实现**（2026-07-31）  
> 工作包：`W1-01`  
> 授权来源：用户要求连续完成详细设计与架构调整，不再逐项暂停确认。  
> 实现口径：W1-01已经交付统一错误注册族、显式恢复动作、外部Command ID语法、模块合同状态清单、MAF私有接合集中边界和安装版升级门；各状态所有者的完整DTO/Schema与公开`/v1`仍属于对应模块工作包，不因本基础包完成而冒充已实现。

## 1. 结论

Chat固定采用4层公开合同和1条可追踪ID链：

1. **领域公开合同**：14个状态所有者各自发布Command、Query、Event；只有所有者能改变自己的权威事实。
2. **应用用例合同**：APP-INTERACTION与APP-PROJECTION组合多个领域公开合同，但不复制领域表和状态机。
3. **网络合同**：REST管理资源和查询投影，AG-UI承载一次Agent Run的实时交互；两者不能互相冒充。
4. **运行适配合同**：MAF、Provider、Tool、Worker和外部Channel只能通过集中Adapter接入，私有API不得散落到领域代码。
5. **关联ID链**：Principal/Scope、Product Session、Interaction、Product Run/Attempt、Runtime Job、AG-UI Thread、MAF Session/Checkpoint和Tool/Delivery ID职责分开；即使某阶段值相同，也不合并语义或授权。

所有跨边界失败统一返回稳定错误码、可恢复性、请求关联ID和脱敏消息。所有依赖升级必须先通过锁定版本、合同指纹、恢复场景和回滚门。

## 2. 设计目标与非目标

### 2.1 必须保证

1. 调用方不解析中文错误文本、不读取ORM、不依赖框架私有Payload形状。
2. 相同命令重放不会重复创建资源或重复外部副作用。
3. CAS冲突、权限拒绝、暂时失败、结果未知和永久失败能被UI区分。
4. 任一用户可见结果能反查请求、Interaction、Run、Attempt、决策、Evidence和源对象revision。
5. MAF/AG-UI/Provider升级不会在未验证时静默改变Checkpoint、Interrupt、事件顺序或最终提交语义。

### 2.2 本工作包不负责

1. 不在W1-01创建Identity、Work、Schedule或Delivery领域Schema。
2. 不把所有内部对象公开为网络DTO。
3. 不承诺一次完成公开API `/v1` 迁移；先冻结兼容规则和测试门。
4. 不以通用Event Bus替换当前明确的函数调用、事务Outbox和AG-UI链路。

## 3. 合同分类与依赖方向

| 合同 | 创建者/所有者 | 消费者 | 版本方法 | 禁止事项 |
|---|---|---|---|---|
| Domain Command | 对应状态所有者 | 应用协调器、受权Adapter | `command_type + schema_version` | Router直接改表 |
| Domain Query | 对应状态所有者 | Projection、Interaction、Admin Ops | 响应Schema版本+字段兼容规则 | Projection直读私有ORM |
| Domain Event | 对应状态所有者 | Outbox消费者、投影、运营聚合 | 事件名+整数版本 | 把事件当跨模块同步事务 |
| REST DTO | HTTP Interface | Web/Adapter | OpenAPI指纹；破坏性变更升主版本 | 返回数据库模型 |
| AG-UI Event | AG-UI Adapter | Web Agent Client | 安装版合同测试 | 自建竞争性的核心流事件协议 |
| Runtime Envelope | Run模块/Worker接口 | MAF、pi、Provider、Tool Adapter | 显式Schema/Adapter版本 | 把Runtime对象当产品事实 |
| Projection Envelope | APP-PROJECTION | Web/Obsidian/第三方Adapter | `schema_version + view_schema` | Adapter推断缺失事实 |

依赖固定为：

```text
UI / Channel Adapter
  -> REST / AG-UI Network Contract
  -> Application Coordinator
  -> Owner Command / Query Contract
  -> Product Store transaction
  -> Outbox / Runtime Adapter

Owner Event / Query
  -> APP-PROJECTION
  -> Presentation Adapter
```

领域模块不得反向依赖Projection、React、FastAPI Router、MAF实现或具体Channel。

## 4. ID链

### 4.1 ID职责

| ID | 谁创建 | 用途 | 能否用于授权 |
|---|---|---|---|
| `principal_id` | MOD-IDENTITY | 真实人/服务身份 | 是，但必须结合Grant与Scope |
| `scope_id` | MOD-IDENTITY | 租户/个人空间边界 | 是 |
| `authentication_session_id` | MOD-IDENTITY | 登录凭据生命周期 | 是 |
| `product_session_id` | MOD-CONVERSATION | 可重开的交互容器 | 否，不能单独证明身份 |
| `interaction_id` | MOD-CONVERSATION | 一次接纳后的用户交互 | 否 |
| `message_id` | MOD-CONVERSATION | 产品消息树节点 | 否 |
| `project/work/action/note_id` | 对应领域所有者 | 长期产品对象 | 需再做Scope授权 |
| `product_run_id` | MOD-RUN | 用户可见的一次执行意图 | 否 |
| `run_attempt_id` | MOD-RUN | 某Run的一次尝试 | 否 |
| `runtime_job_id` | Runtime Store | Worker领取和事件游标 | 否 |
| `agui_thread_id` | AG-UI边界 | 实时协议关联 | 否 |
| `maf_session/checkpoint_id` | MAF Runtime | Agent历史与Workflow恢复 | 否 |
| `decision/grant/consumption_id` | MOD-GOVERNANCE | 审核、授权与一次性消费 | 仅作为授权链证据 |
| `tool_operation/attempt_id` | MOD-TOOL | 副作用及尝试 | 否 |
| `artifact/evidence_id` | MOD-EVIDENCE | 结果与证明 | 否 |
| `delivery/receipt_id` | MOD-DELIVERY | 送达与回执 | 否 |
| `request_id` | HTTP入口 | 一次网络请求排障 | 否 |
| `command_id` | 调用方/应用层 | 幂等命令身份 | 否 |

### 4.2 关联规则

1. HTTP入口生成或校验`request_id`，日志和Problem Detail必须返回同值。
2. 接纳用户输入后创建`interaction_id`；后续0..n个Run都引用它。
3. 每次Run尝试新建`run_attempt_id`，Retry/Restart不得覆盖旧Attempt。
4. Runtime Job、MAF Checkpoint、Tool Operation和Delivery都必须能回指Product Run/Attempt。
5. UI显示短ID只作定位，复制、API和Trace始终保留完整稳定ID。
6. 任何外部传入ID先做语法、Scope和资源存在性检查；404可合并“不可见/不存在”防止枚举。

## 5. 统一错误合同

### 5.1 网络Problem Detail

所有非流式HTTP失败使用：

```json
{
  "code": "PROJECT_REVISION_CONFLICT",
  "message": "Project已变化，请刷新后比较差异。",
  "request_id": "req-...",
  "retryable": false,
  "details": {
    "resource_kind": "project",
    "resource_id": "...",
    "expected_revision": "3",
    "actual_revision": "4"
  }
}
```

`details`只包含安全、结构化、调用方可行动的信息；不包含密钥、完整Prompt、Provider Payload、堆栈或隐藏推理。

### 5.2 错误族与UI动作

| HTTP | 稳定错误族 | 含义 | 默认UI动作 |
|---|---|---|---|
| 400 | `*_INVALID_REQUEST` | 网络形状或语义不合法 | 修订输入 |
| 401 | `AUTHENTICATION_REQUIRED` | 未认证/会话失效 | 重新认证 |
| 403 | `*_FORBIDDEN` | 已认证但无权限 | 显示拒绝原因，不循环登录 |
| 404 | `*_NOT_FOUND` | 不存在或不可见 | 返回目录/刷新 |
| 409 | `*_REVISION_CONFLICT`、`*_STATE_CONFLICT` | CAS或状态机冲突 | 刷新并Diff |
| 410 | `*_EXPIRED` | Approval/Grant/Cursor已过期 | 重新发起 |
| 422 | `*_VALIDATION_FAILED` | 可修订业务输入 | 定位字段并审查 |
| 429 | `*_RATE_LIMITED` | 限流 | 按边界重试 |
| 502/503/504 | `*_UNAVAILABLE/TIMEOUT` | 外部或服务暂时失败 | 有界重试 |
| 500 | `INTERNAL_ERROR` | 未分类内部失败 | 携request_id联系支持 |

另有2个不能被普通HTTP状态吞掉的运行结果：

1. `OUTCOME_UNKNOWN`：请求已送出但无法证明对方是否执行，必须对账，禁止自动重放副作用。
2. `STALE_SOURCE`：来源revision已变化，必须重建Context/Draft/Projection，禁止继续用旧批准。

### 5.3 错误注册表

每个模块维护代码常量和测试，命名为`<SUBJECT>_<CONDITION>`。新增错误码必须声明：HTTP映射、retryable、用户恢复动作、是否可公开details、日志级别和测试。删除或改变含义属于破坏性变更；中文message可改进但不能成为程序分支依据。

## 6. 幂等、CAS与重复执行

1. 所有写命令必须携带`command_id`；相同Scope、命令类型和ID返回原结果或明确冲突。
2. 修改已有对象必须携带`expected_row_version`或等价Hash；不接受“最后写入覆盖”。
3. 事务内同时提交领域事实、Trace和Outbox；投影和搜索索引失败不回滚已提交的领域事实。
4. 无外部副作用的Query可安全重试；有副作用的Tool/Delivery必须使用Operation Ledger和幂等键。
5. 超时发生在发送前可重试；发送后不确定必须进入`outcome_unknown`并对账。
6. POST创建成功后网络丢失，调用方重放相同`command_id`必须得到同一资源ID。

## 7. 四个提交门

| 门 | 输入 | 成功条件 | 失败时禁止产生 |
|---|---|---|---|
| 接纳门 | 原始用户输入、Principal、Scope | Message/Interaction先持久化 | 丢失输入后直接运行模型 |
| 授权门 | 当前Draft/请求Hash、Policy、Decision | Grant绑定当前版本且未消费 | 用旧批准执行新内容 |
| 副作用门 | 已批准Operation、能力和幂等键 | Ledger先记录，再执行/对账 | 无记录外部动作或盲重试 |
| 产品成功门 | Runtime结果、Validation、Evidence、提交计划 | Product事实原子提交后才发布成功 | Provider成功即冒充Product完成 |

四个门分别属于Conversation、Governance、Tool、Run/Evidence等所有者；不收进一个万能Service。

## 8. API兼容与版本策略

1. 当前未带公开主版本的`/api/*`视为内部产品API；先用OpenAPI指纹和DTO阻断无意变化。
2. 面向第三方稳定发布时引入`/api/v1`，内部路由可复用相同Application Contract，不复制业务逻辑。
3. 同一主版本允许增加可选响应字段、增加新端点和新增调用方可忽略的Event；不能删除字段、改变枚举含义、把可空改为必填或改变成功/失败语义。
4. Projection另有`schema_version`和`view_schema`；Adapter必须声明支持范围，不能只看URL版本。
5. AG-UI遵循锁定安装版；自定义Event必须命名空间化并有解码失败关闭测试。
6. 每个破坏性升级提供并行读、迁移/回滚、旧客户端窗口和删除日期；数据库迁移成功不等于合同升级完成。

## 9. MAF、AG-UI与依赖升级门

升级申请必须记录当前安装版本、目标版本、本地参考源码提交、私有API差异和回滚版本。合并前至少通过：

1. Agent Session历史装配不重复。
2. Workflow图签名、Checkpoint编码/恢复和pending `request_info`保持合同。
3. AG-UI Run开始、流式消息、Interrupt、Resume、Error和Final事件顺序正确。
4. Product提交失败不会先发成功终帧。
5. Worker退出、重复领取、旧Checkpoint和未知request id失败关闭。
6. 真实模型最小回合与Bootstrap确定性回合各1次。
7. Lockfile、OpenAPI、Workflow目录、Schema/迁移和关键Hash指纹经过审核更新。

私有导入必须集中在Runtime Adapter，并写明移除条件。未经这些测试，不升级MAF/AG-UI RC、不在领域代码兼容两套版本。

## 10. 模块公开合同模板

每个状态所有者详细设计必须填写：

1. 用户价值、负责/不负责。
2. 权威对象、状态机、唯一事务所有者。
3. Commands、Queries、Events及版本。
4. Principal/Scope授权与字段级可见性。
5. 输入/输出ID和revision链。
6. 幂等、CAS、并发与外部副作用语义。
7. 错误注册表和恢复动作。
8. Outbox、索引、Projection和缓存的可重建规则。
9. 失败/重启/对账/数据保留。
10. 合同、架构、状态机、迁移、真实链路和用户场景测试。

## 11. 验证矩阵

| 层级 | 必测项 |
|---|---|
| 纯合同 | Canonical/Hash、ID编码、DTO extra字段策略、错误映射 |
| 领域 | 状态机、CAS、幂等、跨Scope拒绝、Outbox原子性 |
| HTTP | OpenAPI、401/403、404防枚举、409 Diff、422字段、错误脱敏 |
| AG-UI | 顺序、重复、断流、Interrupt/Resume、终态门 |
| Runtime | Checkpoint、Lease、Retry/Restart、结果未知、对账 |
| 前端 | 恢复动作、未知/空/禁止/错误区分、稳定ID定位 |
| 升级 | 旧数据、旧客户端、在途Run、回滚、关键指纹 |

## 12. 落地顺序与当前差距

1. **已存在**：统一Problem Detail、请求ID、部分类型化Response、命令ID/CAS、Schema/OpenAPI/Workflow指纹和大量恢复合同。
2. **W1-01已补齐**：20个模块/组件的机器可读`contract_status + contract_ref`；全部REST写命令共享`CommandId`语法；Problem Detail新增`recovery_action`并区分401/403、CAS、过期、可重试与结果未知；生产代码不再散落裸`HTTPException`。
3. **Runtime升级门已完成**：可删除的8处`RequestInfoMixin`重复私有继承和AG-UI私有导入已移除；剩余Checkpoint编解码、类型匹配和RC8恢复桥只允许出现在`runtime_adapters/maf_compat.py`；启动、CI和专项测试锁定3个安装版本、MAF参考提交、AG-UI Resume字段、Checkpoint往返/类型白名单/HITL pending/恢复桥，并验证版本漂移失败关闭。
4. **后续按Owner工作包完成**：各模块把仍为泛型对象的响应逐步替换为字段级DTO；Identity/Work/Schedule/Delivery等Schema与授权随W2-W10交付；稳定第三方API出现真实消费者时再决定`/api/v1`；有明确目标版本时用同一套升级门做真实依赖升级与回滚，不在W1-01假升级生产依赖。
5. **验收结论**：W1-01基础工作包完成，但Manifest中`partial/design_only`模块保持未完成；基础合同完成不等于14个领域模块全部实现。
