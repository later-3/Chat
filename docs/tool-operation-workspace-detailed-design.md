# F01 Tool Operation Ledger 与 SD3 Execution Workspace 详细设计

> 状态：**2026-07-25 已获用户批准；SD3-A至E工程纵向切片与真实Qwen隔离写入已通过**
>
> 适用范围：F01 字段级 Tool Operation Ledger，以及 SD3 首个“受管 Git
> worktree 内单文件精确编辑”纵向切片。
>
> 不授权：直接修改活动仓库、任意 Shell、自动 commit/push/deploy、把文件变化
> 自动提交为 Work 完成、独立 Evidence/Artifact 生命周期、活动 pi 跨进程续跑。

## 1. 为什么不能继续扩展 `ToolExecution`

现有 `ToolExecution` 表示“pi Runtime 的一次整体执行”。一次 pi 执行可以包含多次
模型调用和多次内部 Tool 调用，因此它无法回答：

1. 哪一次 `edit` 获得了哪一份批准。
2. 外发/落盘前后进程死亡时，该次编辑到底有没有发生。
3. 同一个 Tool 回调重复到达时，是否已经执行过。
4. 文件已经变化时，是安全重试、已经成功，还是必须人工处置。

F01 新增逐 Tool 调用的账本，`ToolExecution 1 -> N ToolOperation`。两者关联但不合并。

## 2. 证据与参考结论

### 2.1 MAF 安装版与源码事实

项目安装 `agent-framework-core 1.11.0`。MAF 的 `FunctionMiddleware` 可以在函数调用
前后观察 `function`、已校验参数和结果；`FileAccessProvider` 能提供需要批准的
读写 Tool，并对文件根路径和符号链接做防护。

但 MAF 1.11.0 不替产品保存跨进程 Tool Operation、Attempt、幂等键、外发边界和
对账决定。`FileAccessProvider` 的写锁也明确只覆盖单进程事件循环。因此：

- 采用 MAF 的“Tool 调用是独立受治理边界”语义；
- 不把 MAF Session 或 FunctionMiddleware 当作产品副作用账本；
- Chat Tool Gateway 仍是 pi 自定义 Tool 的唯一落盘入口。

证据：

- 安装版：`.venv/.../agent_framework/_middleware.py`
- 安装版：`.venv/.../agent_framework/_harness/_file_access.py`
- 参考源码提交：`9c4cd07899502157284b64a73f9a0adfb4594d96`

### 2.2 pi 事实

pi 的扩展 `tool_call` 事件发生在 Tool 真正执行前，可以阻止调用；扩展注册的 Tool
可以完全替换内置 Tool。pi 默认可能并行执行同一模型消息里的多个 Tool，且参数被
事件处理器修改后不会再次做 Schema 校验。

因此 SD3：

- 继续使用 `--no-builtin-tools`，只注册 Chat-owned Tool；
- 写 Tool 声明为顺序执行；
- Chat Gateway 必须重新校验最终参数，不信任扩展内存中的对象；
- 参数或目标变化必须形成新的 Operation Hash 和新批准。

证据：

- `pi` 提交：`2b00dade7cec918aefb025c8b7a4fa304a30acdd`
- `packages/coding-agent/docs/extensions.md`
- `packages/coding-agent/src/core/extensions/types.ts`

### 2.3 nanobot 与 QwenPaw 取舍

nanobot 的 Workspace path policy、读后再写提示和读写权限分离可借鉴；但它的
应用级路径防护不是 OS Sandbox，也没有本项目需要的持久 Operation Ledger。

QwenPaw 区分审批与 Sandbox，并采用治理包装器统一拦截 Tool，这个边界可借鉴；
其 Workspace/Sandbox 在固定提交中仍包含接口/存根，不能为本项目副作用恢复背书。

固定提交：

- nanobot：`2c789767280482f38667044f8a3be5102c71dd26`
- QwenPaw：`2134427584c2657bb717bb083a120f2de011d047`

