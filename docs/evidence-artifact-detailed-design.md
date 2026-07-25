# F02 Evidence、Artifact、Provenance 与 SD4 验证门详细设计

> 状态：**待用户审核**。本文是字段级详细设计候选；用户批准前不得创建正式
> Schema、迁移、持久化服务或兼容层。
>
> 适用范围：F02 独立 Evidence、Artifact、Provenance 生命周期，以及 SD4 首个
> “受管 Execution Workspace 内 Diff/验证/完成声明”纵向切片。
>
> 不授权：活动仓库合入、commit/push/deploy（SD5）、通用外部副作用 Evidence、
> Artifact 自动清理与保留策略、Provenance 通用知识图谱、跨进程 pi 恢复（F05）、
> Delivery Outbox 与送达回执（W9/F07）。

## 1. 为什么内嵌 `evidence_json` 不能继续扩展

当前 `WorkItem.completion_evidence_json` 与 `ActionItem.evidence_json` 是自由
JSON 数组。它们能回答“完成时附了几段文字”，但回答不了 F02 必须回答的问题：

1. 这段证据对应的真实内容在哪里，是否被篡改（无 Hash、无 Artifact 关联）。
2. 这份证据当前是否仍有效：来源版本变化、文件被删、权限被撤时无法表达。
3. 这个结论来自哪个 Product Run、哪次 ToolOperation、哪次模型调用。
4. 同一份证据被多个 Work/Note/Memory 引用时只能复制文本，失效后各处不一致。
5. “本周 Chat 做了什么”这类查询必须来自已提交事实与证据，自由 JSON 无法
   支撑可信聚合，模型只能从聊天语气猜测（反例 017、反例 026）。
6. 验证失败时 Work 不能假完成的规则目前只靠服务层字符串判断，没有可审计的
   Evidence 状态机和接受 Decision 关联。

F02 新增独立 Evidence、Artifact、Provenance 对象。既有内嵌 JSON 变为只读
legacy，新写入必须是 Evidence 引用（见 D12）。

## 2. 证据与参考结论

### 2.1 MAF 安装版与源码事实

项目安装 `agent-framework-core 1.11.0`。MAF 拥有 Agent、Session、Workflow、
Checkpoint、Tool 调用语义；它不拥有产品级 Evidence、Artifact、Provenance，
Workflow Checkpoint 也不保存 Tool 副作用、验证结果或代码产物（该结论已在
[Chat 自开发设计](./chat-self-development-design.md)第 62 行固定）。

因此：

- Evidence、Artifact、Provenance 全部由 Chat 产品层拥有，不委托给 MAF；
- MAF Workflow/Executor 只产生 Evidence Candidate，正式提交走产品事务；
- Artifact Store 与 Product Store 可以物理共置，逻辑所有权分开（总体架构
  第 240 行不变量）。

证据：

- 安装版路径：`/Users/xulater/Code/Chat/.venv/lib/python3.12/site-packages/agent_framework/_workflows/_checkpoint.py`
- 参考源码提交：`9c4cd07899502157284b64a73f9a0adfb4594d96`（对应本地参考仓库 `/Users/xulater/Code/opc-os/agent-framework`）

### 2.2 pi、nanobot、QwenPaw、LibreChat 取舍

四个参考项目对本设计主题均为**未涉及**，结论已在各自固定提交的研究中记录：

| 项目 | 固定提交 | 与本主题相关的真实能力 | 明确缺口 |
|---|---|---|---|
| pi | `2b00dade7cec918aefb025c8b7a4fa304a30acdd` | Session JSONL 运行日志、Tool hooks | 产品级 Evidence 提交门、Artifact 生命周期；JSONL 是运行日志，不能冒充产品证据 |
| nanobot | `2c789767280482f38667044f8a3be5102c71dd26` | Session/Memory 存储 | Evidence、Provenance、Artifact |
| QwenPaw | `2134427584c2657bb717bb083a120f2de011d047` | Tool 治理分层 | Evidence/Artifact/Provenance 未涉及 |
| LibreChat | `8e5ef1fb31e9d63b735c089b21cbc82c50acce46` | Message 树、Generation Job | 结论来源、来源失效传播、Artifact Hash 校验未涉及 |

因此 Evidence/Artifact/Provenance 的对象模型是**本项目需求推导**（问题 5、6），
不能借参考项目名义包装。采用的通用工程原则：内容寻址（对象以其内容
Hash 命名，使篡改可检测）和 LibreChat 的“产品提交与实时终帧分离”顺序。
这两个原则不专属任何参考项目。

### 2.3 W3C PROV-O 与方法来源

