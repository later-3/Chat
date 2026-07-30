# SC14：Retry与Restart血缘

<!-- debug-scenario: id=SC14; status=current; oracle=exact -->

**归档日期**：2026-07-30  
**目标**：明确失败后“原样重试”和“修改后重新开始”是两个命令，都创建新Product Run  
**自动证据**：`test_failed_run_retry_and_edited_restart_keep_explicit_lineage`、`test_retry_rejects_modified_prompt_without_creating_run`

## 1. 运行前预言机

| 动作 | 输入约束 | 新Run字段 | 旧Run |
|---|---|---|---|
| Retry | Prompt必须与来源Run一致 | `retry_of_run_id=<source>`、`retry_mode=retry` | 不改写 |
| Restart | Prompt允许修改 | `retry_of_run_id=<source>`、`retry_mode=restart` | 不改写 |

两者都重新进入Context新鲜度、ExecutionDraft/Approval和Provider治理；都不是Workflow Checkpoint Resume。

## 2. 数据链

```text
Run A failed
-> Retry -> Run B(retry_of=A, input same)
-> Run B failed
-> Restart edited -> Run C(retry_of=B, input changed)
```

Provider上下文会排除重试祖先输入链的重复副本，避免模型看到同一Prompt多次；Product历史仍保留失败输入作为证据。

## 3. 为什么不复用旧Run/Attempt

改写旧终态会破坏计费、错误、Trace和用户决策证据；把修改后的输入叫Retry又会伪造“同一请求”。新Run血缘增加
记录数量，但能精确回答每次尝试使用什么输入、为何重来、是否重新授权。

## 4. 亲手验证

1. 选择一个明确失败且允许重做的Run。
2. 原样Retry，确认新Run和新审批。
3. 再修改Prompt；若仍选择Retry，服务端应拒绝且不创建Run。
4. 改用Restart，确认新Run绑定修改后的输入。

```sql
SELECT r.id, substr(m.content_hash,1,12) AS input_hash12,
       r.status, r.retry_of_run_id, r.retry_mode
FROM product_runs r
JOIN product_messages m ON m.id=r.current_user_message_id
WHERE r.session_id='<Session ID>' ORDER BY r.started_at;
```

自动复验：

```bash
.venv/bin/python -m pytest -q \
  backend/tests/test_product_sessions.py::test_failed_run_retry_and_edited_restart_keep_explicit_lineage \
  backend/tests/test_product_sessions.py::test_retry_rejects_modified_prompt_without_creating_run
```

## 5. 判定

- 通过：旧Run不变、新Run有血缘、Retry拒绝改Prompt、Restart重新审批。
- 失败：复用旧Attempt；修改输入仍标Retry；把Restart称为Checkpoint Resume。

## 掌握验收

1. Retry与Run Attempt重试是同一对象吗？
2. 为什么Provider历史要排除重试祖先输入，而Product历史不能删除它？
3. 哪个动作才会从MAF Checkpoint安全点继续？
