# 持续协作工作流 · 阶段 A 逐节点解析

## 阶段总览

阶段 A 的职责是**输入接纳与上下文召回**：把用户的原始输入转化为有界的上下文候选，交给后续意图识别节点。

```
用户输入 (AG-UI 消息数组)
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ 节点1: input_acceptance                                      │
│   输入: list[AG-UI Message]                                  │
│   输出: CollaborationState (初始)                             │
│   职责: 提取 prompt、召回 TurnSummary、恢复待回答澄清          │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ 节点2: context_candidates                                    │
│   输入: CollaborationState                                   │
│   输出: CollaborationState (recent_turn_summaries 收窄到≤4)   │
│   职责: 确定性关键词排序，待回答澄清优先                        │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ 节点3: harness_directory_context                             │
│   输入: CollaborationState                                   │
│   输出: CollaborationState (+ project_matches,               │
│          context_items, directory_context_package_id)         │
│   职责: 从 Product Store 查询 Project 目录 + TurnSummary，     │
│         装配 ContextPackage 并持久化                           │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ 节点4: context_adoption (HITL)                               │
│   输入: CollaborationState                                   │
│   输出: CollaborationState (可能修改 context_items)           │
│   职责: 用户审核/修改/跳过本轮上下文候选                        │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
┌──────────────────────────────────────────────────────────────┐
│ 节点5: directory_context_revision                            │
│   输入: CollaborationState                                   │
│   输出: CollaborationState (投影最新 ContextPackage revision) │
│   职责: 确保被排除的 Context 从运行状态中彻底移除               │
└──────────────────────────────────────────────────────────────┘
    │
    ▼
  进入阶段 B (意图识别)
```

---

## 节点 1: `input_acceptance`

### 代码位置

`backend/app/workflows/continuous_chat.py` → `IntakeExecutor`

### 输入

```python
@handler(input=list)  # AG-UI 消息数组
async def accept(self, messages: list[Any], ctx: WorkflowContext[CollaborationState]) -> None:
```

这是整个 Workflow 的入口。MAF 把 AG-UI 协议中的消息数组直接传进来。

### 执行步骤

```
1. normalize_agui_messages_for_provider(messages)
   → 过滤掉 Workflow 内部协议消息（审批卡片等），只保留用户/模型对话内容

2. 取最后一条 role="user" 的消息文本 → origin_prompt
   → 如果没有任何 user 消息 → raise ValueError
   → 如果 prompt 为空 → raise ValueError

3. governance.recent_turn_summaries(thread_id, limit=8)
   → 从 Product Store 查询最近 8 条 TurnSummary
   → TurnSummary 是上一轮结束时由 turn_summary_agent 提取的主题摘要
   → 包含 topic、confirmed_facts、decisions、open_questions、project_hint 等

4. intents.latest_open_clarification(thread_id)
   → 查询是否有未回答的澄清请求
   → 如果有 → pending_clarification = {id, question, status, ...}
   → 如果没有 → pending_clarification = None

5. 从 summaries 中提取 project_hint（去重）→ project_candidates

6. 构造初始 CollaborationState:
   CollaborationState(
       origin_prompt=prompt,
       recent_turn_summaries=tuple(summaries),     # 最多 8 条
       project_candidates=project_candidates,       # 从摘要中提取的项目提示
       pending_clarification=pending_clarification, # 待回答澄清（可能为 None）
   )

7. _trace_content() → 记录 Product Trace
8. ctx.send_message(state) → 传递给节点 2
```

### 输出

`CollaborationState` 初始实例，关键字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `origin_prompt` | `str` | 用户本轮原始输入 |
| `recent_turn_summaries` | `tuple[dict, ...]` | 最近 8 条 TurnSummary |
| `project_candidates` | `tuple[str, ...]` | 从摘要中提取的项目提示（去重） |
| `pending_clarification` | `dict \| None` | 未回答的澄清请求 |

### 关键不变量

1. **完整历史不进入 Workflow**：消息历史由 Product Session 持久保存为证据；Workflow 只携带 TurnSummary 候选，避免每轮无界重放全部历史。
2. **最后一条 user 消息是 prompt**：不是拼接全部历史，只取最后一条。模型上下文由后续节点显式装配。
3. **待回答澄清是独立通道**：`pending_clarification` 来自 `ClarificationRequestRecord` 表，不是从 TurnSummary 推断的。

### 设计原因

为什么不把全部历史传给模型？

- Token 成本：每轮都重放全部历史会导致 Token 线性增长
- 噪声：早期对话对当前意图可能完全无关
- 控制：用户应该能看见系统"理解了什么"，而不是被动接受一个无界拼接的上下文
- TurnSummary 是可重建的派生物：原始 Message 仍在 Product Store，摘要失败可重建