[W3C PROV-O](https://www.w3.org/TR/prov-o/) 以 Entity、Activity、Agent 表达
“什么由什么活动、主体和来源产生”。本项目**渐进采用其最小关系集**，不实现
完整本体，也不建立通用知识图谱（该取舍已在
[协作系统研究](./chat-collaboration-system-research.md)第 118、128 行记录）。

首版只落地 5 种有类型关系：`derived_from`、`generated_by`、`used`、
`attributed_to`、`invalidated_by`。Evidence 是否支持 Claim 已由
Assessment/Requirement 的强类型 FK 回答，不再额外写 `supports` 边制造第二事实源。能由强类型 FK 回答的关系不建边
（见 4.15.2）。

### 2.4 本项目既有事实（F02 的原材料，不是 Evidence 本身）

1. F01 ToolOperation/Attempt/Reconciliation 已提供文件 preimage/postimage/
   observed Hash 对账；这是 Evidence 的输入，不等于 Evidence。
2. ModelCall Attempt 已持久记录可见输出 Hash 与 Workflow 采用去向；Evidence
   引用其 ID，不复制其内容。
3. Governance `decision_records` 已存在；Evidence 采用、豁免、提交都必须绑定 Decision。
4. 总体架构 7.9 Evidence 模块的对象、组件、合同、不变量已获批准；本文是它的
   字段级落地，不改变已批准边界。
5. `harness/service.py` 完成门已有“必须有 Evidence 或豁免原因”规则；F02 把
   自由 JSON 升级为引用校验，规则本身不变。

## 3. 核心概念与关系模型

F02 区分五个 Evidence 语义面，并把 Integration Applicability 作为第六个、但
完全正交的提交语义，避免再用 `kind + exit_code` 硬编码“失败”。它们不再被
压进同一行：

| 维度 | 落点 | 含义 | 可变性 |
|---|---|---|---|
| **Observation / 材料** | `evidence_observations` | 实际观察到的材料：验证命令输出、文件 Hash、Tool 回执、模型可见输出、人工确认文本 | payload 不可变；同一材料可被多个 Claim/Requirement 复用，不复制内容 |
| **Validity** | `evidence_observations.validity` | 绑定的精确来源版本当前是否仍可访问并按 Hash 验证：`valid` / `stale`（来源版本变化，可重验恢复）/ `unavailable`（暂时无法读取，可恢复）/ `revoked`（用户或策略停止采用，终态）/ `unverifiable`（来源本身无版本无 Hash） | 由 `source_invalidations` 事件驱动，CAS 更新 |
| **Assessment / Verdict** | `evidence_assessments` | 某 Observation 针对**某个 Claim 的某个 Requirement** 的结构化结论：`supports` / `refutes` / `inconclusive` | 不可变；重新验证产生新 Observation + 新 Assessment，以严格 sequence/supersedes 链确定当前项 |
| **Adoption** | `claim_evidence_adoptions` | 某 Claim 采用哪个 Assessment 作为某 Requirement 的完成依据，绑定批准 Decision | 不可变；一个 Claim 的每个 Requirement 至多一条 |
| **Waiver** | `requirement_waivers` | 逐 Requirement 的豁免，绑定 Decision 与理由；不是整 Work 的 blanket waiver | 不可变；一个 Requirement 至多一条 |
| **Integration Applicability** | ResultCommit 运行时前置检查 | Claim 绑定的 ArtifactRevision/RepositorySnapshot 是否仍匹配当前合入目标；不是 Evidence 的属性，不落 Evidence 表 | 由 ResultCommit 比较 Claim 绑定 Snapshot 与当前目标 Snapshot 决定，属 SD5 Integration 边界 |

“验证失败”不再是一个写死的状态，而是：

- Observation：验证命令输出（含退出码、stdout、stderr），`validity=valid`。
- Assessment：对当前 Claim 的 `validation_result` Requirement 给出 `refutes`。
- Adoption：无（失败结论不能被采用为完成依据）。
- 旧失败完整保留，但完成门**只评估当前 Claim 当前 Requirement 的最新
  Assessment/Adoption/Waiver**，历史 `refutes` 不阻断新 Claim（见 9.2）。

**Validity 与 Applicability 的严格隔离**：不可变的 RepositorySnapshot A 不会因为
活动仓库前进到 Snapshot B 而“失效”，因此**不创建任何 SourceInvalidation**。
A 上通过的 Observation 其 `validity` 保持 `valid`——它绑定的精确来源版本仍可
访问并按 Hash 验证。SD4 的 `action_result_accepted` 只接受“该结果确实在 A 上
验证”，因此仍可提交，并在视图标记“当前目标已前进、合入前需重验”。到 SD5
真正执行 Integration Commit 时才比较 A 与目标 B；不匹配返回
`ARTIFACT_APPLICABILITY_STALE` 并写 Trace。该失败不创建 SourceInvalidation。

## 4. 本阶段对象（字段级设计）

以下对象进入第 20 次 Alembic 迁移候选。所有根对象和跨边界关系带 `scope_id`；
ArtifactRevision 等强所有权子对象通过父 FK 派生 scope，避免重复列漂移。所有
对象带 `created_at`，可变对象另带 `row_version`、`updated_at`。所有写路径走
Application Coordinator 事务，REST 不直接改状态。所有跨表引用（含
Provenance 的 generic source/target）必须在写入事务内校验目标存在且
`scope_id` 相同，跨 scope 写入直接拒绝。

**硬 FK 环排查结论**：本设计不存在硬 FK 环。`artifact_records` 不再保存
`current_revision_id`；`completion_claims` 不再保存 `result_commit_id`；
`result_commits.completion_claim_id` 带 UNIQUE 约束，反向查询 Claim 的
ResultCommit。既有项目已有 SQLAlchemy FK 环风险，F02 不新增任何环。

### 4.1 Artifact Store 与 Blob 写入协议

Artifact Store 是内容寻址文件系统，元数据在 Product Store。两者**不能**被
描述为“文件系统与数据库原子”。

**范围去重模型（选定）**：去重边界是 scope。`artifact_blobs` 的唯一约束是
`UNIQUE(scope_id, sha256)`；同一 sha256 在不同 scope 各有一行、各有一份物理
文件。物理路径包含不可逆的 scope storage key，跨 scope 不共享文件，因此单
scope GC 永远删不到其他 scope 的文件。

scope storage key：`HMAC-SHA256(server_secret, scope_id)` 的前 128 bit（32 个 hex 字符），
server_secret 来自私有运行配置注入，不进入文档、日志、Trace 或浏览器响应。
该 key 不可逆，物理路径不泄露 scope_id；key 同时冗余存于 blob 行的
`storage_path` 中，读取不需要重算。

```text
staging/publish 协议（创建 Artifact Revision）：
1. Application Coordinator 接收已批准的 Artifact 内容字节。
2. 计算 sha256 与 size_bytes；推导 scope storage key。
3. 写入 staging 临时文件：
   {store_root}/staging/{scope_storage_key}/{uuid}.tmp，并 fsync。
4. no-clobber publish：以 O_EXCL 语义创建（或 hard link 到）最终路径
   {store_root}/blobs/{scope_storage_key}/{sha256[:2]}/{sha256}。
   - 成功：该 blob 已稳定存在，尚未被任何 DB 行引用。
   - EEXIST：已存在同名文件。重新读取最终文件，重算 sha256 与 size；
     与本次内容一致则直接复用；不一致则判定 Hash 冲突/损坏，本次写入失败。
     **不得移动或覆盖既有最终文件**，因为它可能正被其他 Revision 引用；只把
     本次 staging 输入复制到 quarantine，并把对应 Blob 标记 `corrupt`（若有行）、
     记录完整性告警，等待人工处置。
   - 禁止覆盖式 rename 到最终路径。
5. 开启 Product Store 事务，按以下顺序插入（同一事务）：
   a. artifact_blobs：按 (scope_id, sha256) 查；不存在则插入（唯一约束兜底，
      冲突时复用已有行）。
   b. artifact_records：插入（status='candidate'）。
   c. artifact_revisions：插入，artifact_id 指向上一步的行，
      revision_number = 1。追加 Revision 时先锁定 ArtifactRecord、校验
      expected row_version，再取 MAX(revision_number)+1、插入 Revision 并递增
      ArtifactRecord.row_version；UNIQUE 只作并发兜底，不用无锁 MAX+1 猜序号。
   d. 同事务写入 EvidenceObservation、ProvenanceEdge、Outbox 等关联行。
   e. 所有 FK 写入同事务校验 scope_id 一致。
6. 事务提交成功后清理 staging 临时文件（幂等：已不存在则忽略）。
```

崩溃窗口与恢复：

- **publish 后、DB 提交前**：存在完整 orphan blob，位于 `blobs/`（不是
  staging）。Reconciler 必须同时扫描 staging 与未被 DB 引用的 blob。
- **DB 事务内崩溃**：全部回滚；blob 成为 orphan，由 GC 在宽限期后清理。
- **DB 提交后、staging 清理前崩溃**：staging 残留临时文件；Reconciler 发现其
  sha256 已在 `artifact_blobs` 中则删除 staging 文件。
- **DB 提交后、blob publish 前**：不可能发生；协议规定先 publish 再开事务。

Reconcile / Orphan GC：

```text
Reconcile（启动时 + 周期任务）：
1. 扫描 staging/{scope_key}/*.tmp，mtime 超过 24h：
   - sha256 已存在于 artifact_blobs → 删除 staging 文件；
   - 否则 → 转入 orphan 候选（按 orphan 规则处理）。
2. 扫描 blobs/{scope_key}/ 下全部文件：
   - 无对应 artifact_blobs 行 → 以文件 mtime 作为候选起点，超过宽限期才删除；
   - 有行且无 Revision 引用 → CAS 标记 `gc_status='orphan_candidate'` 并记录
     `orphaned_at`；重新出现引用时恢复 `active`。
Orphan GC（删除必须同时满足）：
   - 该 blob 行不被任何 artifact_revisions 引用（实时查询，无缓存计数）；
   - 不在任何 retention lease（retention_until > now 的行）内；
   - `orphaned_at` 已超过可配置宽限期（默认 24h）。
   删除协议：事务内锁定 Blob、重查无引用与保留条件、CAS 标记 `deleting`；提交后
   unlink 物理文件；成功后在新事务中删除 Blob 行。unlink 失败则把行标记
   `delete_failed` 并保留错误码供重试；unlink 成功但第二个 DB 事务失败时，
   Reconciler 看到 `deleting` + 文件不存在后完成删行。创建 Revision 只能引用
   `gc_status='active'` 且 `integrity_status='available'` 的 Blob，从而关闭 GC/引用竞态。
```

GC 权威来源说明：**不维护 `ref_count` 缓存列**。引用判断以
`SELECT 1 FROM artifact_revisions WHERE storage_blob_id = ? LIMIT 1` 实时查询
为准；该查询走 `ix_artifact_revisions_blob` 索引。缓存计数没有权威维护者
（写入路径多、崩溃窗口存在），只会制造第二事实源，故删除。

### 4.2 `artifact_blobs`

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `scope_id` | String(100) | NOT NULL, INDEX | Scope 隔离与去重边界 |
| `sha256` | String(64) | NOT NULL | 内容指纹 |
| `size_bytes` | Integer | NOT NULL, CHECK >=0 | 字节大小 |
| `storage_path` | String(512) | NOT NULL | 相对 store root：`blobs/{scope_storage_key}/{sha256[:2]}/{sha256}` |
| `integrity_status` | String(20) | NOT NULL, CHECK IN ('available','missing','corrupt') | 内容可用性；读取 Hash 不符置 `corrupt`，文件缺失置 `missing` |
| `gc_status` | String(24) | NOT NULL, CHECK IN ('active','orphan_candidate','deleting','delete_failed') | GC 协调状态，不代表 Artifact 业务生命周期 |
| `orphaned_at` | DateTime | NULL | 首次确认无 Revision 引用的时间 |
| `last_gc_error_code` | String(100) | NULL | 脱敏错误码，不存原始异常文本 |
| `retention_until` | DateTime | NULL | 显式保留截止时间（retention lease） |
| `row_version` | Integer | NOT NULL, DEFAULT 1, CHECK >=1 | CAS（integrity/gc/retention 状态变更） |
| `created_at` | DateTime | NOT NULL | 首次写入时间 |
| `updated_at` | DateTime | NOT NULL | |

唯一约束：`uq_artifact_blobs_scope_sha256` (scope_id, sha256)；
`uq_artifact_blobs_storage_path` (storage_path)。
索引：`ix_artifact_blobs_scope_created` (scope_id, created_at)。

### 4.3 `artifact_records`

产品产物元数据。`status` 只描述**当前 Revision** 的处置，不回写或抹掉旧
Revision 的历史结局；旧 Revision 的 accepted/rejected 事实从 ResultCommit
查询。**当前 Revision 不存列**：当前 Revision 由查询
`WHERE artifact_id = ? ORDER BY revision_number DESC LIMIT 1` 得出，走
`ix_artifact_revisions_current` 索引。这消除了与 `artifact_revisions.artifact_id`
的循环 FK 与“先插谁”的悬空窗口。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `scope_id` | String(100) | NOT NULL, INDEX | Scope 隔离 |
| `kind` | String(40) | NOT NULL, CHECK IN ('diff_patch','validation_report','generated_file','design_document','result_patch','exported_content') | |
| `title` | String(240) | NOT NULL | 展示标题 |
| `media_type` | String(120) | NOT NULL | 下载 MIME |
| `status` | String(32) | NOT NULL, CHECK IN ('candidate','accepted','rejected','not_adopted','retained','discarded') | 见 6.1 状态机 |
| `product_run_id` | String(36) | FK→product_runs.id ON DELETE RESTRICT, NULLABLE | 产生它的 Run；允许为空（未来用户上传） |
| `run_attempt_id` | String(36) | FK→run_attempts.id ON DELETE RESTRICT, NULLABLE | 产生它的 Attempt |
| `created_by` | String(100) | NOT NULL | |
| `command_id` | String(160) | NOT NULL | 创建 Artifact 的幂等键 |
| `row_version` | Integer | NOT NULL, DEFAULT 1, CHECK >=1 | CAS |
| `created_at` | DateTime | NOT NULL | |
| `updated_at` | DateTime | NOT NULL | |

唯一约束：`uq_artifact_records_command` (scope_id, command_id)。
索引：`ix_artifact_records_scope_status` (scope_id, status, updated_at);
`ix_artifact_records_run` (product_run_id, created_at)。

### 4.4 `artifact_revisions`

Artifact 的不可变修订。修改产物 = 新 Revision，旧 Revision 保留。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `artifact_id` | String(36) | FK→artifact_records.id ON DELETE RESTRICT, NOT NULL | |
| `revision_number` | Integer | NOT NULL, CHECK >=1 | 同一 artifact 内单调递增 |
| `storage_blob_id` | String(36) | FK→artifact_blobs.id ON DELETE RESTRICT, NOT NULL | 同事务校验与 artifact 同 scope |
| `sha256` | String(64) | NOT NULL | 冗余缓存，读取时重算校验 |
| `size_bytes` | Integer | NOT NULL, CHECK >=0 | |
| `excerpt` | Text | NULL | 小文本预览 |
| `supersedes_revision_id` | String(36) | FK→artifact_revisions.id ON DELETE RESTRICT, NULLABLE | 修订血缘，必须指向同一 artifact 的旧 Revision |
| `created_by` | String(100) | NOT NULL | |
| `command_id` | String(160) | NOT NULL | 创建本 Revision 的幂等键 |
| `created_at` | DateTime | NOT NULL | |

唯一约束：`uq_artifact_revisions_artifact_number` (artifact_id, revision_number)；
`uq_artifact_revisions_command` (artifact_id, command_id)。
索引：`ix_artifact_revisions_current` (artifact_id, revision_number DESC);
`ix_artifact_revisions_blob` (storage_blob_id);
`ix_artifact_revisions_supersedes` (supersedes_revision_id)。

不变量：

1. 写入顺序：staging → fsync → no-clobber publish → 重算校验 → DB 事务
   （blobs → records → revisions）；任何一步失败都不存在“有 DB 行但内容
   缺失/不符”的 Artifact。
2. 内容不可变；修改产物 = 新 Revision，旧 Revision 保留。
3. `retained` 只表示产物仍可检查，不表示已合入活动仓库。
4. blob 被任何 `artifact_revisions` 引用即禁止 GC，与 Artifact 业务状态无关；
   `retained`/`discarded` 的 Artifact 只要仍被 committed Claim 引用，其 blob
   同样不可删除（引用查询不看业务状态）。
5. SD4 不做自动清理；GC 只处理 orphan，不处理有引用的 blob。
6. 一个 ArtifactRevision 至多作为一个 CompletionClaim 的主交付物。当前
   Revision 存在 candidate Claim 时禁止追加；修改前必须在同一事务先把旧 Claim
   supersede/reject。追加新 Revision 会把 ArtifactRecord.status 重置 candidate 并
   递增 row_version；旧 Revision 的处置历史仍由原 ResultCommit 保留。

### 4.5 `evidence_observations`

一份不可变的观察材料及其来源与有效性。Observation 不直接表达“支持/反对某
声明”；那是 Assessment 的职责。同一 Observation 可被任意多个 Claim 的
Requirement 通过 Assessment 复用，内容不复制。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `scope_id` | String(100) | NOT NULL, INDEX | |
| `kind` | String(40) | NOT NULL, CHECK IN ('validation_result','file_hash_match','tool_receipt','model_output_adoption','human_confirmation','external_observation') | |
| `schema_version` | String(40) | NOT NULL | payload schema 版本，例如 `validation-result-v1` |
| `payload_json` | JSON | NOT NULL | 经 kind+schema_version 校验的结构化 Observation，不可变 |
| `subject_kind` | String(40) | NOT NULL, CHECK IN ('work_item','action_item','artifact_revision') | 材料描述的对象 |
| `subject_id` | String(100) | NOT NULL | 写入事务内校验存在且同 scope |
| `validity` | String(20) | NOT NULL, CHECK IN ('valid','stale','unavailable','revoked','unverifiable') | 来源是否仍可验证；唯一可变字段 |
| `artifact_revision_id` | String(36) | FK→artifact_revisions.id ON DELETE RESTRICT, NULLABLE | 关联报告或 Diff |
| `product_run_id` | String(36) | FK→product_runs.id ON DELETE RESTRICT, NULLABLE | 来源 Run |
| `run_attempt_id` | String(36) | FK→run_attempts.id ON DELETE RESTRICT, NULLABLE | 来源 Attempt |
| `tool_operation_id` | String(36) | FK→tool_operations.id ON DELETE RESTRICT, NULLABLE | 来源 Tool Operation |
| `model_call_attempt_id` | String(36) | FK→model_call_attempts.id ON DELETE RESTRICT, NULLABLE | 来源模型调用 |
| `validation_run_id` | String(36) | FK→validation_runs.id ON DELETE RESTRICT, NULLABLE | 来源 Validation Run |
| `repository_snapshot_id` | String(36) | FK→repository_snapshots.id ON DELETE RESTRICT, NULLABLE | 绑定的精确来源 Snapshot |
| `decision_record_id` | String(36) | FK→decision_records.id ON DELETE RESTRICT, NULLABLE | 材料产生/确认时绑定的 Decision（如人工确认） |
| `verification_method` | String(80) | NULL | 如何校验 |
| `verified_at` | DateTime | NULL | 何时校验 |
| `statement` | Text | NOT NULL | 这份材料记录了什么，一句话 |
| `row_version` | Integer | NOT NULL, DEFAULT 1, CHECK >=1 | CAS（仅 validity 更新使用） |
| `command_id` | String(160) | NOT NULL | 写入命令幂等键：`evidence:<uuid>` |
| `created_at` | DateTime | NOT NULL | |
| `updated_at` | DateTime | NOT NULL | |

CHECK：`CHECK (product_run_id IS NOT NULL OR run_attempt_id IS NOT NULL OR tool_operation_id IS NOT NULL OR model_call_attempt_id IS NOT NULL OR validation_run_id IS NOT NULL OR repository_snapshot_id IS NOT NULL OR decision_record_id IS NOT NULL)`（每份材料至少有一个可定位来源）。

唯一约束：`uq_evidence_observations_command` (scope_id, command_id)。
索引：`ix_evidence_obs_subject` (subject_kind, subject_id, validity);
`ix_evidence_obs_run` (product_run_id, created_at);
`ix_evidence_obs_validity` (validity, updated_at);
`ix_evidence_obs_validation_run` (validation_run_id)。

不变量：

1. `payload_json`、`subject_*`、来源 FK、`statement` 创建后不可变；只有
   `validity` 可由 SourceInvalidation 事件驱动更新（CAS + row_version）。
2. Observation 只能由 Workflow/Validator/确定性服务创建；人工确认类由
   绑定 DecisionRecord 的服务端命令创建，普通用户不能 POST 伪造（见 13.1）。
3. 模型输出只能形成 `model_output_adoption` 材料；它可满足“已产生候选文本”这类
   显式 Requirement，但 Contract 模板禁止它替代代码任务的 mandatory
   validation_result/file_hash_match。模型自述不能单独证明完成。
4. 历史材料不随来源删除而删除，只改变 `validity`（架构不变量）。

### 4.6 `completion_claims`

一次“某 subject 应推进到某目标状态”的声明候选。Claim 显式绑定 subject、
期望版本与目标迁移，ResultCommit 只能执行协议允许的迁移，不能无条件把整个
Work 标成 `completed`。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `scope_id` | String(100) | NOT NULL, INDEX | |
| `subject_kind` | String(40) | NOT NULL, CHECK IN ('work_item','action_item') | 声明对象类型 |
| `subject_id` | String(36) | NOT NULL | 写入事务内校验存在且同 scope；不建跨表硬 FK（泛型引用，应用层完整性） |
| `expected_subject_version` | Integer | NOT NULL | 创建时读到的 subject row_version；ResultCommit 据此 CAS |
| `from_state` | String(32) | NOT NULL | 创建时 subject 的状态，例如 `in_progress` |
| `target_transition` | String(40) | NOT NULL | 协议迁移名，例如 `action_result_accepted`、`work_completed` |
| `target_state` | String(32) | NOT NULL | 迁移目标状态，必须来自现有 Harness 状态机 |
| `validation_contract_id` | String(36) | FK→validation_contracts.id ON DELETE RESTRICT, NULLABLE | 代码执行 Claim 必填；非验证型 Claim 可空 |
| `artifact_revision_id` | String(36) | FK→artifact_revisions.id ON DELETE RESTRICT, NULLABLE | 本次声明要交付的 Artifact Revision |
| `expected_artifact_record_version` | Integer | NULLABLE, CHECK >=1 | 有 Artifact 时必填；创建 Claim 时读到的 ArtifactRecord row_version |
| `repository_snapshot_id` | String(36) | FK→repository_snapshots.id ON DELETE RESTRICT, NULLABLE | 声明绑定的基线 Snapshot；用于 applicability 检查 |
| `applicability_policy` | String(32) | NOT NULL, CHECK IN ('record_only','must_match_current_target') | SD4 Action 接受为 record_only；SD5 合入/最终关闭代码 Work 才能用 must_match_current_target |
| `claim_hash` | String(64) | NOT NULL | 声明内容 Hash（subject、目标迁移、requirement 集合、contract、artifact revision/version、snapshot、applicability policy） |
| `status` | String(32) | NOT NULL, CHECK IN ('candidate','committed','rejected','superseded') | 见 6.3 状态机 |
| `decision_record_id` | String(36) | FK→decision_records.id ON DELETE RESTRICT, NULLABLE | 解决（commit/reject/supersede）时绑定的 Decision |
| `row_version` | Integer | NOT NULL, DEFAULT 1, CHECK >=1 | CAS |
| `command_id` | String(160) | NOT NULL | 幂等键 |
| `created_at` | DateTime | NOT NULL | |
| `updated_at` | DateTime | NOT NULL | |

CHECK：`CHECK (status = 'candidate' OR decision_record_id IS NOT NULL)`——
已解决的 Claim 必须绑定 Decision。
同表 CHECK：`artifact_revision_id` 与 `expected_artifact_record_version` 必须同时为空或
同时非空；`applicability_policy='must_match_current_target'` 时
`repository_snapshot_id` 必须非空。

唯一约束：`uq_completion_claims_command` (scope_id, command_id);
`uq_completion_claim_artifact_revision` (artifact_revision_id)（NULL 可重复）；
`claim_hash` 只建普通索引，不做 UNIQUE：相同内容在拒绝、过期或重新批准后可以
形成新的 Claim，但若复用同一 Artifact 内容必须创建新 Revision（Blob 可去重）；
请求幂等只由 `(scope_id, command_id)` 保证。
索引：`ix_completion_claims_subject` (subject_kind, subject_id, status, updated_at);
`ix_completion_claims_artifact` (artifact_revision_id);
`ix_completion_claims_snapshot` (repository_snapshot_id, status)；
`ix_completion_claims_hash` (scope_id, claim_hash, created_at)。

`repository_snapshot_id` 始终记录验证基线；只有
`applicability_policy='must_match_current_target'` 才在提交门比较当前目标。
目标 Snapshot 前进不产生 SourceInvalidation，也不改变任何 Observation 的
validity（见第 3 节隔离规则）。

subject 迁移协议（SD4）不新增 Harness 状态：

- `target_transition='action_result_accepted'`：只允许
  `ActionItem in_progress → completed`。该 Action 表达“在隔离 Workspace 中实现并
  验证结果”；Action 完成不表示代码已合入，父 Work 保持 `in_progress`，且
  `applicability_policy` 必须为 `record_only`。
- 代码任务若需要合入，SD5 创建/推进独立的 Integration Action；合入成功后才可
  评估父 Work 是否满足 `in_progress → completed`。UI 的“等待合入”来自
  `Artifact accepted + Workspace retained + 父 Work in_progress` 的投影，不伪造
  一个新的 Work 状态。
- `target_transition='work_completed'`：只允许现有
  `WorkItem in_progress → completed`，并要求所有 mandatory Action 已完成、没有待
  合入 Artifact；纯文档/调研可在同样条件下关闭 Work。
- ResultCommit Coordinator 必须调用一个接收现有 Unit of Work/AsyncSession 的
  Harness 事务参与者；不得调用会自行 `begin()` 的公开 Harness Service，否则
  无法保证 ResultCommit 与 subject 迁移原子。

### 4.7 `completion_claim_requirements`

Claim 的关系型 Requirement 集合。替代旧的 `required_evidence_refs_json`；
Requirement 是行，不再把 ID 列表塞进 JSON。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `scope_id` | String(100) | NOT NULL, INDEX | |
| `completion_claim_id` | String(36) | FK→completion_claims.id ON DELETE RESTRICT, NOT NULL | |
| `requirement_index` | Integer | NOT NULL, CHECK >=0 | Claim 内序号 |
| `requirement_kind` | String(40) | NOT NULL, CHECK IN ('validation_result','file_hash_match','tool_receipt','model_output_adoption','human_confirmation','external_observation') | 需要的 Observation 类型 |
| `mandatory` | Boolean | NOT NULL, DEFAULT true | |
| `description` | Text | NOT NULL | 人类可读要求 |
| `contract_rule_ordinal` | Integer | NULL | 对应 ValidationContract 规则序号 |
| `params_json` | JSON | NOT NULL, DEFAULT {} | 经 requirement_kind+schema_version 校验的 typed 参数（如 target_path） |
| `schema_version` | String(40) | NOT NULL | params schema 版本 |
| `created_at` | DateTime | NOT NULL | |

唯一约束：`uq_claim_requirement_index` (completion_claim_id, requirement_index)。
索引：`ix_claim_requirements_claim` (completion_claim_id)。

不变量：Requirement 随 Claim 创建后不可变；修改要求 = 新 Claim（旧 Claim
转 `superseded`）。

### 4.8 `evidence_assessments`

某 Observation 针对某 Claim 的某 Requirement 的结构化结论。替代旧的单一
`verdict` 字段；同一 Observation 可对不同 Requirement 有不同结论。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `scope_id` | String(100) | NOT NULL, INDEX | |
| `observation_id` | String(36) | FK→evidence_observations.id ON DELETE RESTRICT, NOT NULL | |
| `requirement_id` | String(36) | FK→completion_claim_requirements.id ON DELETE RESTRICT, NOT NULL | 同事务校验与 observation 同 scope |
| `verdict` | String(20) | NOT NULL, CHECK IN ('supports','refutes','inconclusive') | |
| `assessment_sequence` | Integer | NOT NULL, CHECK >=1 | Requirement 内严格单调序号；不用时间戳决定“当前” |
| `supersedes_assessment_id` | String(36) | FK→evidence_assessments.id ON DELETE RESTRICT, NULLABLE | 必须指向同一 Requirement 的前一 Assessment |
| `assessor_kind` | String(20) | NOT NULL, CHECK IN ('validator','workflow','human') | 谁下的结论 |
| `assessor_run_id` | String(36) | FK→product_runs.id ON DELETE RESTRICT, NULLABLE | assessor 所在 Run |
| `assessor_principal_id` | String(100) | NULLABLE | 人工 Assessment 的主体；服务端 Assessment 留空 |
| `decision_record_id` | String(36) | FK→decision_records.id ON DELETE RESTRICT, NULLABLE | 人工 Assessment 必填，并绑定当前 Observation/Requirement Hash |
| `rationale` | Text | NULL | 一句话理由（不存模型隐藏推理） |
| `command_id` | String(160) | NOT NULL | 幂等键 |
| `created_at` | DateTime | NOT NULL | |

唯一约束：`uq_assessment_observation_requirement` (observation_id, requirement_id)——
同一 Observation 对同一 Requirement 只评估一次；重新验证 = 新 Observation +
新 Assessment。`uq_assessment_requirement_sequence` (requirement_id, assessment_sequence)；
`uq_assessments_command` (scope_id, command_id)。
索引：`ix_assessments_requirement` (requirement_id, created_at);
`ix_assessments_observation` (observation_id)。

不变量：Assessment 创建后不可变。“当前结论”= 该 Requirement 下
`assessment_sequence` 最大的 Assessment；新增时锁定 Requirement，校验
`supersedes_assessment_id` 指向当前末项，再以 UNIQUE 兜底并发。Adoption 只能
指向当时的当前 `supports` Assessment；ResultCommit 会再次确认它仍是当前项。
若 Adoption 后出现更新 Assessment，旧 Claim 必须被 supersede 并创建新 Claim，
不能改写既有 Adoption。
`assessor_kind='human'` 要求 principal 与 DecisionRecord 均非空；validator/
workflow 要求 `assessor_run_id` 非空，不能用匿名字符串冒充评估主体。

### 4.9 `claim_evidence_adoptions`

Claim 采用哪个 Assessment 作为某 Requirement 的完成依据，绑定批准 Decision。
替代旧的 `adopted_by_claim_id` 与 `adopted_evidence_ids_json`。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `scope_id` | String(100) | NOT NULL, INDEX | |
| `completion_claim_id` | String(36) | FK→completion_claims.id ON DELETE RESTRICT, NOT NULL | |
| `requirement_id` | String(36) | FK→completion_claim_requirements.id ON DELETE RESTRICT, NOT NULL | 必须属于同一 Claim，同事务校验 |
| `assessment_id` | String(36) | FK→evidence_assessments.id ON DELETE RESTRICT, NOT NULL | 必须指向同一 Requirement、当前且 verdict='supports' 的 Assessment，同事务校验 |
| `decision_record_id` | String(36) | FK→decision_records.id ON DELETE RESTRICT, NOT NULL | 采用批准 Decision（人工或有据自动推进） |
| `command_id` | String(160) | NOT NULL | 幂等键 |
| `created_at` | DateTime | NOT NULL | |

唯一约束：`uq_adoption_claim_requirement` (completion_claim_id, requirement_id)——
一个 Claim 的每个 Requirement 至多一条 Adoption。`uq_adoptions_command`
(scope_id, command_id)。
索引：`ix_adoptions_claim` (completion_claim_id);
`ix_adoptions_assessment` (assessment_id)。

不变量：Adoption 创建后不可变；`verdict='refutes'` 的 Assessment 不能被采用
（应用层 + 写入事务校验，违反即拒绝整事务）。

### 4.10 `requirement_waivers`

逐 Requirement 的豁免记录。没有“整 Work 豁免”这种 blanket waiver；一个 Claim
被豁免提交 = 其每个 mandatory Requirement 都有 Adoption 或 Waiver，且至少一条
Waiver。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `scope_id` | String(100) | NOT NULL, INDEX | |
| `requirement_id` | String(36) | FK→completion_claim_requirements.id ON DELETE RESTRICT, NOT NULL | |
| `decision_record_id` | String(36) | FK→decision_records.id ON DELETE RESTRICT, NOT NULL | 豁免批准 Decision |
| `reason` | Text | NOT NULL | 豁免理由 |
| `command_id` | String(160) | NOT NULL | 幂等键 |
| `created_at` | DateTime | NOT NULL | |

唯一约束：`uq_waiver_requirement` (requirement_id)——一个 Requirement 至多
一条豁免。`uq_waivers_command` (scope_id, command_id)。

豁免限制（应用不变量，见 9.3）：若该 Requirement 的**当前** Assessment
（assessment_sequence 最大）是 `refutes`，禁止对该 Requirement 豁免；用户必须重新
验证（新 Observation + 新 Assessment）或拒绝本 Claim。其他 Claim 的、或已被
更新 Assessment 取代的历史 `refutes` 不参与判断。

### 4.11 `result_commits`

Result Commit Gate 的产品事务记录。`completion_claim_id` 带 UNIQUE，Claim 的
ResultCommit 通过它反查；`completion_claims` 不保存 `result_commit_id`，无循环
FK。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `scope_id` | String(100) | NOT NULL, INDEX | |
| `completion_claim_id` | String(36) | FK→completion_claims.id ON DELETE RESTRICT, NOT NULL, UNIQUE | 一个 Claim 至多一次 Commit |
| `commit_status` | String(20) | NOT NULL, CHECK IN ('accepted','rejected','waived') | |
| `artifact_disposition` | String(20) | NOT NULL, CHECK IN ('accepted','rejected','not_adopted','none') | 与 Claim 结局正交；Claim waived 时 Artifact 仍可能被接受 |
| `pre_commit_validity_check_passed` | Boolean | NOT NULL, DEFAULT false | accepted/waived 提交前，全部已采用证据复检结果；全 Waiver 时为真（空集通过） |
| `decision_record_id` | String(36) | FK→decision_records.id ON DELETE RESTRICT, NOT NULL | |
| `committed_subject_state` | String(32) | NULL | 实际推进到的 subject 状态（审计快照） |
| `command_id` | String(160) | NOT NULL | 幂等键 |
| `created_at` | DateTime | NOT NULL | |

CHECK：`CHECK (commit_status = 'rejected' OR pre_commit_validity_check_passed)`——
accepted/waived 提交都必须复检通过。`artifact_disposition` 与 Claim 是否绑定
Artifact 属跨表条件，不能伪称为数据库 CHECK；由 ResultCommit Coordinator 在
同一事务校验：无 Artifact 时只能 none；有 Artifact 且仍是当前 Revision 时不能
none；rejected Claim 对当前 Revision 使用 rejected，若该 Revision 已被合法替代
则允许 none，并以合同测试锁定。

唯一约束：`uq_result_commits_command` (scope_id, command_id)。
索引：`ix_result_commits_status` (commit_status, created_at)。

ResultCommit 创建后不可变；`waived` 也是一种解决结局，不修改、不补交。

### 4.12 `validation_capabilities`

版本化验证能力目录。ValidationRunner 不再接受“executable_key + 任意 argv”；
Contract 只能引用目录中的 Capability 并按其参数 schema 填参。目录行由服务端
代码随版本播种（seed），内容寻址，运行时不可由模型或用户创建。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `scope_id` | String(100) | NOT NULL, INDEX | 系统级能力用保留 scope `system`；scope 级覆盖必须同 scope |
| `capability_key` | String(80) | NOT NULL | 例如 `pytest-suite` |
| `capability_version` | String(40) | NOT NULL | 语义版本 |
| `capability_hash` | String(64) | NOT NULL | 能力定义内容 Hash |
| `executable_policy` | String(40) | NOT NULL, CHECK IN ('project_venv_python','pinned_binary','builtin') | `project_venv_python` = 只允许项目虚拟环境解释器；**禁止 `which`/系统 Python 回退**；`pinned_binary` 的绝对路径在服务启动时由私有运行配置解析并校验存在，不落库 |
| `executable_ref` | String(100) | NOT NULL | 逻辑可执行引用：如 `project-python`、`git-readonly`、`builtin-diff`；由服务端 Resolver 映射，不能由请求传绝对路径 |
| `renderer_key` | String(100) | NOT NULL | 代码内已注册的参数渲染器及版本，如 `pytest-targets-v1`；决定如何把 typed params 变成 argv |
| `argv_prefix_json` | JSON | NOT NULL | 固定 argv 前缀，例如 `["-m","pytest"]`；Runner 不解析 Shell |
| `params_schema_json` | JSON | NOT NULL | 允许参数的 JSON Schema（如测试目标路径集合、`-k` 表达式的字符白名单）；schema 之外的参数一律拒绝 |
| `allowed_paths_policy` | String(40) | NOT NULL, CHECK IN ('workspace_only','workspace_plus_declared_read') | 可触路径边界 |
| `side_effect_class` | String(20) | NOT NULL, CHECK IN ('readonly','temp_write') | `temp_write` 只允许 Workspace 受控临时目录 |
| `network_policy` | String(20) | NOT NULL, CHECK IN ('deny','allowlist') | `allowlist` 仅是能力上限；实际放行仍要 Contract 声明 + 系统策略 + HITL + 可执行 egress sandbox（见 8.3） |
| `egress_allowlist_json` | JSON | NOT NULL, DEFAULT [] | 允许的目的主机/端口 |
| `resource_limits_json` | JSON | NOT NULL | timeout、CPU、内存、子进程数、输出字节上限 |
| `sandbox_requirement` | String(40) | NOT NULL | 例如 `seatbelt`（macOS）/ `bwrap`（Linux）/ `none`；`none` 且 network_policy != 'deny' 时该能力不可用（fail closed） |
| `redaction_baseline_json` | JSON | NOT NULL | 系统脱敏基线（密钥/token/路径模式）；**模型与用户不可移除**，Contract 只能追加 |
| `status` | String(20) | NOT NULL, CHECK IN ('active','deprecated') | |
| `row_version` | Integer | NOT NULL, DEFAULT 1, CHECK >=1 | CAS（仅 status 流转使用） |
| `created_at` | DateTime | NOT NULL | |
| `updated_at` | DateTime | NOT NULL | |

唯一约束：`uq_validation_capabilities_key_version` (scope_id, capability_key, capability_version);
`uq_validation_capabilities_hash` (scope_id, capability_hash)。

`capability_hash` 覆盖 executable_policy/ref、renderer_key、argv prefix、参数
Schema、路径/副作用/网络/资源/sandbox/脱敏策略的规范化内容。任何一项变化都
产生新 capability_version/hash，既有 RunSpec 不漂移。JSON Schema 只负责验证
参数形状；只有 `renderer_key` 指向的代码内纯函数可以决定参数顺序与 argv 展开，
不能把 JSON 值直接拼进命令行。

示例能力 `pytest-suite` v1：`argv_prefix=["-m","pytest"]`，params 只允许
`targets`（workspace 内相对路径数组）与 `extra_args`（枚举 `["-x","-q","--tb=short"]`）。
展开后 argv 形态固定为 `python -m pytest <targets...> <extra_args...>`；
`python -c`、`git clean`、`uv run 任意程序` 这类形态在 schema 之外，无法表达。

### 4.13 `validation_contracts`

Planner 在 Plan Candidate 中声明的验证合同，随 ExecutionDraft 接受编译进不可变
RunSpec，并以 Hash 绑定。Contract 只填 Capability 参数 schema 允许的参数；
展开后的 exact argv 与其 Hash 进入 RunSpec 与 Approval 内容。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `scope_id` | String(100) | NOT NULL, INDEX | |
| `plan_revision_id` | String(36) | FK→task_plan_revisions.id ON DELETE RESTRICT, NOT NULL | 来源 Plan Revision |
| `contract_hash` | String(64) | NOT NULL | 合同内容 Hash |
| `schema_version` | String(40) | NOT NULL | `validation-contract-v2` |
| `rules_json` | JSON | NOT NULL | 规则数组，每项含 capability_key、capability_version、params、展开后 exact argv 与 argv_hash |
| `requires_integration` | Boolean | NOT NULL, DEFAULT true | `false` 时允许 Claim 以 `completed` 为目标（见 4.6） |
| `max_repair_cycles` | Integer | NOT NULL, DEFAULT 2, CHECK BETWEEN 0 AND 5 | 修复预算 |
| `network_requested` | Boolean | NOT NULL, DEFAULT false | 仅是请求；放行条件见 8.3 |
| `created_by` | String(100) | NOT NULL | |
| `command_id` | String(160) | NOT NULL | 创建 Contract 的幂等键 |
| `created_at` | DateTime | NOT NULL | |

唯一约束：`uq_validation_contracts_command` (scope_id, command_id)。
索引：`ix_validation_contracts_hash` (scope_id, contract_hash, created_at)。相同合同
内容可以来自不同 Plan Revision，不能用 Hash UNIQUE 把二者错误合并。

`rules_json` 示例：

```json
{
  "rules": [
    {
      "ordinal": 1,
      "capability_key": "pytest-suite",
      "capability_version": "1.0.0",
      "capability_hash": "9f2c...",
      "params": {"targets": ["backend/tests"], "extra_args": ["-x", "-q"]},
      "expanded_argv": ["-m", "pytest", "backend/tests", "-x", "-q"],
      "expanded_argv_hash": "41ab...",
      "expected_exit_code": 0
    }
  ]
}
```

Requirement 不再内嵌在 Contract 的 JSON 里引用 Evidence ID；Contract 只声明
“需要哪类 Observation、来自哪条规则”，Claim 创建时编译成
`completion_claim_requirements` 行（`contract_rule_ordinal` 回指规则）。

### 4.14 `validation_runs`

一次验证命令的执行记录。验证是**确定性系统操作**，不是模型 Tool 调用。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `scope_id` | String(100) | NOT NULL, INDEX | |
| `workspace_id` | String(36) | FK→execution_workspaces.id ON DELETE RESTRICT, NOT NULL | 受管 Workspace |
| `repository_snapshot_id` | String(36) | FK→repository_snapshots.id ON DELETE RESTRICT, NOT NULL | 本次验证针对的精确 Snapshot |
| `validation_contract_id` | String(36) | FK→validation_contracts.id ON DELETE RESTRICT, NOT NULL | |
| `contract_hash` | String(64) | NOT NULL | 执行前复检的合同 Hash |
| `rule_ordinal` | Integer | NOT NULL | 执行的合同规则序号 |
| `capability_key` | String(80) | NOT NULL | |
| `capability_version` | String(40) | NOT NULL | |
| `capability_hash` | String(64) | NOT NULL | Worker 领取时与目录行复检 |
| `resolved_executable_hash` | String(64) | NOT NULL | 实际解释器/二进制内容 Hash；路径不进入浏览器 |
| `environment_fingerprint` | String(64) | NOT NULL | 项目锁文件、解释器与验证依赖的规范化指纹 |
| `expanded_argv_json` | JSON | NOT NULL | 展开后的 exact argv，与合同 argv_hash 一致 |
| `expanded_argv_hash` | String(64) | NOT NULL | exact argv 规范化 Hash |
| `working_dir` | String(240) | NOT NULL | 必须落在 workspace 内 |
| `repair_cycle` | Integer | NOT NULL, DEFAULT 0, CHECK >=0 | 修复轮次 |
| `runtime_job_id` | String(36) | FK→runtime_jobs.id ON DELETE RESTRICT, NOT NULL | 所属 Runtime Job |
| `run_attempt_id` | String(36) | FK→run_attempts.id ON DELETE RESTRICT, NOT NULL | 所属 Attempt |
| `runtime_lease_epoch` | Integer | NOT NULL | Worker 领取时快照 `runtime_jobs.lease_epoch`；回报时不匹配即拒收。现有 RunAttempt 没有 epoch，不能虚构 Attempt fence |
| `status` | String(32) | NOT NULL, CHECK IN ('pending','running','passed','failed','timeout','error','cancelled','outcome_unknown') | 见 6.5 状态机 |
| `exit_code` | Integer | NULL | |
| `started_at` | DateTime | NULL | |
| `finished_at` | DateTime | NULL | |
| `duration_ms` | Integer | NULL, CHECK >=0 | |
| `report_artifact_revision_id` | String(36) | FK→artifact_revisions.id ON DELETE RESTRICT, NULLABLE | 完整报告 Artifact |
| `stdout_tail` | Text | NULL | 截断并脱敏后的尾部 |
| `stderr_tail` | Text | NULL | |
| `row_version` | Integer | NOT NULL, DEFAULT 1, CHECK >=1 | |
| `command_id` | String(160) | NOT NULL | 创建 ValidationRun 的幂等键 |
| `outcome_command_id` | String(160) | NULL | 首次被接受的结果回报幂等键；重复同内容返回原结果，不同内容冲突 |
| `outcome_hash` | String(64) | NULL | 首次受理结果的规范化 Hash，用于区分同幂等键下相同/冲突回报 |
| `created_at` | DateTime | NOT NULL | |
| `updated_at` | DateTime | NOT NULL | |

状态依赖 CHECK：`pending` 要求 started_at/finished_at 为空；`running` 要求
started_at 非空且 finished_at 为空；所有终态要求 finished_at 非空；
`passed/failed` 额外要求 exit_code 非空；`outcome_unknown` 不允许凭空进入 passed。

唯一约束：`uq_validation_runs_command` (scope_id, command_id)；
`uq_validation_runs_outcome_command` (scope_id, outcome_command_id)（NULL 可重复）。
索引：`ix_validation_runs_contract` (validation_contract_id, rule_ordinal, repair_cycle);
`ix_validation_runs_status` (status, created_at);
`ix_validation_runs_workspace` (workspace_id, status);
`ix_validation_runs_attempt` (run_attempt_id, runtime_lease_epoch)。

不变量：

1. 执行的 exact argv 与 Contract 展开结果逐字一致；Transport 不改写。
2. 创建按 `command_id` 幂等、回报按 `outcome_command_id` 幂等；
   `runtime_lease_epoch` 不匹配的回报拒绝并记审计。
3. `outcome_unknown` 不是失败也不是成功：进程/Worker 死亡且无法确认子进程
   是否执行过时使用；**不自动重跑**。处置见 9.4。
4. 只有能证明从未启动（`started_at IS NULL` 且 lease 未发出，或有 fence 证据）
   的 `pending` Run 才允许被安全重领。

### 4.15 `provenance_edges`

W3C PROV 最小关系集的有向边，只承载强类型 FK 无法回答的跨模块关系
（见 4.15.2）。边只增不改；失效通过 `invalidated_by` 新边表达，不删除历史边。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `scope_id` | String(100) | NOT NULL, INDEX | |
| `source_kind` | String(40) | NOT NULL, CHECK IN ('artifact_revision','evidence_observation','evidence_assessment','claim_evidence_adoption','requirement_waiver','validation_run','completion_claim','result_commit','tool_operation','product_run','run_attempt') | 见允许矩阵 |
| `source_id` | String(100) | NOT NULL | generic 引用；写入事务内校验存在且同 scope |
| `relation` | String(32) | NOT NULL, CHECK IN ('derived_from','generated_by','used','attributed_to','invalidated_by') | |
| `target_kind` | String(40) | NOT NULL, CHECK IN ('artifact_revision','evidence_observation','evidence_assessment','claim_evidence_adoption','requirement_waiver','validation_run','execution_workspace','repository_snapshot','decision_record','work_item','action_item','source_invalidation','completion_claim','result_commit','tool_operation','product_run','run_attempt') | 见允许矩阵 |
| `target_id` | String(100) | NOT NULL | generic 引用；写入事务内校验存在且同 scope |
| `product_run_id` | String(36) | FK→product_runs.id ON DELETE RESTRICT, NULLABLE | 产生该边的 Run |
| `decision_record_id` | String(36) | FK→decision_records.id ON DELETE RESTRICT, NULLABLE | 授权 Decision |
| `created_at` | DateTime | NOT NULL | |

唯一约束：`uq_provenance_edge` (scope_id, source_kind, source_id, relation, target_kind, target_id)。
索引：`ix_provenance_source` (scope_id, source_kind, source_id);
`ix_provenance_target` (scope_id, target_kind, target_id);
`ix_provenance_run` (product_run_id, created_at)。

generic 引用完整性策略：`source_id`/`target_id` 是跨表泛型引用，无法用单个
硬 FK 表达。写入方（Application Coordinator）必须通过按 kind 注册的
`OwnershipResolver` 在同一事务内查询目标并解析 scope：新 F02/Harness/
Repository 对象直接读 `scope_id`，ProductRun/RunAttempt 通过 ProductSession
解析，DecisionRecord 通过 DecisionSubject→ProductSession 解析。不能假设既有
每张表都有 `scope_id`。目标不存在、resolver 未注册或解析后跨 scope，直接拒绝
整事务。被引用行
一律 `ON DELETE RESTRICT`（或在有 generic 引用的情况下禁止物理删除），
失效用新边表达，不做级联删除。

#### 4.15.1 允许的 source_kind / target_kind / relation 矩阵

| relation | 允许 source_kind | 允许 target_kind | 方向语义（source → target） |
|---|---|---|---|
| `derived_from` | `artifact_revision`, `evidence_observation` | `artifact_revision`, `evidence_observation`, `repository_snapshot` | source 从 target 派生；仅在没有直接 FK 时写 |
| `generated_by` | `artifact_revision` | `validation_run`, `tool_operation`, `product_run`, `run_attempt` | source 由 target 生成；Observation 已有来源 FK，不重复写 |
| `used` | `validation_run`, `tool_operation`, `product_run`, `run_attempt` | `artifact_revision`, `decision_record` | source 使用了 target；已有 workspace/snapshot/claim FK 的关系禁止重复写边 |
| `attributed_to` | `artifact_revision`, `evidence_observation`, `evidence_assessment`, `claim_evidence_adoption`, `requirement_waiver`, `result_commit` | `work_item`, `action_item`, `completion_claim`, `decision_record` | source 归属于 target |
| `invalidated_by` | `evidence_observation`, `artifact_revision` | `source_invalidation` | source 被一条追加式失效事件影响；Snapshot 本身不是“失效者” |

禁止反向写：例如不能把 `work_item` 作为 `used` 的 source；不能把
`completion_claim` 作为 `generated_by` 的 source。Application Coordinator
还必须拒绝“该关系已有强类型 FK”时的重复边，避免双事实源。

#### 4.15.2 强类型 FK 回答的关系（不建边）

以下 S1 链路跳数由 FK 直接回答，权威、可 JOIN；Provenance 边只补充跨模块
attribution/invalidation：

| 链路跳 | 权威来源 |
|---|---|
| RepositorySnapshot → ValidationRun | `validation_runs.repository_snapshot_id` |
| ValidationRun → EvidenceObservation | `evidence_observations.validation_run_id` |
| Observation → Assessment → Claim Requirement | `evidence_assessments.observation_id` / `.requirement_id` |
| Requirement → CompletionClaim | `completion_claim_requirements.completion_claim_id` |
| Claim → Adoption → Decision | `claim_evidence_adoptions.completion_claim_id` / `.decision_record_id` |
| Requirement → Waiver → Decision | `requirement_waivers.requirement_id` / `.decision_record_id` |
| CompletionClaim → ResultCommit | `result_commits.completion_claim_id`（UNIQUE 反查） |
| ResultCommit → Decision | `result_commits.decision_record_id` |
| CompletionClaim → subject 迁移 | `completion_claims.subject_kind/subject_id/target_transition` + ResultCommit 事务内 CAS |
| ArtifactRevision → Claim/Commit | `completion_claims.artifact_revision_id` |
| Observation → Tool/ModelCall/Run | `evidence_observations.tool_operation_id` 等来源 FK |

### 4.16 `source_invalidations`

来源失效/恢复事件记录。事件是**追加式日志**，同一来源可以多次失效与恢复；
不用 `(source, kind)` 永久唯一把第一次失效钉死。

| 字段 | 类型 | 约束 | 说明 |
|---|---|---|---|
| `id` | String(36) | PK | UUID |
| `scope_id` | String(100) | NOT NULL, INDEX | |
| `source_kind` | String(40) | NOT NULL, CHECK IN ('artifact_blob','repository_snapshot','artifact_revision','evidence_observation') | Blob 损坏可一次影响同 scope 多个 Revision；F06 的 ContextSource 对象确认后再扩 enum |
| `source_id` | String(100) | NOT NULL | 写入事务内校验存在且同 scope |
| `sequence` | Integer | NOT NULL, CHECK >=1 | 同一 (source_kind, source_id) 内单调递增 |
| `invalidation_kind` | String(20) | NOT NULL, CHECK IN ('stale','unavailable','revoked','recovered') | `recovered` 表示重验后恢复 |
| `recovers_invalidation_id` | String(36) | FK→source_invalidations.id ON DELETE RESTRICT, NULLABLE | recovered 必填，且必须指向同一来源的 stale/unavailable 事件 |
| `previous_fingerprint` | String(64) | NULL | 旧版本或 Hash |
| `current_fingerprint` | String(64) | NULL | 新版本或 Hash；无法读取时为空 |
| `resolution` | String(20) | NOT NULL, CHECK IN ('pending','applied','dismissed') | |
| `resolution_decision_record_id` | String(36) | FK→decision_records.id ON DELETE RESTRICT, NULLABLE | |
| `row_version` | Integer | NOT NULL, DEFAULT 1, CHECK >=1 | |
| `command_id` | String(160) | NOT NULL | 幂等键 |
| `created_at` | DateTime | NOT NULL | |
| `updated_at` | DateTime | NOT NULL | |

CHECK：`CHECK (invalidation_kind != 'stale' OR current_fingerprint IS DISTINCT FROM previous_fingerprint)`——
stale 事件必须携带真实指纹变化，指纹没变不允许报 stale。

状态依赖 CHECK/不变量：`recovered` 与 `recovers_invalidation_id` 必须同时出现或
同时为空；`invalidation_kind='revoked'` 或 `resolution='dismissed'` 必须
绑定 DecisionRecord；`recovered` 必须引用同一来源的既有 stale/unavailable
sequence，并在同事务把受影响 Observation CAS 恢复为 `valid`。sequence 分配
通过锁定该来源最后一条事件 + UNIQUE 冲突重试，不能用无锁 `MAX+1`。

唯一约束：`uq_source_invalidation_sequence` (scope_id, source_kind, source_id, sequence);
`uq_source_invalidations_command` (scope_id, command_id)。
索引：`ix_source_invalidation_source` (source_kind, source_id, resolution);
`ix_source_invalidation_pending` (scope_id, resolution, created_at)。

SourceInvalidation Coordinator 在**同一 Product Store 事务**中追加事件，并 CAS
更新直接引用该 source 的 EvidenceObservation.validity；事件与 Evidence 不允许
出现“一个已提交、一个未提交”的窗口。Outbox 只发布给 Context、Memory 等派生
消费者（D11），不承担 Evidence 自身正确性。ResultCommit 还会检查采用链上是否
存在未解决的 pending invalidation，作为保守兜底。

**Snapshot 前进不产生本表记录**：活动仓库从 Snapshot A 前进到 B 时，A 本身
没有失效（不可变快照仍可访问、可按 Hash 验证），因此不创建任何
SourceInvalidation；只有 SD5 Integration 的 applicability 前置失败 + Trace 事件
（见第 3 节与失败矩阵 #6/#14）。`repository_snapshot` 作为 source_kind 只用于
快照内容被篡改、被删除或权限被撤这类**来源本身**不可验证的事件。

## 5. Payload Schema 与类型化细节

SD4 是代码纵向切片，但 Schema 必须为未来学习/研究 Evidence 留口。禁止用自由
JSON 逃避约束：每条 Observation 必须有 `kind` + `schema_version`，
`payload_json` 必须能通过对应 schema 校验；Requirement 的 `params_json` 同理。

### 5.1 `validation_result` schema v1

```json
{
  "capability_key": "pytest-suite",
  "expanded_argv": ["-m", "pytest", "backend/tests", "-x", "-q"],
  "working_dir": ".",
  "exit_code": 0,
  "signal": null,
  "summary": "42 passed, 0 failed",
  "duration_ms": 12500
}
```

### 5.2 `file_hash_match` schema v1

```json
{
  "path": "README.md",
  "preimage_hash": "047cc9ac...",
  "postimage_hash": "36d8447c...",
  "observed_hash": "36d8447c...",
  "match": true
}
```

### 5.3 `tool_receipt` schema v1

```json
{
  "tool_operation_id": "a04a1942...",
  "tool_name": "edit",
  "side_effect_class": "workspace_write",
  "preimage_hash": "047cc9ac...",
  "postimage_hash": "36d8447c...",
  "observed_hash": "36d8447c..."
}
```

### 5.4 `model_output_adoption` schema v1

```json
{
  "model_call_attempt_id": "...",
  "output_disposition": "accepted_as_response",
  "adopted_text_hash": "...",
  "adoption_scope": "message_only"
}
```

### 5.5 `human_confirmation` schema v1

```json
{
  "confirmed_by_principal_id": "local-user",
  "confirmation_text_hash": "...",
  "confirmation_kind": "result_accepted"
}
```

### 5.6 `external_observation` schema v1（SD4 留口，不实现执行器）

```json
{
  "observation_kind": "quiz_result",
  "external_source": "quiz-provider-v1",
  "result_summary": "8/10 correct",
  "external_reference": "quiz://..."
}
```

## 6. 状态机

### 6.1 `artifact_records` 状态机

```text
candidate -> accepted -> retained -> discarded
    |           |
    |           +-> discarded | candidate (append Revision)
    +-> rejected -> retained -> discarded
    |       |
    |       +-> discarded | candidate (append Revision)
    +-> not_adopted -> retained -> discarded
    |        |
    |        +-> discarded | candidate (append Revision)
    +-> discarded
```

| 状态 | 含义 |
|---|---|
| `candidate` | 已生成，等待 ResultCommit |
| `accepted` | 被 ResultCommit(accepted) 接受，作为交付物 |
| `rejected` | 被 ResultCommit(rejected) 拒绝，保留可检查 |
| `not_adopted` | Artifact 明确未被本次提交采用的已解决状态；仍可转 retained/discarded，不会永远停在 candidate |
| `retained` | 完成周期结束，仍可审计检查；不表示已合入 |
| `discarded` | 显式废弃（需 Decision），不再出现在默认查询；blob 是否可删只由引用与保留决定（见 4.4 不变量 4） |

合法迁移集合（未列出即非法）：

- `candidate → accepted | rejected | not_adopted | discarded`
- `accepted → retained | discarded`
- `rejected → retained | discarded`
- `not_adopted → retained | discarded`
- `accepted | rejected | not_adopted | retained → candidate` **仅允许与追加新
  Revision 同事务发生**；旧 Revision 结局保留，Record 表示新当前项待审
- `candidate → candidate` 仅允许“无 candidate Claim 时追加新 Revision”并递增版本
- `retained → discarded`

`rejected` 不是 `candidate`；`discarded` 是显式终态，与 `rejected`、
`not_adopted` 语义不同（拒绝=用户否决结果；未采用=结果未被本次声明使用；
废弃=主动清除展示）。

### 6.2 Evidence 语义关系（无单一“Evidence 状态”）

Evidence 语义由四张表组合表达，没有单行“状态”字段：

- Observation：材料 + `validity`（可变）；
- Assessment：Observation × Requirement → verdict（不可变，以 sequence/supersedes 串联）；
- Adoption：Claim × Requirement → assessment + Decision（不可变，唯一）；
- Waiver：Requirement → Decision + reason（不可变，唯一）。

合法组合（以“当前 Claim 当前 Requirement”为判断域）：

| 最新 Assessment verdict | Observation validity | Adoption/Waiver | 含义 |
|---|---|---|---|
| supports | valid | Adoption 存在 | 被采用的完成依据 |
| refutes | valid | 无 | 当前失败；阻断本 Claim 的 accepted 与本 Requirement 的 waiver，不阻断任何其他/未来 Claim |
| supports | stale | 任意 | 来源版本已变化但可重验；ResultCommit 因 validity 非 valid 而阻断；与 Integration applicability 无关 |
| supports | revoked | Adoption 存在 | 曾被采用，现被撤销；Work 事实保留但展示降级标记 |
| 无 Assessment / supports / inconclusive | 非 revoked | Waiver 存在 | 该 Requirement 被显式豁免；若当前为 refutes 则禁止 |
| inconclusive | unavailable | 无 | 来源暂时无法验证，不计入满足 |

非法组合：

- Adoption 指向 `verdict != 'supports'` 的 Assessment（写入事务拒绝）。
- Adoption/Waiver 与 Assessment 分属不同 Claim（写入事务拒绝）。
- `validity='revoked'` 且没有对应的 `source_invalidations` 事件。
- 同一 Requirement 同时存在 Adoption 与 Waiver（写入事务拒绝）。

### 6.3 `completion_claims` 状态机

```text
candidate -> committed
    |          （终态）
    +-> rejected   （终态）
    +-> superseded （被新 Claim 替代，保留审计，终态）
```

合法迁移集合：

- `candidate → committed | rejected | superseded`

已解决 Claim（非 candidate）必须有 `decision_record_id`（表级 CHECK，见 4.6）。
ResultCommit 通过 `result_commits.completion_claim_id` UNIQUE 反查，Claim 表无
反向 FK。

### 6.4 `result_commits` 状态机

ResultCommit 是单次事务记录，创建后不可变：

```text
accepted | rejected | waived   （均为终态）
```

`accepted` 必须满足 `pre_commit_validity_check_passed = true`（表级 CHECK）。
`waived` 同样要求复检全部已采用证据；`artifact_disposition` 不由 commit_status
机械推断：accepted/waived 可接受 Artifact，rejected 必须拒绝 Artifact，无
Artifact 时必须为 none。跨表组合由 Coordinator 同事务校验。

### 6.5 `validation_runs` 状态机

```text
pending -> running -> passed | failed | timeout | error | outcome_unknown
    |          |
    |          +-> cancelled
    +-> error | cancelled
```

合法迁移集合：

- `pending → running | error | cancelled`
- `running → passed | failed | timeout | error | outcome_unknown | cancelled`

| 状态 | 含义 |
|---|---|
| `pending` | 已创建，等待 Worker 领取 |
| `running` | 已领取，进程运行中（或 Worker 声称运行中） |
| `passed` | 退出码符合预期（CHECK 要求 finished_at + exit_code） |
| `failed` | 退出码不符合预期（同上） |
| `timeout` | 超时 |
| `error` | 已确认的执行失败：启动失败、资源限制、已确认子进程未执行等 |
| `outcome_unknown` | Worker/进程死亡且**无法确认**子进程是否执行过；终态，不自动重跑（处置见 9.4） |
| `cancelled` | 用户/系统取消 |

`outcome_unknown` 不能自动进入 `passed`/`failed`；需要确定性结论时创建**新的**
ValidationRun（新 command_id、新 repair_cycle 记账），旧 Run 保持
`outcome_unknown` 供审计。

### 6.6 `source_invalidations` 事件语义

不是状态机，是追加日志：`sequence` 在同一来源内单调递增；`stale` 可经
`recovered` 事件恢复；`revoked` 是终态（之后只允许 `applied/dismissed` 的
resolution 流转，不允许 recovered）。

## 7. Validation Contract 与修复预算

Validation Contract 由 Planner 在 Plan Candidate 中声明，随 ExecutionDraft
接受编译进不可变 RunSpec，并以 Hash 绑定：

规则：

1. `max_repair_cycles` 默认 2，硬上限 5；超出即 Run 以失败 Assessment 结束，
   Work 转 `blocked`，不自动重试。
2. 命令只能来自用户批准的 Plan 与 Capability Catalog；pi 或模型在运行中提出
   的新验证命令必须形成新的 Draft revision 重新审批，不能就地执行。
3. 验证在受管 Workspace 内执行；`network_requested=true` 只是请求，放行条件
   见 8.3，不满足即 fail closed。
4. 修复循环：验证失败 → 失败 Assessment（`refutes`，不被采用）→ 主 Workflow
   在预算内生成新 StepInput → 新 pi 执行 → 新 Diff/验证 → 新 Observation +
   新 Assessment；每轮都是独立 Approval 边界，不复用旧授权。

## 8. ValidationRunner 设计

ValidationRunner 是 Chat 确定性执行器，不是模型 Tool，也不是 F01 Operation
Ledger 的旁路。

### 8.1 Capability 解析与执行

```text
Contract rule (capability_key, capability_version, params)
-> Application Coordinator 加载 validation_capabilities 行（status='active'）
-> params 按 params_schema_json 校验；schema 之外任何参数拒绝
-> 展开 exact argv = argv_prefix + schema 允许参数，计算 argv_hash
-> 展开结果与 Hash 进入 RunSpec 与 Approval 内容
-> Worker 领取时再次校验 capability_hash 与 argv_hash（防目录被改后旧合同漂移）
-> executable_policy 解析可执行文件：
   - project_venv_python：项目虚拟环境解释器（如 .venv/bin/python），
     路径由服务端启动时解析并校验；禁止 which/系统 Python 回退
   - pinned_binary：服务启动时从私有运行配置读取绝对路径并校验存在
   - builtin：Runner 内置实现（如 diff）
-> 计算实际 executable 内容 Hash 与环境指纹（解释器、项目锁文件、验证依赖）；
   与 RunSpec 批准值不符时拒绝执行并要求新 Draft/Approval
-> subprocess execve(argv)，shell=False
```

### 8.2 安全约束

1. `shell=false`；argv 是字符串数组，不经过 Shell 解析。
2. `working_dir` 必须经 PathPolicy 校验后落在对应 Workspace 内；Capability 的
   `allowed_paths_policy` 进一步限制可触路径。注意：cwd 校验不能阻止进程读取
   Workspace 外文件，路径边界必须由 sandbox（8.3）执行，不能只靠 cwd。
3. 环境变量由 Capability/系统策略注入（如 PATH、虚拟环境变量），调用方不可
   覆盖；Contract 不允许声明自由环境变量。
4. 资源限制来自 Capability `resource_limits_json`：timeout、CPU、内存、子进程
   数、输出字节。
5. 敏感信息脱敏：系统基线 `redaction_baseline_json` 不可被模型/用户移除，
   Contract 只能追加模式；stdout/stderr 与报告 Artifact 入库前都按合并后的
   模式扫描并替换为 `[redacted]`。
6. 子进程由 Runner 直接 `execve` 启动，不经过 pi 或模型。
7. `side_effect_class='temp_write'` 的进程只允许写 Workspace 及其受控临时目录，
   由 Workspace Adapter 清理；`readonly` 进程不得写 Workspace。以上限制必须
   由 OS sandbox 执行，不能只相信 Capability 声明。

### 8.3 网络策略与 sandbox

所有外部进程型 Capability（`project_venv_python` / `pinned_binary`）都必须有
可执行的文件系统、子进程、资源与网络 sandbox；缺失时即使网络策略是 `deny`
也不可运行。`builtin` 只能调用 Runner 内已注册的实现，并接受同等 PathPolicy。

`network_policy='allowlist'` 只表示该 Capability 有放行上限。一次验证真正使用
网络必须同时满足：

1. Contract 声明 `network_requested=true` 并向用户展示；
2. 系统策略允许该 scope/能力使用网络；
3. HITL 批准（DecisionRecord）；
4. 存在**可执行的** egress sandbox：按 `sandbox_requirement`（macOS `seatbelt`、
   Linux `bwrap`/seccomp+netns 等）把进程限制在 `egress_allowlist_json` 的
   目的主机/端口内。

任一条件不满足即 **fail closed**（拒绝执行，ValidationRun 从 `pending` 置 `error`，原因
可查）。`sandbox_requirement='none'` 且需要网络的能力视为不可用；只写一个
布尔字段而不做 OS 级隔离是禁止的。

### 8.4 与 Runtime Job/Attempt、F01 Operation Ledger 的关系

```text
RunSpec.validation_contract
-> Runtime Job/Attempt 领取（runtime_jobs.lease_epoch 快照）
-> ValidationRunner 创建/领取 ValidationRun（绑定 Job/Attempt/lease_epoch/command_id）
-> ValidationRun 产生 Observation（经 Assessment 进入 Evidence 流程）
-> F01 Operation Ledger 只记录 Workspace 写副作用（如验证产生的临时文件）
-> ValidationRun 本身不是 ToolOperation；它不修改源码，只读取/运行
```

ValidationRunner 不能绕过 Operation Ledger 执行源码写操作；验证命令需要写临时
文件时必须写在 Workspace 受控临时目录，由 Workspace Adapter 清理。fence 规则
见 4.14 不变量 2 与 9.4。

## 9. Result Commit Gate（完成声明门）

完成声明是把“代码改了、测试过了”变成“subject 状态推进”的唯一入口，位于主
Workflow 的结果 Executor 之后、产品提交之前。

### 9.1 事务边界

ResultCommit Gate 是**单个 Product Store 事务**，但拒绝与接受/豁免的校验路径
不同；用户拒绝不能被证据缺失、Snapshot 前进或 subject CAS 反过来阻塞：

文中的“锁定”是逻辑要求：当前 SQLite 实现依赖 `ProductDatabase` 的单写者锁、
事务内重读与 `row_version` 条件更新；迁移到支持行锁的数据库后使用
`SELECT ... FOR UPDATE`。不能假设 SQLite 的 `FOR UPDATE` 提供了真实行锁。

```text
BEGIN
  1. 读取 CompletionClaim（FOR UPDATE）：status='candidate'、claim_hash 与请求
     一致；校验请求绑定的 DecisionRecord 对当前 Claim/Hash/结局有效。
  2. 若 commit_status='rejected'：
     a. 不要求 Requirement 满足、不做 applicability、不迁移 subject；
     b. 锁定 ArtifactRecord（如有）；若 Claim Revision 仍是当前项则 disposition=
        rejected 并更新 Record.status，若已被同事务合法 supersede/替代则
        disposition=none，不回写新 Revision；
     c. 创建 ResultCommit(rejected)，Claim→rejected，写 Trace/Outbox；COMMIT。
  3. accepted/waived 路径锁定 subject，校验 row_version ==
     expected_subject_version、当前状态 == from_state。
  4. 加载全部 mandatory Requirements：每项必须有 Adoption 或 Waiver且不能并存；
     accepted 要求全部是 Adoption、零 Waiver；waived 要求至少一条 Waiver。
  5. 复检：
     a. 每条 Adoption 的 Assessment 必须是该 Requirement 当前项且
        verdict='supports'；Observation validity='valid'、subject 匹配，采用链
        及其直接 source 没有 pending invalidation；
     b. Claim 有 Artifact 时，无论是否全 Waiver，都锁定 ArtifactRecord，确认
        row_version==expected_artifact_record_version、绑定 Revision 仍是当前项、Blob
        integrity_status='available' 且重算 Hash 匹配，避免把未审批的新 Revision
        一并标为 accepted；
     c. 全 Waiver 时 Evidence 空集复检记为通过，但 Artifact 校验不能跳过。
  6. applicability 前置：只有 Claim.applicability_policy=
     'must_match_current_target' 才比较基线与当前 Integration 目标；不一致则整
     事务回滚并返回 ARTIFACT_APPLICABILITY_STALE + Trace。SD4 的
     action_result_accepted 使用 record_only，不因活动仓库前进而拒绝接受结果。
  7. 迁移校验：target_transition/from_state/target_state 必须来自既有 Harness
     状态机；SD4 代码链只允许 ActionItem 的 action_result_accepted
     (in_progress→completed)，父 Work 不变。
  8. 创建 ResultCommit（commit_status + artifact_disposition）。
  9. Claim→committed 并绑定 Decision；Artifact 按 artifact_disposition 更新：
     accepted/rejected/not_adopted，不能由 commit_status='waived' 自动推断。
 10. 通过接收当前 AsyncSession 的 Harness 事务参与者 CAS 迁移 subject；禁止
     调用另开事务的公开 Harness Service。
 11. 写入必要的 ProvenanceEdge、Harness Trace 与既有事务 Outbox；正常提交不
     产生 SourceInvalidation，只有真实来源失效事务才发布该类事件。
COMMIT
```

**数据库事务能原子覆盖的**：Product Store 内的行状态、`ResultCommit`、
`ProvenanceEdge`、`Outbox` 记录。

**数据库事务不能原子覆盖的**：Artifact blob（已通过 staging/publish 协议提前
稳定存在）、外部 Git 仓库状态、Provider 调用、Workspace 文件系统。

因此：

- Artifact blob 必须在 ResultCommit 前完成 staging/publish。
- Workspace 文件系统状态由 F01 Operation Ledger 和 Reconciliation 管理，
  ResultCommit 只读取其持久化的事实记录（ToolOperation、Hash）。
- 如果 ResultCommit 事务失败，已创建的 candidate Artifact/Revision 及其 Blob
  仍保持引用，供用户重试或拒绝，**不能被 orphan GC 清理**。只有 publish 后、
  Artifact 创建事务提交前失败的 Blob 才是 orphan。

三种结局：

| 结局 | 条件 | 产品事务内容 |
|---|---|---|
| `accepted` | 全部 mandatory Requirement 都有 Adoption（supports）、零 Waiver，复检通过，applicability 满足，用户（或符合 HITL 策略的自动推进）批准 | 单事务：Claim `committed`、Artifact 按 disposition 处理、subject CAS 推进、写 ResultCommit、Provenance、Outbox |
| `rejected` | 用户拒绝结果 | Claim `rejected`、当前 Artifact Revision（如仍是当前项）记 rejected、subject 不变、记录 Decision |
| `waived` | mandatory Requirement 可混合 Adoption/Waiver，且至少一条 Waiver、无当前 refutes，所有 Adoption 复检通过 | Claim `committed`、subject CAS 推进、Artifact disposition 独立决定、ResultCommit.commit_status='waived'、记录逐 Requirement 理由 |

不变量：

1. 完成声明是**单个产品事务**；Product Store 内的状态变更同事务提交或全部
   回滚。
2. 提交门复检采用链路上的 Observation 仍是 `valid` 且 Assessment 为
   `supports`；任一项已失效则整体失败，用户看到明确原因。
3. `harness/service.py` 既有“完成必须有 Evidence 或豁免”的规则升级：新写入
   的 legacy 投影元素只保存 `{"result_commit_id": ..., "claim_id": ...}`，
   权威事实仍在 F02 关系表；事务参与者沿 ResultCommit→Claim→Requirement→
   Adoption/Waiver 链校验，不能把 JSON 投影当第二事实源（D12）。
4. 完成后的来源失效不删除 subject 事实，只降级相关 Observation validity 并在
   视图显示降级标记。

### 9.2 旧失败不阻断新 Claim（完成门判断域）

完成门的判断域是**当前 Claim 的当前 Requirement 集合**，不是该 Work 的全部
历史：

- 历史 Claim 的 `refutes` Assessment 保留审计，不参与任何新 Claim 的判断。
- 同一 Claim 内，某 Requirement 的“当前结论”= `assessment_sequence` 最大项；
  旧 Assessment 由 `supersedes_assessment_id` 串联，不改写、不删除。
- 只有当前 mandatory Requirement 的**最新** Assessment 是 `refutes` 时，才
  阻断本 Claim 的 accepted 与该 Requirement 的 waiver；解除方式是重新验证
  （新 Observation + 新 Assessment）或拒绝本 Claim，不是等待或 blanket waiver。

### 9.3 豁免规则（逐 Requirement）

1. 豁免粒度是 Requirement（`requirement_waivers`），没有整 Work 的 blanket
   waiver。
2. 某 Requirement 最新 Assessment 为 `refutes` 时，该 Requirement 禁止豁免
   （`WAIVER_BLOCKED_BY_FAILED_REQUIREMENT`）。
3. waived 提交要求每个 mandatory Requirement 都有 Adoption 或 Waiver，且至少
   一条 Waiver；全部有 Adoption 时应走 accepted。
4. 豁免必须绑定 DecisionRecord 与 reason，进入审计与 Provenance。

### 9.4 Validation `outcome_unknown` 处置

Worker/进程死亡后，Reconciler 把 `running` 超时未回报的 ValidationRun 收敛为
`outcome_unknown`（不是 `error`）：

1. 先检查：受管 Workspace 状态与 Operation Ledger、子进程/cgroup 是否仍存活、
   输出收据/临时文件是否存在、`runtime_jobs.lease_epoch` 是否仍有效。
2. 能证明子进程从未启动（`started_at IS NULL` 且 lease 未实际发出）→
   Run 收敛为 `error`（原因“未启动”），允许安全重领新 Run。
3. 能证明执行失败（如 cgroup 记录 OOM）→ 收敛为 `error`，产生失败
   Assessment 需基于可验证材料，不能凭空写。
4. 无法确认 → 保持 `outcome_unknown`，**不自动重跑**；向用户呈现“结果未知”
   处置选项：人工检查后丢弃该 Workspace 并新开 Workspace 重试，或放弃本轮。
   确定性结论只能来自新的 ValidationRun（新 command_id）。
5. fence：`runtime_lease_epoch` 不匹配的迟到回报一律拒收并记审计；创建按
   `command_id`、结果回报按 `outcome_command_id` 幂等，防止死亡 Worker 复活后
   重复写入。

## 10. 决策点

每张决策卡列出：决策原因、参考源是否涉及、全部可行选择、优缺点、当前建议、
信心与未验证项。全部待用户审核。

### D1：Evidence 拆为 Observation / Assessment / Adoption / Waiver 四张关系表

- 原因：单行 Evidence 无法表达“同一材料对不同 Requirement 结论不同”“同一
  材料被多个 Claim 复用”“历史失败不阻断新 Claim”；JSON ID 列表逃避关系
  约束。
- 参考源：四个参考项目均未涉及；本项目问题 5、6 与总体架构 7.9 明确要求。
- 选择：a) 四表关系模型；b) 单行 Evidence + JSON 引用列表；c) 只扩展
  ToolOperation。