## 3. 本阶段对象

### 3.1 `ExecutionWorkspace`

一份从已批准 `RepositorySnapshot.head_oid` 创建的受管、隔离 Git worktree。

| 字段 | 约束与作用 |
|---|---|
| `id` | UUID，公开稳定标识 |
| `scope_id` | 当前产品 Scope |
| `product_run_id` / `run_attempt_id` / `runtime_job_id` | 完整运行血缘 |
| `tool_execution_id` | 拥有该工作区的 pi `ToolExecution`，唯一 |
| `repository_binding_id` / `repository_snapshot_id` | 来源 Repository 身份 |
| `workspace_key` | 受管根目录下的不可猜目录名；不暴露绝对路径 |
| `workspace_kind` | 本阶段固定 `managed_git_worktree` |
| `root_key` / `source_relative_path` | 安全公开来源定位 |
| `base_revision` | 非空 Git commit OID，必须等于 Snapshot `head_oid` |
| `status` | 见状态机 |
| `observed_head_oid` | 创建后实测 HEAD |
| `diff_hash` / `changed_paths_json` | 工作区公开变化投影 |
| `failure_code` | 脱敏稳定错误码 |
| `row_version` | CAS 版本 |
| 时间字段 | `created/ready/retained/finished` |

工作区状态机：

```text
preparing -> ready -> running -> validating -> retained
     |         |         |           |
     +---------+---------+-----------+-> failed

retained -> integrated   （SD6以后）
retained -> discarded    （后续显式操作）
```

本阶段成功终态是 `retained`，不是 `integrated`。关闭聊天工作台不能删除它。

### 3.2 `ToolOperation`

模型提出的一次具体 Tool 副作用。首个 `operation_kind` 为 `exact_text_edit`。

| 字段 | 约束与作用 |
|---|---|
| `id` | UUID |
| 运行与工作区外键 | Session、Run、Attempt、Runtime Job、ToolExecution、Workspace |
| `provider_tool_call_id` | pi 给出的 Tool Call ID；与 ToolExecution 组合唯一 |
| `tool_name` / `tool_definition_revision` | 本阶段 `edit` / `chat-exact-edit-v1` |
| `operation_ordinal` | 同一 ToolExecution 内递增 |
| `operation_kind` / `side_effect_class` | `exact_text_edit` / `workspace_write` |
| `arguments_json` / `arguments_hash` | 规范化参数与 Hash |
| `operation_hash` | Tool revision、参数、Workspace fence、Tool Call ID 的 Hash |
| `idempotency_key` | `tool-operation:<operation_hash>`，全局唯一 |
| `target_path` | Workspace 内规范化相对路径 |
| `expected_preimage_hash` | 批准时文件 Hash |
| `expected_postimage_hash` | 批准内容应用后的确定性 Hash |
| `status` | 见状态机 |
| `authorization_consumption_id` | 一次性授权消费 |
| `dispatch_epoch` | 每次实际外发/落盘领取递增 |
| `observed_hash` | 成功、失败或对账时实测文件 Hash |
| `result_json` / `result_hash` | 脱敏结果 |
| `failure_code` / `resolution_code` | 稳定失败或对账结论 |
| `row_version` 与时间字段 | CAS 与生命周期 |

状态机：

```text
proposed -> waiting_authorization -> authorized -> dispatching
    |              |                     |             |
    +------------> denied                +-----------> succeeded
                                                  |--> failed
                                                  +--> outcome_unknown

outcome_unknown -> reconciling -> succeeded
                              |-> failed_not_applied
                              +-> manual
```

`denied`、`succeeded`、`failed`、`failed_not_applied`、`manual`是终态。
`outcome_unknown`绝不自动重放。

### 3.3 `ToolOperationAttempt`

一次领取和实际调用尝试：