---

## 节点 2: `context_candidates`

### 代码位置

`backend/app/workflows/continuous_chat.py` → `CandidateContextExecutor`

### 输入

`CollaborationState`（来自节点 1）

### 执行步骤

```
1. _context_keywords(origin_prompt)
   → 从 prompt 中提取关键词（中文分词 + 英文单词）
   → 用于后续与 TurnSummary 的关键词交集计算

2. 分离 pending（待回答澄清对应的摘要）：
   pending = [s for s in summaries if s.summary.awaiting_user_answer == True]

3. 对其余摘要按关键词命中数打分：
   for summary in summaries:
       if summary in pending: continue  # pending 单独处理
       searchable = json.dumps(summary).lower()
       score = sum(1 for kw in keywords if kw in searchable)
       if score > 0: scored.append((score, summary))

4. 排序：pending 优先（最多 1 条），其余按得分降序
   selected = pending[:1] + sorted(scored)[:3]  # 总共最多 4 条

5. replace(state, recent_turn_summaries=selected)
   → 把 8 条收窄为 ≤4 条

6. _trace_content() → 记录选择规则
7. ctx.send_message(next_state) → 传递给节点 3
```

### 输出

`CollaborationState`，`recent_turn_summaries` 从 ≤8 条收窄为 ≤4 条。

### 关键不变量

1. **不调用模型**：这是纯确定性逻辑，零 Provider 成本。
2. **待回答澄清永远优先**：如果上一轮系统问了问题用户还没回答，这条摘要一定被带回。
3. **只是候选**：这里的选择不是最终采用，节点 4 的 HITL 决定点可以修改、跳过或全部排除。

### 设计原因

为什么待回答澄清优先？

- 用户可能直接回答了问题（如"贪吃蛇"），系统需要知道这个输入是在回答之前的澄清
- 如果不优先带回，意图模型看不到澄清上下文，可能把回答误判为新任务
- 这是"连续协作"的核心：系统记住自己问了什么，用户的回答能被正确关联

为什么最多 4 条？

- Token 预算控制：每条摘要约 200-500 token，4 条约 800-2000 token
- 信噪比：超过 4 条时，远处的摘要对当前意图的关联度通常很低
- 后续节点（意图识别）会进一步筛选，不需要在这里给太多

---

## 节点 3: `harness_directory_context`

### 代码位置

`backend/app/workflows/continuous_chat.py` → `HarnessDirectoryContextExecutor`

### 输入

`CollaborationState`（来自节点 2）

### 执行步骤

```
1. harness.directory_context_items(prompt, summaries)
   → 调用 HarnessContextQueryService.directory_context_items()
   → 从 Product Store 查询：
     a. 所有正式 Project（proposed/active/paused），按关键词匹配排序
     b. 把节点 2 选中的 TurnSummary 包装为 context item
     c. 其他 ContextContributor（如 Repository Snapshot）的目录项
   → 返回 (items, projects)：
     - items: list[ContextItem]，每个有 source_kind/source_id/title/content/adopted/reason
     - projects: list[Project]，匹配的正式 Project 列表

2. harness.create_context_package(
       session_id, run_id, stage="directory",
       items=items, token_budget=1800, status="candidate"
   )
   → 在 Product Store 中持久化一个 ContextPackage 记录
   → 每个 item 有 ordinal/source_kind/source_id/source_revision/title/content/adopted/reason/token_estimate
   → 按 token_budget=1800 截断：超出的 item 标记 adopted=False
   → package_hash 保证内容完整性
   → status="candidate"：还需要节点 4 用户确认

3. replace(state,
       project_matches=tuple(projects),           # 匹配的正式 Project 列表
       context_items=tuple(item for item in package["items"] if item["adopted"]),
       directory_context_package_id=package["id"], # 持久化 ID，后续 revision 用它关联
   )

4. _trace_content() → 记录 adopted/excluded 明细
5. ctx.send_message(next_state) → 传递给节点 4
```

### 输出

`CollaborationState`，新增字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `project_matches` | `tuple[dict, ...]` | 从 Product Store 查到的匹配 Project |
| `context_items` | `tuple[dict, ...]` | 被采用的 Context 项（≤token_budget） |
| `directory_context_package_id` | `str` | 持久化 ContextPackage 的 ID |

### 关键不变量

1. **从 Product Store 读取，不从聊天猜**：Project 是否存在、状态如何，只从权威 Product DB 查询。模型不能编造 Project 事实。
2. **ContextPackage 是不可变的**：一旦创建，内容不能修改。用户修改会创建新 revision。
3. **Token 预算硬截断**：`create_context_package` 在持久化时就截断超预算的 item，不是模型看到后再截。
4. **stage="directory"**：这是阶段 A 的目录级上下文，与阶段 B 的 `stage="detail"` 分开。