- 取舍：b 无法做唯一约束、FK 与逐 Requirement 豁免；c 把证据绑死在工具
  执行上。
- 建议：a。信心：高。未验证：跨表 JOIN 的查询性能（SD4-A 用索引与分页验证）。

### D2：Artifact 内容寻址文件存储 + DB 元数据，scope 内去重

- 原因：Diff/报告可大；内容必须可重算校验；跨 scope 共享物理文件会让单
  scope GC 误删他 scope 引用。
- 参考源：内容寻址是通用工程原则；LibreChat 未涉及 Artifact 存储。
- 选择：a) scope 内去重（UNIQUE(scope_id, sha256)，路径含不可逆 scope
  storage key）；b) 全局去重共享物理文件 + 全局 GC；c) DB 内 JSON/TEXT。
- 取舍：b 的 GC 必须跨 scope 汇总引用，单 scope 运维无法安全执行；c 体积与
  备份压力大。
- 建议：a。存储根来自私有运行配置，默认 `backend/data/artifacts/`，不进
  Git。信心：高。未验证：大文件流式上传（SD4 只支持 Run 内生成）。

### D3：no-clobber publish + reconcile/orphan GC，删除 ref_count 缓存

- 原因：覆盖式 rename 会摧毁已有 blob；rename 后 DB 前的 orphan 位于 blobs
  目录；ref_count 没有权威维护者。
