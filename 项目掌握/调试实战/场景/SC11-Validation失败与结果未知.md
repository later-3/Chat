# SC11：Validation失败与结果未知

<!-- debug-scenario: id=SC11; status=current; oracle=exact -->

**归档日期**：2026-07-30  
**方式**：自动故障注入为主；不要为了制造“结果未知”对真实付费Provider或正式仓库做破坏实验  
**自动证据**：`test_failed_validation_only_allows_reject_and_never_completes`、`test_unknown_validation_outcome_produces_no_supports_or_completion`

## 1. 两个必须分开的失败族

| 场景 | 已知事实 | 正确反应 |
|---|---|---|
| `failed` | Validation进程明确返回非0/规则失败 | 产生`refutes` Assessment，只允许reject，不完成Action |
| `outcome_unknown` | 进程已启动但结果无法可信判定 | 不产生Observation/supports/Adoption，不自动重跑，不完成 |

`error`（外发前确定性错误）与`timeout/cancelled`也各有状态，不能全部折成“失败”。

## 2. 运行前预言机

失败分支：Claim可以存在；决策卡`allowed_actions=[reject]`；ResultCommit为rejected；Action仍in_progress；
Artifact rejected；0 Adoption。

结果未知分支：ValidationRun=`outcome_unknown`；0 validation_result Observation；0 supports；0 Adoption；
0 ResultCommit accepted；不允许自动重做可能已有副作用的验证。

## 3. 节点和数据

主Workflow仍可经过节点25–28建立Workspace、Artifact、Contract与Claim。差异发生在节点28的确定性验证结果和
节点29的允许动作：

```text
passed  -> supports -> committable=true  -> accept/reject
failed  -> refutes  -> committable=false -> reject only
unknown -> no proof -> committable=false -> 人工处置/失败关闭
```

节点29的用户reject可以让Product Run以“诚实报告未采纳结果”成功结束；这不表示Action完成。

## 4. 为什么结果未知不能当失败后重试

明确失败可以安全讨论修复；结果未知意味着进程可能已经产生外部效果或部分结果。盲目重试可能重复副作用。
当前保守保留未知状态并等待对账/人工处置，代价是不能自动收敛所有故障；收益是不制造双执行和假证据。

## 5. 验证

```bash
.venv/bin/python -m pytest -q \
  backend/tests/test_result_pipeline.py::test_failed_validation_only_allows_reject_and_never_completes \
  backend/tests/test_result_pipeline.py::test_unknown_validation_outcome_produces_no_supports_or_completion
```

重点SQL：

```sql
SELECT status, exit_code FROM validation_runs;
SELECT verdict FROM evidence_assessments;
SELECT COUNT(*) FROM claim_evidence_adoptions;
SELECT status FROM action_items WHERE id='<Action ID>';
```

## 6. 判定

- 通过：failed只可reject；unknown无支持证据；两者都不完成Action。
- 失败：把进程退出等同Work完成；unknown自动重试；为了让UI有内容伪造Observation。

## 掌握验收

1. `failed`与`outcome_unknown`为什么需要不同恢复语义？
2. Product Run succeeded时Action为何仍可in_progress？
3. 哪几张表必须在unknown场景保持0行？