### 设计原因

为什么要持久化 ContextPackage 而不是只在内存中传递？

- **可审计**：用户可以在工作台查看"系统准备了什么上下文"
- **可修改**：用户在节点 4 可以修改采用/排除，修改产生新 revision
- **可恢复**：Checkpoint 恢复时从 package_id 读取最新 revision，不依赖内存状态
- **版本化**：每次修改都有 revision + hash，旧审批在内容变化后自动失效

---

## 节点 4: `context_adoption` (HITL)

### 代码位置

`backend/app/workflows/continuous_chat.py` → `ProductDecisionExecutor`（参数化为 `context_adoption`）

### 输入

`CollaborationState`（来自节点 3）

### ProductDecisionSpec 配置

```python
ProductDecisionSpec(
    key="context_adoption",
    subject_kind="context_package",
    title="确认本轮采用的上下文",
    description="这些主题摘要将进入后续意图识别；完整历史仍只作为证据保留。",
    accept_action="accept",
    applicable=lambda state: bool(state.recent_turn_summaries or state.project_matches),
    subject=lambda state: {
        "selected_summaries": list(state.recent_turn_summaries),
        "project_directory_matches": list(state.project_matches),
        "context_package_id": state.directory_context_package_id,
    },
    editable_fields=lambda state: [{
        "key": "selected_summary_ids",
        "label": "采用的主题摘要",
        "type": "multi_select",
        "value": [str(s["id"]) for s in state.recent_turn_summaries],
        "options": [{"value": str(s["id"]), "label": str(s["topic"])} for s in state.recent_turn_summaries],
    }],
    revise=_revise_context,
    allow_skip=True,  # 用户可以跳过本轮上下文
)
```

### 执行步骤（`ProductDecisionExecutor._advance`）

```
1. 注册 Subject（决策对象）到治理层：
   governance.register_subject(
       subject_kind="context_package",
       resource_id=f"{run_id}:context_adoption",
       subject_content={selected_summaries, project_matches, package_id},
       ...
   )
   → 持久化 DecisionSubjectRecord，计算 subject_hash

2. 检查 applicable：
   → 如果 recent_turn_summaries 和 project_matches 都为空 → 不适用
   → 记录 not_applicable，直接传递给节点 5

3. 评估 HITL 策略：
   governance.evaluate_subject(subject, decision_point_key, scopes, facts)
   → 按 scope 层级（product_default → principal → session → interaction → run → workflow → node → scenario）
   → 查找匹配的策略规则
   → 返回 final_action: "deny" | "auto_continue" | "waiting_human"

4a. 如果 deny → PermissionError，Run 失败
4b. 如果 auto_continue → 记录 Decision + Grant，直接传递给节点 5
4c. 如果 waiting_human（默认）：
    → 创建 HumanDecisionRequest
    → 构造审批卡片 card = {
        review_kind: "product_decision",
        title: "确认本轮采用的上下文",
        subject: {selected_summaries, project_matches},
        editable_fields: [{key: "selected_summary_ids", type: "multi_select", ...}],
        allowed_actions: ["accept", "revise", "skip", "cancel"],
        execution_context: {workflow_state: asdict(state)},  # 完整状态快照
    }
    → ctx.request_info(card) → MAF 中断，等待用户决定
```

### 用户决定后的恢复（`resolve`）

```
用户在前端看到审批卡片，可以选择：

accept → 接受当前上下文
  → resolve_single_human_request(decision="accept")
  → consume_grant()
  → ctx.send_message(state) → 传递给节点 5

revise → 修改采用的摘要
  → 前端发送 changes = {selected_summary_ids: [...]}
  → _revise_directory_context_if_needed()：
    → 读取 ContextPackage
    → 调用 collaboration_contexts.revise_package() 创建新 revision
    → 返回新的 CollaborationState（context_items 已更新）
  → _advance(context_state) → 重新进入治理评估（新 hash → 新审批）

skip → 跳过本轮上下文
  → _revise_directory_context_if_needed()：
    → 把所有 item 的 adopted 设为 False
    → 创建新 revision
  → ctx.send_message(revised_state) → 传递给节点 5（空上下文）

cancel → 停止 Run
  → abandon_active_run()
  → ctx.yield_output("当前Run已按用户决定停止")
```

### 输出

`CollaborationState`，可能被用户修改（revise/skip 会改变 `context_items`）。

### 关键不变量

1. **修改产生新 revision**：用户修改上下文不是原地修改，而是创建新 ContextPackage revision + 新 hash。
2. **新 hash 导致旧审批失效**：如果用户修改后，旧审批的 binding_hash 不再匹配，必须重新审批。
3. **skip 不等于空**：skip 创建一个所有 item 都 adopted=False 的新 revision，仍然有持久化记录。
4. **Checkpoint 包含完整状态**：`execution_context.workflow_state = asdict(state)` 确保中断恢复时能完全重建。