- 参考源：未涉及；通用文件系统事实。
- 选择：a) O_EXCL/link publish + EEXIST 重算校验 + 实时引用查询 GC；
  b) 覆盖 rename；c) ref_count 缓存列。
- 取舍：b 可能静默损坏其他 Revision 的内容；c 缓存与查询漂移即误删。
- 建议：a。信心：高。未验证：macOS 与 Linux 上 hard link/O_EXCL 语义差异
  （SD4-B 用真实文件系统测试）。

### D4：Artifact 无 current_revision_id，按 (artifact_id, revision_number DESC) 取当前

- 原因：`artifact_revisions.artifact_id` 硬 FK + records 回指列构成循环 FK，
  写入顺序必然出现悬空窗口。
- 参考源：未涉及；关系建模常识。
- 选择：a) 删除回指列，查询取当前；b) 延迟 FK / 可空回指两阶段更新。
- 取舍：b 保留环与中间态，崩溃窗口内回指悬空。
- 建议：a。信心：高。未验证：无（索引覆盖查询）。

### D5：Claim 无 result_commit_id，ResultCommit 以 completion_claim_id UNIQUE 反查

- 原因：双向硬 FK 又构成环；一个 Claim 至多一次 Commit，反向 UNIQUE 即可。
- 参考源：未涉及。
- 选择：a) 单向 FK + UNIQUE；b) 双向 FK；c) 应用层弱引用。
- 取舍：b 成环；c 失去数据库完整性。
- 建议：a。信心：高。未验证：无。