- `(operation_id, attempt_number)`唯一；
- 保存 `worker_id`、`lease_epoch`、`dispatch_epoch`；
- `status`为`claimed/dispatching/succeeded/failed/outcome_unknown`；
- 持久化 `dispatch_started_at` 必须早于文件替换；
- 保存安全错误码、结果 Hash 和起止时间。

本阶段同一 Operation 正常只有一次 Attempt；存在 `outcome_unknown` 时只能对账，
不能创建第二次执行 Attempt。

### 3.4 `ToolOperationReconciliation`

一次确定性对账：

- `(operation_id, sequence)`唯一；
- `trigger`：`startup/manual/timeout/fault_injection`；
- `strategy`：本阶段固定 `file_content_hash_v1`；
- 保存 expected pre/post Hash、observed Hash；
- 结论：
  - 等于 postimage：`confirmed_succeeded`；
  - 等于 preimage：`confirmed_not_applied`；
  - 其他值/目标丢失：`manual_required`。

对账记录事实，不悄悄恢复 Agent 对话，也不自动提交 Git。

## 4. Execution Workspace 创建合同

1. 只接受 `capture_status=available`、`dirty=false`、`fingerprint_complete=true`、
   `head_oid`非空的 Snapshot。
2. 先持久化 `preparing`，再运行：
   `git worktree add --detach <managed-root>/<workspace-key> <head_oid>`。
3. Git 命令使用参数数组，不经过 Shell；设置超时；stdout/stderr只保存脱敏摘要。
4. 创建后实测 `rev-parse HEAD`必须等于 `base_revision`，再转为`ready`。
5. 公开 API、Trace和日志只展示 Workspace ID、来源和状态，不展示宿主绝对路径。
6. 活动仓库文件树不得改变；Git worktree 元数据变化不等于源码修改。
7. `preparing`遗留项启动时只做状态/HEAD对账，不重复无条件执行 `git worktree add`。

## 5. 首个写 Tool：`edit`

输入 Schema：

```json
{
  "path": "src/example.py",
  "old_text": "old exact text",
  "new_text": "new exact text"
}
```

约束：

1. `path`必须是非空相对路径，禁止空段、`.`、`..`、绝对路径和 NUL。
2. 逐段 `lstat`，拒绝符号链接/reparse point；目标必须是现有 UTF-8 普通文件。
3. 禁止 `.git`、`.env*`、密钥、凭据和`backend/config.json`。
4. 文件最大 1 MiB；`old_text`必须非空且恰好出现一次；`old_text != new_text`。
5. 批准前生成 bounded unified diff、preimage/postimage Hash；用户批准的是这个精确变化。
6. 执行时重新读取并要求当前 Hash 等于 preimage；不相等则失败关闭，生成新
   ExecutionDraft/ToolOperation 后才能再次批准。
7. 先把 Attempt/Operation 标成`dispatching`，再写临时文件、`fsync`并在同目录
   `os.replace`；最后持久化成功结果。
8. 重复 Gateway 回调：
   - Operation 已成功且 observed Hash 等于 postimage：返回既有结果；
   - Operation 正在/结果未知：拒绝执行并进入对账；
   - 参数 Hash 不同：冲突，不执行。

## 6. 审批绑定

Tool 决策 Subject 必须绑定：

- `tool_definition_revision`
- `operation_hash`
- `arguments_hash`
- `workspace_id`
- `repository_snapshot_id`
- `expected_preimage_hash`
- `expected_postimage_hash`

任何一项变化都创建新 Operation 与新 Request。旧 Grant 只能消费一次。
“跳过人工确认”只改变 `require_human/auto_continue`，不跳过路径防护、工作区隔离、
Operation Ledger 或幂等检查。

## 7. Chat、MAF、pi 与 Gateway 链路

```text
ExecutionDraft(runtime=pi, mode=workspace_edit)
-> RunSpec（不可变）
-> MAF execution_route
-> Execution Workspace prepare
-> pi subprocess（cwd=受管worktree，--no-builtin-tools）
-> pi model call逐次审批
-> pi提出edit
-> Chat预检并创建ToolOperation
-> HITL策略/人工批准
-> pi自定义edit调用Chat Tool Gateway
-> ToolOperation Attempt领取
-> 精确替换
-> Result返回pi
-> pi继续运行
-> 工作区diff投影
-> 结果装配
```

