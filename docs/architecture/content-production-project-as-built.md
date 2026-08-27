# Content Production Project内核 As-built

> As-built：2026-08-26。本文记录Provider无关的项目事实；目录观察见[Content Lab资源观察与上下文编译](./content-lab-resource-context-as-built.md)。

## 1. 已交付结果

Chat现有Project内核已经演进为同一套可版本化事实，而不是为Content Lab另建控制面：

1. `content-production.v1`被编译为不可变`ProjectMethodSnapshot.v3`；旧三个Profile继续产生`generic` Work。
2. `ProjectWork.v2`在同一集合中判别`generic | content_delivery | workflow_improvement`，带稳定`workKey`、责任人、Practice Revision和Resource引用。
3. Content Work、方法改进Work、Blocked恢复、临时Agent Claim、Handoff、Publication Outcome、Practice Revision和Context Map都有Product Store事实与Application命令。
4. 用户Decision绑定Project/Work revision和可复算Payload Hash；Evidence绑定具体Work revision、来源和验证等级。
5. Project Query返回Work kind、Block、Claim、最新Handoff、Practice、发布Outcome和Context Map，Agent恢复不依赖旧Session。
6. Project内核不修改Content Lab目录、不发布内容；Project Query、Decision、Context和八个核心场景独立成立。

## 2. 版本与所有权

| 合同 | 当前版本 | 所有者 |
|---|---|---|
| Product Store | `chat-product-store.v23` | Chat Product Store |
| Project API DTO | `chat-project-api.v3` | Chat Contracts/Application |
| Method Snapshot | `project-method-snapshot.v3` | Chat Project内核 |
| Work | `project-work.v2` | Chat Project内核 |
| Evidence | `project-evidence.v2` | Chat保存引用；正文仍由Content Lab/Provider拥有 |
| Decision | `project-decision.v2` | Chat Project内核 |
| Block / Claim / Handoff | 各`v1` | Chat Project内核 |
| Practice Revision / Work Outcome / Context Map | 各`v1` | Chat Project内核 |

## 3. 生命周期与决定门

### 3.1 Content Delivery

```text
intake -> selected -> producing -> needs_review -> ready -> published
                     ^              |
                     +--------------+  用户要求返工

selected / producing / needs_review / ready -> blocked -> 原State
intake / selected / producing / needs_review / ready / blocked -> dropped
```

- Agent只有持有未过期Claim才能执行、阻塞或请求审核；用户可以直接记录Block和恢复。
- `needs_review`至少引用一条绑定该Work的Evidence。
- `ready`由用户Decision提交，并要求非`reported`的`content_revision`和`qc_report`。
- `published`要求所有目标平台都有`confirmed` Publication Outcome；Outcome引用精确内容Revision、verified发布回执和用户Decision。
- `dropped`、`published`是终态并绑定Resolution Decision；Blocked终态关闭同时解决活动Block和撤销活动Claim。

### 3.2 Workflow Improvement

```text
proposed -> selected -> experimenting -> needs_review -> adopted
                          ^              |
                          +--------------+  用户要求补实验

selected / experimenting / needs_review -> blocked -> 原State
proposed / selected / experimenting / needs_review / blocked -> rejected
```

`adopted`会创建不可变Practice Revision。已有当前Revision时，下一次采用必须精确声明被替代Revision；Store校验同一Practice只有一个当前`adopted`版本、前后双向链和严格递增版本。

## 4. Application与HTTP命令

Router只解析认证Principal、路径ID、`commandEnvelope`和Payload；CAS、权限、状态机、事务与幂等均由Application/Product Store拥有。

| 用户/Agent语义 | HTTP入口 | Revision门 |
|---|---|---|
| 创建内容Project与Context Map | `POST /api/content-production-projects` | Command幂等 |
| 注册Agent Participant | `POST /api/projects/:projectId/agents` | Project revision |
| 创建两类Work | `POST /api/projects/:projectId/works` | Project revision |
| 记录Work Evidence | `POST /api/projects/:projectId/evidence` | Payload内精确Work revision |
| Claim / 过期接管 | `POST .../works/:workId/claims` | Work revision + lease |
| Block / Resume | `POST .../blocks`、`POST .../resume` | Work revision |
| 请求审核 / Handoff | `POST .../review`、`POST .../handoffs` | Work revision + 有效Claim |
| 用户状态决定 | `POST .../decisions` | Work revision + Decision Hash |
| 记录发布Outcome | `POST .../publications` | Ready Work revision |
| 采用Practice Revision | `POST .../practice-revisions` | Needs Review Work revision |

所有命令使用既有Command Receipt合同；同`commandId`同请求重放返回同一事实，不同请求复用会被拒绝。

## 5. Evidence、Claim与查询恢复

- 新内容Evidence必须包含`workId + workRevision`；跨Work或未来Revision引用失败关闭。
- 通用用户Evidence入口只允许把`user_decision`来源的`user_review`或`publication_receipt`标为`verified`。Provider verified必须由P5受管Adapter命令产生，不能由调用方自报。
- Claim有`acquiredAt/leaseExpiresAt`。新Claim在同一事务内把过期旧Claim标为`expired`并取得唯一活动租约；有效Claim冲突不会产生半事实。
- Handoff保存已完成、未完成、风险、下一步、Required Reads和Evidence，并释放旧Claim；新Agent随后Claim同一稳定Work。
- Project Workspace Query返回活动Block/Claim、最新Handoff、Practice/Outcome与Context；Content终态不再被统计为活动Work，Timeline正确标记Work转换。

## 6. Store迁移与完整性

`v19 -> v20`迁移只转换本地事实：

- Method v2编译为v3并重算Hash；
- Work v1迁为`generic` Work v2并生成`legacy:<workId>`稳定键；
- Evidence v1按旧kind映射role/provenance，永不自动升级为verified；
- Decision v1升级为v2并生成Payload Hash；
- 新内容集合初始化为空，不创建Content Work、Claim或Outcome。

v5-v19 reader使用冻结的旧Project Schema；非空v4 Project会串行穿过全部版本，另有非空v19真实字节Fixture验证原子落盘和重启幂等。Snapshot Integrity还校验：

- Work状态、Profile kind、Claim/Block唯一性；
- Decision active状态、Work/revision和Payload Hash；
- Evidence精确Work绑定；
- Publication目标平台覆盖；
- Practice前后版本链；
- Context Map唯一性和Hash；

## 7. 当前边界与下一阶段

当前已接入Content Lab目录Observation、Artifact Candidate、Context Compiler、工具无关Opening Packet v2与DSH项目四视图。尚未接入Maintenance自动调度、具体Document/Code/Media Viewer，也未执行正式Store数据采用；这些都需要独立授权。外部项目Provider配置与历史导入不属于默认能力，任何真实写仍需单独的Dry Run、用户审核和外部门。