### D6：Validation 是确定性系统操作，Capability Catalog 取代自由 argv

- 原因：`executable_key + 任意 argv` 等价于任意代码执行（`python -c`、
  `git clean`、`uv run`）；cwd 校验不能限制读 workspace 外文件；验证命令来自
  已批准 Plan，模型临时发明命令等于绕过授权。
- 参考源：QwenPaw 的“系统下限与用户规则分层”原则可借鉴；具体实现未涉及。
- 选择：a) 版本化 Capability Catalog（固定 executable 策略 + argv prefix +
  参数 schema + sandbox 要求）；b) executable+argv 白名单字符串匹配；c) pi
  内执行并回报。
- 取舍：b 挡不住参数注入与路径逃逸；c 让被验证者自己报告验证结果。
- 建议：a。信心：高。未验证：macOS `seatbelt` 与 Linux `bwrap` 的 egress
  细则（SD4-B 先做 deny 默认，allowlist 属后续启用）。

### D7：Result Commit Gate 单事务，blob 独立协议

- 原因：Evidence 采用、Artifact 接受、subject 状态、Provenance 半提交会产生
  假完成或孤儿证据；而 FS 与 DB 无法原子。
- 参考源：未涉及；本项目提交门规则（架构第 275-280 行）。
- 选择：a) blob staging/publish 先行 + Product Store 单事务；b) 声称 FS+DB
  原子；c) 分步提交 + 对账。