MAF Workflow 拥有节点编排和 Interrupt；Application Coordinator 拥有产品事务；
Workspace Adapter 拥有 Git/文件系统；pi 不能绕过 Gateway 直接使用内置写 Tool。

## 8. 前端设计者视图

工作流节点和 pi 子活动至少展示：

1. Execution Workspace：来源 Snapshot、base revision、状态、变化文件数。
2. Tool Operation：Tool、目标、Operation Hash短码、状态。
3. 审批内容：精确路径、bounded diff、pre/post Hash、风险和批准后动作。
4. Attempt：领取、落盘边界、结果或错误。
5. 对账：为什么进入结果未知、观察到什么、系统为何选择成功/未应用/人工。

节点内容按摘要 -> 字段 -> 原始安全投影渐进展开，不显示隐藏推理和宿主绝对路径。

## 9. 分阶段实施

| 子阶段 | 交付 |
|---|---|
| SD3-A | 本设计、Schema、19号迁移、纯状态机和架构合同 |
| SD3-B | Execution Workspace 创建/恢复/保留，活动仓库不变 |
| SD3-C | `edit`预检、审批绑定、Gateway、Attempt与幂等 |
| SD3-D | `outcome_unknown`与文件Hash对账、故障注入 |
| SD3-E | MAF主Workflow接合、前端设计者视图、真实模型Dogfood |

`write`和受限`bash`必须在`edit`完整故障矩阵通过后另行开放；它们不能通过把
`allowed_tools`改个字符串就获得权限。

## 10. 测试与完成门

### 10.1 合同与状态机

- 非法状态转换、重复 Tool Call ID、不同参数相同回调、旧 Row Version。
- 参数/Workspace/Snapshot变化使旧批准失效。
- 自动批准仍生成 Decision、Grant、Consumption、Operation和Attempt。

### 10.2 文件与 Git

- 路径穿越、绝对路径、符号链接、Protected Source、二进制、大文件、多重匹配。
- source Snapshot dirty/无 HEAD/过期。
- 创建前后活动仓库 `HEAD`、tracked/untracked状态不变。
- worktree base revision正确；仅批准文件发生变化。

### 10.3 故障矩阵

- 领取前死亡：无文件变化，可安全重新领取同一 Operation。
- `dispatching`持久化后、写前死亡：对账为`failed_not_applied`，不自动重放。
- `os.replace`后、成功提交前死亡：对账为`succeeded`，不二次编辑。
- 文件被第三方改动：`manual`。
- 重复 Gateway 回调：返回既有成功或冲突，不产生第二次副作用。
- pi被 SIGKILL：Workspace保留，未决 Operation诚实收敛。

### 10.4 纵向与真实模型

真实模型在一个临时 Git fixture 或受管 Chat worktree 中：

1. 读取目标文件；
2. 提出一次精确编辑；
3. 用户审核模型请求和 Tool Operation；
4. 只修改批准文件；
5. pi返回结果；
6. Web/手机端能展开 Workspace、Operation、Attempt和diff；
7. 活动 Chat 仓库不被改动；
8. 不自动 commit、push或声称 Work 完成。

完成门：上述测试、后端全量、迁移、前端类型/构建/单测和浏览器关键路径通过；
SD3完成只表示“隔离区内一次受治理精确编辑可用”，不外推 SD4-SD8。

## 11. 实施与验证结果

### 11.1 已兑现

1. 第19次Alembic迁移新增Execution Workspace、Tool Operation、Attempt和Reconciliation；仅把
   未修改的SD2默认Tool配置升级为包含`edit`，用户自定义配置保持不变。