### 设计原因

为什么上下文需要用户确认？

- 系统召回的摘要可能不准确（关键词匹配有误）
- 用户可能不想让某些历史信息进入模型上下文
- 用户可能想排除某些 Project 匹配
- 这是"用户可介入"原则的直接体现

---

## 节点 5: `directory_context_revision`

### 代码位置

`backend/app/workflows/continuous_chat.py` → `HarnessContextRevisionExecutor`（`stage="directory"`）

### 输入

`CollaborationState`（来自节点 4）

### 执行步骤

```
1. harness.context_package_for_run(run_id, stage="directory")
   → 从 Product Store 查询当前 Run 的 directory 阶段最新 ContextPackage
   → 如果节点 4 用户修改了，这里读到的是新 revision
   → 如果节点 4 用户接受了，这里读到的还是原 revision
   → 如果节点 4 不适用（跳过了），这里可能返回 None

2. 如果 package is None → 直接传递 state 给节点 6

3. _state_with_context_package(state, package, stage="directory")
   → 从 package 中提取 adopted=True 的 items → context_items
   → 从 adopted items 中提取 turn_summary 的 source_id → 过滤 recent_turn_summaries
   → 从 adopted items 中提取 project_directory 的 source_id → 过滤 project_matches
   → 确保被用户排除的 Context 从运行状态中彻底移除

4. _trace_content() → 记录 adopted/excluded 来源明细
5. ctx.send_message(next_state) → 传递给节点 6（意图识别）
```

### 输出

`CollaborationState`，`context_items` / `recent_turn_summaries` / `project_matches` 都被投影为最新 revision 的采用集合。

### 关键不变量

1. **从持久化读取，不从内存推断**：即使节点 4 用户接受了原 revision，这里仍然从 Product Store 重新读取，确保一致性。
2. **排除是彻底的**：用户排除的 TurnSummary 不仅从 `context_items` 移除，还从 `recent_turn_summaries` 移除。后续节点看不到被排除的内容。
3. **幂等**：多次执行（如 Checkpoint 恢复）读取同一个 revision，结果相同。

### 设计原因

为什么需要这个节点？节点 4 不是已经修改了 state 吗？

- **解耦**：节点 4 负责治理（审批/修改/跳过），节点 5 负责投影（把持久化事实映射回运行状态）
- **恢复安全**：Checkpoint 恢复时，节点 4 的 `resolve` 可能只修改了 Product Store 的 revision，没有修改内存中的 state。节点 5 确保从 Product Store 重新读取最新 revision。
- **一致性**：如果节点 4 和节点 5 之间发生了进程重启，节点 5 从 Product Store 读取保证不会丢失用户的修改。

---

## 阶段 A 总结

### 数据流

```
AG-UI 消息数组
    │
    ▼ [节点1]
origin_prompt + 8条TurnSummary + pending_clarification
    │
    ▼ [节点2]
origin_prompt + ≤4条TurnSummary（澄清优先 + 关键词排序）
    │
    ▼ [节点3]
+ project_matches（从Product Store查询）
+ context_items（Project目录 + TurnSummary + 其他来源）
+ directory_context_package_id（持久化ID）
    │
    ▼ [节点4: HITL]
用户审核/修改/跳过 → 可能产生新ContextPackage revision
    │
    ▼ [节点5]
context_items/recent_turn_summaries/project_matches 投影为最新revision的采用集合
    │
    ▼
进入阶段 B（意图识别）
```

### 阶段 A 的保证

1. **用户输入不丢失**：`origin_prompt` 原样传递，不被截断或改写。
2. **上下文是有界的**：最多 4 条 TurnSummary + Token 预算 1800，不会无界增长。
3. **Project 事实来自权威源**：从 Product Store 查询，不从聊天猜。
4. **用户可介入**：节点 4 让用户审核、修改、跳过或取消。
5. **状态可恢复**：ContextPackage 持久化在 Product Store，Checkpoint 恢复时从 revision 读取。
6. **排除是彻底的**：用户排除的内容从运行状态中完全移除，不会残留在后续节点的输入中。

### 阶段 A 不保证的

1. **不识别意图**：意图识别在阶段 B 的节点 6。
2. **不绑定 Project**：节点 3 只是查询匹配的 Project 候选，正式绑定在阶段 B 的节点 10-11。
3. **不加载 Project 详情**：阶段 A 只加载轻量目录，详情在阶段 B 的节点 12。
4. **不发送模型请求**：阶段 A 全部是确定性逻辑，零 Provider 成本。