- 取舍：b 不现实；c 引入本不存在的中间态。
- 建议：a。信心：高。未验证：无（SQLite 单事务已在既有提交门验证）。

### D8：Claim 绑定既有 subject 迁移，SD4 完成 Action 而不提前完成 Work

- 原因：无条件把整个 Work 标 completed 混淆了“隔离执行 Action 已验证”与
  “代码已合入、整个 Work 已完成”；新增 `integration_pending` 又会把交付阶段
  塞进通用 Work/Action 状态机。
- 参考源：未涉及；本项目 SD4/SD5 边界推导。
- 选择：a) Claim 携带 subject/from_state/target_transition/target_state +
  expected_version CAS；SD4 把“隔离实现并验证”的 ActionItem 按既有迁移推进到
  completed，父 Work 保持 in_progress，SD5 再推进独立 Integration Action；
  b) 新增 integration_pending；c) 直接完成 Work；d) Claim 不推进任何状态。
- 取舍：b 污染通用 Harness 状态且把投影当领域事实；c 产生假完成；d 无法记录
  真实 Action 进度。
- 建议：a。信心：高。未验证：SD5 Integration Action 的详细模板在 SD5 审核。

### D9：Validation `outcome_unknown` 与 fence

- 原因：Worker 死亡不能断言“error + 零 Evidence”——子进程可能已执行而
  结果未知；自动重跑可能重复副作用。
- 参考源：未涉及；本项目 F03 Worker/Lease 经验。
- 选择：a) outcome_unknown 终态 + 检查后人工处置/新 Run；b) 一律收敛 error
  并自动重跑；c) 忽略。
- 取舍：b 可能重复执行或把未知当失败；c 悬挂 running。
- 建议：a。信心：高。未验证：cgroup/进程存活在 macOS 开发机上的检查手段
  （SD4-B 故障注入验证）。