2. 受管detached Git worktree只接受干净、完整指纹且HEAD一致的Snapshot；路径不进入公开API、
   Trace或日志。活动仓库的源码、HEAD、index和status不受编辑影响。
3. 精确`edit`绑定Operation/Arguments、Workspace、Snapshot及pre/post Hash；一次性Grant
   Consumption后才执行。Attempt先提交再原子替换，重复回调不产生第二次副作用。
4. 启动和故障对账按文件Hash收敛到`succeeded`、`failed_not_applied`或`manual`；用户取消会拒绝
   未落盘Operation、关闭活动pi进程并保留或显式标记失败的Workspace。
5. 主Workflow升级到v1.7.0/37个真实MAF节点，新增Workspace准备、pi隔离编辑和结果装配；前端可
   查看Workspace基线/变化文件、Operation Diff/Hash、Attempt与Reconciliation。

### 11.2 已验证

1. 后端状态机、路径/symlink/Protected Source/UTF-8/大小/唯一匹配、幂等、落盘前后崩溃、
   第三方修改、启动对账、取消和Workspace保留均有自动测试。
2. Alembic完整升降和Schema漂移检查通过；OpenAPI未变化，Product Schema与Workflow指纹按审核
   后的SD3合同更新。
3. 前端单测、类型/格式检查和生产构建通过；桌面与520 CSS像素窄屏浏览器均能看到37节点、三分支
   路由和新增Workspace节点，页面无横向溢出。
4. 确定性纵向测试证明一次完整精确编辑只发生在临时worktree，源仓库保持干净；拒绝、取消和故障
   不产生假成功。

### 11.3 真实模型证据与未兑现边界

真实模型Dogfood已从自然语言正确编译`workspace_edit` RunSpec，进入`pi_workspace`分支、创建精确
Snapshot worktree并到达pi Provider调用边界。首次出现的HTTP 401来自Chat本机pi Provider Gateway，
不是Ark或DashScope上游；根因是SDK的`Authorization`语义与本地短期执行凭据发生冲突。实现已改为
独立`X-Chat-Pi-Token`，保留规范化Bearer兼容路径，并以常量时间比较、脱敏失败日志和回归测试固定。

修复后的Ark与DashScope首轮重跑曾在远端响应流阶段超时或断连；对应Product Run均保守收敛为
`outcome_unknown`，没有创建Tool Operation，也没有修改Snapshot或活动源码。这些运行继续保留为
安全失败证据。

网络恢复后，DashScope `qwen3.7-plus`在干净的`SD3 Live Fixture`完成本节10.4的完整Dogfood：
Product Run `0872f754-2751-4e18-948b-ce2a6c152b70`、Run Attempt
`6311d124-1509-4c8b-88ca-e6eb63f95a3b`、Runtime Job
`a7a7a46c-6eb4-4c74-9a11-4ccfc1b0783e`和ToolExecution
`a04a1942-f9e8-46d9-9ed1-8185daa20607`均成功。pi经过4次模型调用和`read/edit/read`3次Tool
调用，执行唯一获批Operation `b5f147ac-7332-4143-9c4c-636a947ee740`；Workspace只修改
`README.md`，preimage `047cc9ac...`、postimage与observed `36d8447c...`一致，原Fixture仓库仍
干净。10个Decision Interrupt均只恢复1次，Memory Candidate显式`skip`。因此SD3的“真实pi提出
并完成一次精确edit”门已经通过。

针对Chat活动仓库的当前HEAD复验还证明了另一条安全边界：刷新Snapshot时检测到用户未跟踪文件，
Workspace创建被拒绝，系统没有移动、删除、暂存或提交该文件。该拒绝不影响干净Fixture上的SD3
完成证据，也不能被包装为Chat活动仓库已经具备自动集成能力。

本阶段仍不保证：活动仓库合入、`write/bash/commit/push/deploy`、Validation/Evidence/Artifact、
Work完成提交、pi跨进程续跑或网络外部副作用Exactly-once。