### D10：Provenance 边只承载 FK 无法回答的关系

- 原因：FK 能回答的关系建边会制造双事实源；泛型 source/target 需要写入时
  同 scope 校验。
- 参考源：W3C PROV-O 外部标准（非参考项目）；协作系统研究已记录渐进取舍。
- 选择：a) FK 权威 + 最小边集；b) 全部建边；c) 不建边只存 FK。
- 取舍：b 双写漂移；c 无法回答跨模块 attribution/invalidation。
- 建议：a。信心：中高。未验证：多跳查询在 SQLite 上的递归性能（首版限制
  查询深度 3）。

### D11：失效事件走既有事务 Outbox，SourceInvalidation 为追加日志

- 原因：失效传播必须与源状态变更同事务；同一来源会多次失效/恢复，不能用
  (source, kind) 永久唯一。
- 参考源：未涉及；既有 Outbox 已在主 Workflow 恢复中验证。
- 选择：a) 追加日志 + sequence + command_id 幂等 + Outbox；b) 单 row upsert；
  c) 同步级联调用。
- 取舍：b 丢失事件历史且无法表达恢复；c 跨模块事务耦合。
- 建议：a。信心：高。未验证：Memory/Context 消费属 F06 边界。

### D12：legacy `evidence_json` 演进策略

- 原因：现有数据库只有开发数据，且不允许迁移旧库；但代码路径要兼容已存在
  的自由 JSON 记录。
- 参考源：未涉及；本项目兼容规则。
- 选择：a) 旧数据只读展示，新完成写入只保存
  `{"result_commit_id": ..., "claim_id": ...}` 派生投影；
  b) 写迁移把旧 JSON 全部转成 Observation；c) 双写。
- 取舍：b 旧 JSON 没有可校验来源，转出来只能是 `unverifiable`，价值低；
  c 制造双事实源。
- 建议：a。服务层识别 ResultCommit/Claim 引用并走关系链校验，JSON 只作
  Harness 兼容投影；其他旧形状按 legacy 只读。信心：高。未验证：无。

### D13：SD4 纵向切片边界

- 原因：F02 对象模型要支撑学习、研究等全场景，但首个切片只证明 Dogfood
  代码链路。
- 参考源：未涉及；阶段划分只决定启用顺序。
- 切片范围：`diff_patch` / `validation_report` / `result_patch` 三种 Artifact；
  `validation_result` / `file_hash_match` / `human_confirmation` 三种
  Observation；受管 Workspace 内的验证与完成声明（完成隔离执行 Action，父
  Work 保持 `in_progress`）。
- 不在切片：学习测验 Evidence、外部观察 Evidence 执行器、自动清理、
  Provenance 图可视化（首版为关系列表）、网络放行（deny 默认）。
- 信心：高。未验证：非代码 kind 的 Contract 模板在各自场景启用前补齐设计。

### D14：豁免粒度为 Requirement

- 原因：整 Work 的 blanket waiver 会绕过“当前有未解决 refutes”的硬性阻断，
  也无法审计到底豁免了哪条要求。
- 参考源：未涉及；本项目推导。
- 选择：a) 逐 Requirement waiver + 当前 refutes 阻断；b) 整 Work waiver；
  c) 不允许豁免。
- 取舍：b 见原因；c 对非代码 Work 误伤。
- 建议：a。信心：高。未验证：非代码 Work 的 Requirement 模板。

### D15：普通用户不能伪造 Evidence/验证结论（服务端主体分离）

- 原因：Evidence 与 Validation outcome 是完成门输入；允许用户直接 POST 等于
  允许自我证明。
- 参考源：未涉及；本项目授权规则。
- 选择：a) 服务端 service principal 写入 + 用户只能创建 Claim/Decision；
  b) 用户直写 + 审计。
- 取舍：b 审计不能阻止假完成先发生。
- 建议：a。信心：高。未验证：无。

## 11. 失败矩阵

| # | 故障 | 期望行为 |
|---|---|---|
| 1 | 验证进程中途死亡，子进程是否执行未知 | `running` 由 Reconciler 收敛 `outcome_unknown`；零新 Observation；不自动重跑；按 9.4 检查/人工处置 |
| 2 | 验证结果回调重复/迟到 | 按 `outcome_command_id` 幂等 + `runtime_lease_epoch` fence；相同回报返回原结果，不同/迟到回报拒收并记审计；Observation 只产生一次 |
| 3 | Artifact 写入中断/磁盘满 | 无 DB 行；Run 失败原因可查；staging 残留与 orphan blob 由 reconcile/GC 处理 |
| 4 | publish 时 EEXIST | 重算最终文件 hash/size；一致则复用；不一致则失败，只隔离本次 staging 输入，不移动既有最终文件；Blob 标 `corrupt` 并告警 |
| 5 | 读取 Artifact 时 Hash 不匹配 | Blob `integrity_status='corrupt'`；关联 Observation 降为 `unavailable` 并追加 SourceInvalidation；Artifact 视图派生“不可读取”，不伪造 Artifact 生命周期状态 |
| 6 | 验证通过后、SD4 接受前活动仓库 Snapshot 前进 | **不创建 SourceInvalidation**；Observation validity 保持 `valid`；SD4 record_only Claim 可接受并提示“合入前需重验”；SD5 must_match 门返回 `ARTIFACT_APPLICABILITY_STALE` + Trace |
| 7 | 修复预算耗尽 | Run 以失败 Assessment 结束；Work `blocked`；无自动重试；历史失败全部保留 |
| 8 | 用户在结果门前拒绝 | Claim `rejected`、Artifact `rejected`；保留可检查；subject 不变 |
| 9 | 提交门事务中途崩溃 | Product Store 全部回滚；恢复后 Claim/Artifact 仍 `candidate`、Observation 仍有效；ArtifactRevision 继续引用已 publish Blob，GC 不得清理；无半完成 |
| 10 | Run 终态后收到迟到 Evidence 回调 | fence 拒收；记录审计日志 |
| 11 | 并发完成同一 subject | Claim `expected_subject_version` CAS + `result_commits.completion_claim_id` UNIQUE + 命令幂等；只有一次成功 |
| 12 | 已完成 subject 的来源被撤销 | subject 保持原状态；Observation `validity=revoked`；视图显示降级标记；不自动撤销 subject |
| 13 | pi 文本自述“已完成”但无验证 Evidence | 完成门拒绝；自述只进入 `model_output_adoption` 材料 |
| 14 | 活动仓库从 Snapshot A 前进到 B（查询侧） | A 上 Observation `validity` 保持 `valid`；Lineage/视图提示 Claim 绑定 A 与当前目标 B 不同；只有 SD5 Integration 的 must_match 提交被阻断 |
| 15 | Worker 复活后重复执行同一 ValidationRun | 创建 `command_id` + 回报 `outcome_command_id` 幂等、`runtime_lease_epoch` fence；第二次执行被阻止或结果被拒收 |
| 16 | GC 标记 orphan 后并发创建 Revision | Revision 事务只能引用 active+available Blob；GC 先锁行并 CAS deleting，二者只有一方成功；不得出现新 Revision 指向已删文件 |
| 17 | Evidence 已失效或 Snapshot 已前进时用户拒绝结果 | rejected 路径不跑 Evidence/applicability/subject 迁移校验；Claim/Artifact 可被拒绝，subject 不变 |
| 18 | OS sandbox 缺失、Capability/可执行文件/环境指纹漂移 | `pending → error`，进程未启动；要求新 Draft/Approval，不回退系统 Python、不降级为“仅 cwd 校验” |
| 19 | 浏览器或普通用户伪造 Observation/Assessment/Validation outcome | 授权层在进入应用命令前 403；无产品行、无 Trace 成功事件、无 subject 推进 |
| 20 | Claim 创建后同一 Artifact 追加新 Revision | Artifact row_version/current Revision 复检失败，ResultCommit 全回滚并返回 `ARTIFACT_REVISION_SUPERSEDED`；新 Revision 不会借旧批准被接受 |

## 12. 场景验证

### S1：Dogfood 成功链路

用户让 Chat 给 Workflow 节点加内容查看（真实 SD4 场景）：pi 在受管 Workspace
完成 `edit` → Diff 形成 `diff_patch` Artifact Revision → ValidationRunner 按
Capability 执行 Contract 规则 → `passed` → `validation_result` Observation +
针对当前 Claim Requirement 的 `supports` Assessment + `file_hash_match`
Observation/Assessment → 用户在结果门接受 → 单事务 ResultCommit(accepted) →
Claim `committed`、Artifact `accepted`、隔离执行 ActionItem 推进到
`completed`、父 Work 保持 `in_progress`（合入属 SD5 的独立 Action）→ Lineage 可查
“Work ← ResultCommit ← Claim ← Adoption ← Assessment ← Observation ←
ValidationRun ← Workspace/RepositorySnapshot”（路径来源见 4.15.2）。

### S2：两轮修复后成功

首次验证失败 → Observation + Assessment（`refutes`，不被采用），第 1 个 Claim
转 `superseded` → 预算内第 2 轮 pi 修复形成新 ArtifactRevision 与新 Claim →
第 2 次验证通过 → 新 Observation + 新 Assessment（`supports`，被采用）→ 完成。
断言：两轮材料和 Claim 都保留；第 1 轮 `refutes` 不阻断新 Claim；完成只绑定
第 2 轮通过证据。

### S3：预算耗尽

3 次验证失败（上限 2 次修复）→ Run 失败结束，Work `blocked`，用户看到失败
Assessment 与剩余选项（重新规划/停止）。断言无假完成、无自动重试；历史失败
Evidence 保留。

### S4：提交门前进程被杀

验证通过后、用户接受前重启后端。恢复后：Observation 仍 `valid`、Assessment
仍 `supports`，Artifact 完整可校验，Claim 仍 `candidate`，subject 不变，用户
可继续接受或拒绝。断言无半提交。

### S5：验证后活动仓库前进（Applicability，不产生失效事件）

验证通过后用户在活动仓库手动提交新代码，当前合入目标变为 Snapshot B →
**不创建 SourceInvalidation**（A 未失效）；原 Observation `validity` 仍
`valid`；SD4 record_only Claim 可接受隔离执行 Action，并显示“基线 A、当前目标
B、合入前需重验” → SD5 Integration Claim 使用 must_match 时返回
`ARTIFACT_APPLICABILITY_STALE` 并记 Trace。断言：区分“来源仍可验证”“SD4
结果被接受”和“是否适合合入当前目标”，F02 不越权执行 SD5。

### S6：跨天周总结

第 7 天用户问“本周 Chat 做了什么”。答案必须全部来自已提交 subject、
Artifact 和 Evidence 聚合；每个条目可点开 Lineage。断言模型不从聊天语气
猜测。

### S7：学习场景设计留口

学习单元完成需要“测验通过”Observation（kind=`external_observation` 或专用
`quiz_result`）。SD4 不实现该 kind 的执行器，但 Observation Schema 的
kind/schema_version/payload 结构必须能容纳，且完成门逻辑不区分代码与非代码
证据。

### S8：outcome_unknown 处置

验证 Worker 在子进程可能已启动后被强杀 → Reconciler 收敛
`outcome_unknown` → 用户看到“结果未知”与处置选项 → 选择丢弃 Workspace 并
新开 Workspace 重试 → 新 ValidationRun（新 command_id）得出确定结论。断言：
无自动重跑、无重复副作用、旧 Run 保持 `outcome_unknown` 可审计。

### S9：两个会话并发推进同一 Action

会话 A、B 都基于 Action row_version=4 生成各自 Claim；A 先接受并在单事务把
Action 推到 completed/row_version=5 → B 随后提交时 subject CAS 失败，B 的 Claim
仍 candidate、无 ResultCommit、无 Artifact 状态误改。用户看到“另一个会话已推进
此 Action”以及 A 的 Lineage，可选择拒绝 B 或基于新状态重新规划。

### S10：任何时候都能拒绝候选结果

Claim 的 Observation 已 unavailable，且活动仓库已从 A 前进到 B；用户选择拒绝。
系统不要求修复证据、不做 applicability 检查，单事务写 ResultCommit(rejected)、
Claim/Artifact rejected，Action/Work 不变。断言“拒绝”不会被系统自己的过期
前置条件卡死。

## 13. REST / DTO / Problem Detail

### 13.1 端点总览

| 端点 | 方法 | 允许主体 | 说明 |
|---|---|---|---|
| `/api/evidence/artifacts` | POST | workflow/worker service | Run 内生成 Artifact |
| `/api/evidence/artifacts/{id}` | GET | end_user（scope + read grant）、admin | 查询 |
| `/api/evidence/artifacts/{id}/revisions` | POST | end_user（经 Workflow）、workflow/worker service | 追加 Revision；有 candidate Claim 时拒绝 |
| `/api/evidence/artifacts/{id}/revisions/{rev}/download` | GET | end_user（scope + read grant）、admin | 下载 |
| `/api/evidence/artifacts/{id}/transition` | POST | end_user（绑定 Decision）、workflow service | retained/discarded 等显式生命周期迁移 |
| `/api/evidence/observations` | POST | workflow/worker service、validator | 创建 Observation |
| `/api/evidence/observations/{id}` | GET | end_user（scope + read grant）、admin | 查询 |
| `/api/evidence/claims` | POST | end_user（经 Workflow）、workflow service | 创建 Claim 候选 |
| `/api/evidence/claims/{id}` | GET | end_user、admin | 查询（含 Requirements/Assessments/Adoptions/Waivers） |
| `/api/evidence/claims/{id}/assessments` | POST | validator、workflow service | 创建 Assessment |
| `/api/evidence/claims/{id}/adoptions` | POST | workflow service（绑定 Decision） | 创建 Adoption |
| `/api/evidence/claims/{id}/waivers` | POST | end_user（绑定 Decision） | 逐 Requirement 豁免 |
| `/api/evidence/claims/{id}/commit` | POST | end_user（绑定 Decision） | ResultCommit |
| `/api/evidence/validations` | POST | workflow/worker service | 创建 ValidationRun |
| `/api/evidence/validations/{id}/outcome` | POST | worker service（fence 校验） | 回报结果 |
| `/api/evidence/claims/{id}/lineage` | GET | end_user、admin | 固定类型 JOIN 返回完整 Claim→证据→Run/Workspace 链 |
| `/api/evidence/lineage` | GET | end_user、admin | 仅补充 generic ProvenanceEdge 图扩展；depth<=3 |
| `/api/evidence/invalidations` | POST | source-manager/reconciler service | 追加来源失效/恢复事件；普通用户不能伪造 |
| `/api/evidence/invalidations` | GET | end_user、admin | 失效事件查询 |

普通用户**不能** POST Observation、Assessment、ValidationRun、Validation
outcome；这些端点只接受服务端 service principal（mTLS/内部令牌，不进浏览器）。
admin 只读 + 审计访问记录；reconciler 只能做状态收敛（`outcome_unknown`/
`error`），不能创建 Evidence。

### 13.2 关键命令 DTO（最少字段）

`CreateArtifactCommand`：`command_id`、`kind`、`title`、`media_type`、
`product_run_id`、`run_attempt_id`、`content_ref`（服务端签发、scope/Hash/一次性
绑定且短时有效的 BlobIngestHandle，浏览器不能自由构造）、
`sha256`、`size_bytes`。响应：`artifact_id`、`revision_id`、`revision_number`、
`status='candidate'`、`row_version`。

`TransitionArtifactCommand`：`command_id`、`artifact_id`、`expected_row_version`、
`target_status`、`decision_record_id`、`reason`。服务层只接受 6.1 的合法迁移；
`discarded` 必须有用户/策略 Decision，且状态变化不等于删除 Blob。

`AppendArtifactRevisionCommand`：`command_id`、`artifact_id`、
`expected_artifact_record_version`、`content_ref`、`sha256`、`size_bytes`、
`supersedes_revision_id`、`created_by`。Coordinator 锁定 Record，确认当前 Revision
一致且不存在 candidate Claim，按 4.1 协议写 Blob/Revision、Record.status→
candidate、row_version+1；失败全回滚，Blob 按 orphan 协议处理。

`CreateEvidenceObservationCommand`：`command_id`、`kind`、`schema_version`、
`payload_json`、`subject_kind`、`subject_id`、来源 ID 组（至少一个）、
`statement`。响应：`observation_id`、`validity='valid'`、`created_at`。

`CreateCompletionClaimCommand`：`command_id`、`subject_kind`、`subject_id`、
`expected_subject_version`、`target_transition`、`artifact_revision_id?`、
`expected_artifact_record_version?`、`repository_snapshot_id?`、
`applicability_policy`、`validation_contract_id?`、`requirements[]`（kind/mandatory/description/
params/schema_version）。服务层计算 `from_state` 与 `claim_hash` 并校验
`target_transition` 协议。响应：`claim_id`、`claim_hash`、`status='candidate'`、
`row_version`、requirements 展开结果。

`CreateAssessmentCommand`：`command_id`、`claim_id`、`requirement_id`、
`observation_id`、`verdict`、`rationale?`。服务层校验 observation/requirement
同 scope、requirement 属于该 claim。响应：`assessment_id`。

`CreateAdoptionCommand`：`command_id`、`claim_id`、`requirement_id`、
`assessment_id`、`decision_record_id`。服务层校验 assessment.verdict=
'supports' 且属于该 requirement。响应：`adoption_id`。

`CreateWaiverCommand`：`command_id`、`claim_id`、`requirement_id`、
`decision_record_id`、`reason`。服务层校验该 requirement 最新 Assessment 非
`refutes`。响应：`waiver_id`。

`CommitResultCommand`：`command_id`、`claim_id`、`claim_hash`、
`expected_claim_row_version`、`decision_record_id`、`commit_status`
（accepted/rejected/waived）、`artifact_disposition`。响应：`result_commit_id`、
`committed_subject_state`、claim 与 artifact 的新状态与 `row_version`。

`CreateValidationRunCommand`：`command_id`、`workspace_id`、
`repository_snapshot_id`、`validation_contract_id`、`contract_hash`、
`rule_ordinal`、`repair_cycle`、`runtime_job_id`、`run_attempt_id`、
`runtime_lease_epoch`。响应：`validation_run_id`、`expanded_argv_json`（供 Worker
逐字执行）、`status='pending'`。

`ReportValidationOutcomeCommand`：`outcome_command_id`、`validation_run_id`、
`runtime_lease_epoch`、`status`（passed/failed/timeout/error）、`exit_code`、
`stdout_tail`、`stderr_tail`、`report_artifact_revision_id?`。服务层 fence 校验
后落库并（在同事务）生成 Observation + Assessment。响应：受理结果与新行 ID。

### 13.3 查询分页

- 固定排序 `(created_at, id)`；`cursor` 编码上一页末行键 + `scope_id` +
  filter 的 Hash；cursor 与当前请求 scope/filter 不匹配返回 422。
- `limit` 默认 20，最大 100。
- `scope_id` 从服务端 RequestContext 注入，不从前端自由传入。
- 返回包含 `row_version`、`updated_at`。
- 固定 `/claims/{id}/lineage` 通过 FK JOIN 返回完整已知链，不受 generic 图
  `depth<=3` 限制；通用 `/lineage` 才限制递归深度，二者不能混为一谈。

### 13.4 下载与读取鉴权

Artifact 下载/读取要求：(1) scope 匹配；(2) read grant——请求主体是该
Artifact 关联 subject 所在 project 的参与者（经 Claim/Run 链路推导），或有
admin 角色；仅有 scope 成员资格不够。Observation、Claim 与 Lineage 查询沿同一
关联链计算 read grant，不能因为它们是“元数据”就暴露其他 Project 的标题、路径
或结论。跨表引用（Observation→Artifact、
Claim→Revision 等）在写入事务内全部校验同 scope。

### 13.5 Problem Detail 错误码

| 场景 | HTTP | code | details |
|---|---|---|---|
| 请求校验失败 | 422 | `REQUEST_VALIDATION_FAILED` | issues |
| Scope 不匹配/无 read grant | 403 | `PERMISSION_DENIED` | resource_id |
| 资源不存在 | 404 | `RESOURCE_NOT_FOUND` | resource_id |
| Artifact Hash 不匹配 | 409 | `ARTIFACT_HASH_MISMATCH` | resource_id |
| Claim 绑定的 Artifact Revision 已非当前项 | 409 | `ARTIFACT_REVISION_SUPERSEDED` | artifact_id, expected_revision, actual_revision |
| CAS 冲突（claim/subject） | 409 | `RESOURCE_VERSION_CONFLICT` | actual_version, expected_version |
| Claim 已被解决 | 409 | `COMPLETION_CLAIM_ALREADY_RESOLVED` | resource_id |
| 采用链路上 Observation 失效 | 409 | `EVIDENCE_INVALID` | resource_id |
| 缺少必需 Adoption/Waiver | 422 | `COMPLETION_REQUIREMENT_UNSATISFIED` | requirement_id |
| 当前 refutes 阻断豁免 | 422 | `WAIVER_BLOCKED_BY_FAILED_REQUIREMENT` | requirement_id |
| Adoption 指向非 supports Assessment | 422 | `ASSESSMENT_NOT_SUPPORTING` | assessment_id |
| Validation 合同 Hash 不匹配 | 409 | `VALIDATION_CONTRACT_MISMATCH` | contract_hash |
| Capability 不可用（schema/sandbox fail closed） | 422 | `VALIDATION_CAPABILITY_UNAVAILABLE` | capability_key, reason |
| Validation 超时 | 504 | `VALIDATION_TIMEOUT` | validation_run_id |
| Validation 结果未知 | 409 | `VALIDATION_OUTCOME_UNKNOWN` | validation_run_id |
| Runtime lease fence 不匹配 | 409 | `RUNTIME_LEASE_FENCE_MISMATCH` | validation_run_id |
| Artifact 对新目标不适用 | 409 | `ARTIFACT_APPLICABILITY_STALE` | expected_snapshot, actual_snapshot |
| 目标迁移不被协议允许 | 422 | `SUBJECT_TRANSITION_NOT_ALLOWED` | from_state, target_transition |
| 来源已失效 | 410 | `SOURCE_INVALIDATED` | resource_id |

## 14. 分阶段实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| SD4-A | 第 20 次迁移：`artifact_blobs`、`artifact_records`、`artifact_revisions`、`evidence_observations`、`completion_claims`、`completion_claim_requirements`、`evidence_assessments`、`claim_evidence_adoptions`、`requirement_waivers`、`result_commits`、`validation_capabilities`、`validation_contracts`、`validation_runs`、`provenance_edges`、`source_invalidations` 的 Repository 与合同；状态机与迁移矩阵单测；提取可参与外层事务的 HarnessTransitionParticipant，不新增 Harness 状态 | 迁移升降通过；非法迁移全拒绝；无硬 FK 环；Action 完成与父 Work 不变同事务；架构依赖测试通过 |
| SD4-B | Artifact Store staging/no-clobber publish/reconcile/orphan GC；Capability Catalog 与结构化执行（deny 网络默认）；失败矩阵 1-5、15-16、18 | blob 崩溃窗口与 GC/引用竞态；EEXIST 复用/冲突；argv/可执行文件/环境 Hash 一致；sandbox 缺失与 schema 外参数 fail closed；死亡/重复回调幂等与 fence |
| SD4-C | Result Commit Gate 接入主 Workflow；Claim subject 迁移绑定；harness 完成门引用链校验；失败矩阵 6-11、13、17、19-20 | 单事务提交与回滚；拒绝路径独立；逐 Requirement 豁免；Artifact Revision 并发保护；legacy JSON 只读兼容；record_only/must_match 策略分支正确；普通用户不能伪造 Evidence |
| SD4-D | Provenance 写入与查询；Validity 降级与 Outbox 事件；失败矩阵 12、14 | Lineage 查询（4.15.2 全路径）；失效传播与恢复事件；降级标记 |
| SD4-E | 前端 Evidence/Artifact/Validation 视图；真实 Qwen Dogfood E2E；浏览器桌面与 390px 验证 | S1-S6、S8-S10 端到端；控制台 0 错误；无横向溢出 |

每阶段遵守既有节奏：开发 → 单元/合同 → 集成/故障 → 真实模型/浏览器 →
架构与代码检视 → 优化 → 偏航审计 → 用户审核。

## 15. 测试与完成门

### 15.1 合同与状态机

1. Observation/Assessment/Adoption/Waiver 全部合法与非法组合（含跨 Claim
   引用拒绝、非 supports 采用拒绝、Adoption+Waiver 并存拒绝）。
2. Artifact Revision 单调与内容不可变；当前 Revision 查询取
   (artifact_id, revision_number DESC)。
3. Claim 状态机：resolved 必须有 Decision；superseded/rejected/committed 终态。
4. ResultCommit CHECK：accepted/waived 必须 pre_commit_validity_check_passed；
   artifact_disposition 跨表组合由 Coordinator 合同测试覆盖。
5. ValidationRun CHECK：passed/failed 必须有 finished_at+exit_code；
   outcome_unknown 不能自动进 passed。
6. Assessment sequence/supersedes 链并发插入；Adoption 只能指向当前 supports；
   claim_hash 不承担幂等唯一性；同一 ArtifactRevision 不能成为第二个主交付 Claim，
   重提 Artifact 必须创建新 Revision（内容 Blob 可复用）。
7. Provenance 边唯一性、方向矩阵、只增不改、OwnershipResolver 同 scope 校验。
8. 无硬 FK 环：schema 级依赖图检查（records/revisions、claims/commits 方向）。

### 15.2 文件与存储

1. 写入顺序：staging → fsync → no-clobber publish → 重算 → DB 事务；中断无
   半文件、无“有行无内容”。
2. publish 后 DB 失败 → orphan blob 位于 blobs/；reconcile 同时扫描 staging
   与未引用 blob；GC 只删无引用 + 超宽限期。
3. EEXIST：内容一致复用；不一致只隔离本次 staging 输入，既有最终文件绝不移动/
   覆盖；Blob 完整性降级可恢复。
4. GC `active→orphan_candidate→deleting/delete_failed` 的崩溃恢复，以及 GC 与新
   Revision 并发只能一方成功。
5. scope 隔离：路径含 scope storage key；单 scope GC 删不到他 scope 文件；
   跨 scope FK 写入拒绝。
6. 读取重算 Hash；不匹配标记 Blob corrupt、Observation unavailable；存储根不
   进 Git；路径遍历拒绝。

### 15.3 故障矩阵

第 11 节 20 项全部有自动测试；进程死亡用真实子进程强杀，不用 Mock；
outcome_unknown 场景验证“不自动重跑 + fence 拒收迟到回报”。

### 15.4 纵向与真实模型

1. 真实 Qwen 完成 S1：Product Run、ValidationRun、Observation、Assessment、
   Adoption、Artifact、Claim、ResultCommit、Decision 均持久可查；隔离执行
   Action=`completed`、父 Work=`in_progress`、Workspace=`retained`。
2. S2/S3/S8 用确定性故障注入跑通，不必消耗真实模型。
3. 浏览器 S1、S4、S6 桌面与 390px；Evidence 与 Artifact 视图无横向溢出。

### 15.5 完成门（SD4 阶段级）

代码生成、验证通过、用户接受和 subject 推进之间存在可审计链：任一已推进的
代码 subject 都能回答“哪份 Diff、哪次验证、哪份 Observation、哪条
Assessment/Adoption、哪个 Decision、哪个 Claim、哪个 ResultCommit、推进到
哪个状态”，且失败路径无一例假完成。SD4 的推进终点是“隔离执行 Action 已完成、
父 Work 仍进行中”；代码合入由 SD5 的独立 Integration Action 承担，只有全部
mandatory Action 完成且无待合入 Artifact 时才允许关闭 Work。

## 16. 与既有对象的关系

| 既有对象 | F02 关系 |
|---|---|
| ToolOperation/Reconciliation（F01） | 提供 Hash 对账原材料；`file_hash_match` Observation 引用其 ID，不复制数据 |
| ModelCall Attempt | `model_output_adoption` Observation 引用其 ID；Attempt 仍是传输事实 |
| Governance DecisionRecord | Assessment 采用、Waiver、ResultCommit、Artifact 废弃都绑定 Decision |
| ExecutionWorkspace | ValidationRun 绑定 Workspace；Workspace `retained` 不等于 Artifact 已接受 |
| RepositorySnapshot | Claim/ValidationRun 绑定精确 Snapshot；目标前进不产生失效事件；SD4 record_only 只提示差异，SD5 must_match 才阻断合入；失效事件仅用于来源本身不可验证 |
| Runtime Job/Attempt | ValidationRun 绑定 Job/Attempt，并快照真实存在的 `runtime_jobs.lease_epoch` fence |
| Memory/Context | 本阶段只接收失效事件发布；消费降级属 F06 |
| TurnDigest | 摘要采用去向已由 Attempt 记录；F02 不改变摘要流程 |
| harness/contracts.py | 不新增状态；ResultCommit 通过同事务参与者复用现有 Action/Work 迁移与完成门 |

## 17. 未兑现声明

本设计批准后仍不保证：

1. 非代码 Evidence kind（学习测验、外部观察）的执行器与 Contract 模板。
2. Artifact 自动清理、保留策略与用户上传。
3. Provenance 图可视化与深度 >3 的递归查询。
4. Memory/Context 对失效事件的消费（F06）。
5. 活动仓库合入、commit/push（SD5）及 Integration Action 的详细合同。
6. pi 跨进程恢复（F05）。
7. Artifact blob 的跨实例分布式存储或备份策略。
8. 网络放行的 egress sandbox 细则（SD4 网络默认 deny；allowlist 能力启用前
   单独审核）。

以上各项在对应阶段单独审核，不得由本设计外推。
