# SC10：隔离精确edit与Evidence提交

<!-- debug-scenario: id=SC10; status=conditional; oracle=exact -->

**归档日期**：2026-07-30  
**目标**：在受管Git worktree修改1个已存在文件，经确定性Validation、Evidence与Result Commit推进Action  
**自动证据**：`test_continuous_workflow_governs_exact_edit_in_isolated_workspace`、`test_result_commit_gate_completes_action_after_accepted_validation`

## 1. 当前可运行边界

手动运行需要：Project/Work/Action/Plan、干净Repository Snapshot、可用pi Profile、Artifact Store scope密钥、
冻结Validation Contract。`PROJECT_STATE.md`记录当前私有部署尚未配置Artifact scope密钥，因此本机手动运行
可能在Evidence前失败关闭；自动测试使用独立临时Store完整跑通。不要读取私有配置来绕过此门。

当前只支持受管worktree内对**已存在文件**做绑定preimage hash的精确`edit`。不授权任意`write/bash/commit/
push/deploy`，也不直接改活动仓库。

## 2. 运行前预言机

| 阶段 | 必须出现 |
|---|---|
| 准备 | Workspace绑定Repository Binding/Snapshot/base revision，源仓库保持不变 |
| Tool | Edit Operation有preimage/postimage/observed hash和一次性Grant |
| 产物 | Workspace diff形成内容寻址Artifact revision |
| 验证 | 固定Capability/argv/executable/environment hash；网络默认拒绝 |
| Evidence | Claim非空mandatory Requirements；Observation/Assessment逐条支持 |
| 决定 | `result_claim_decision`只允许当前Claim hash/row_version的accept/reject |
| 提交 | ResultCommit accepted；Action completed；父Work仍in_progress |
| 禁止 | 不commit/push，不修改活动仓库，不凭模型自述完成 |

## 3. 39节点路径

```text
1–16 共用理解链
-> 19 planning_agent -> 20 plan_acceptance
-> 21–24 ExecutionDraft/授权/RunSpec/pi_workspace
-> 25 execution_workspace_prepare
-> 26 pi_workspace_dispatch
-> 27 pi_workspace_result_assembly
-> 28 result_claim_prepare
-> 29 result_claim_decision
-> 33 turn_summary_agent
-> 34–39 提交链与Product终态
```

节点17、18、30、31、32不走。完整成功路径为34个节点、5个未访问节点；模型/Tool内部活动不是额外MAF节点。

## 4. 每个关键节点的数据

| 节点 | 输入 | 输出/Store |
|---|---|---|
| 25 | RunSpec、Snapshot、Repository fence | `execution_workspaces` ready记录与安全locator |
| 26 | StepInput、Tool allowlist、Workspace | ToolExecution、Operation/Attempt/Grant、pi Session |
| 27 | ToolExecution终态、Git diff | diff hash、changed paths、Workspace retained |
| 28 | Plan Validation Contract、diff bytes | Artifact/Revision、ValidationRun、Claim/Requirements、Observation/Assessment |
| 29 | Claim id/hash/row_version、Decision | ResultCommit、Adoption、Action CAS状态变化、Trace/Outbox |
| 33–39 | 已提交Result/Evidence引用 | TurnSummary、候选决定、Assistant Message、双Trace |

成功测试的精确持久化断言包括：1个ValidationContract、1个CompletionClaim、1个ValidationRun、1个
ResultCommit、1个Artifact/Revision；`validation_result`与`file_hash_match`两类Requirement各有支持证据和
Adoption。数量由该单文件单规则Fixture决定，不应外推复杂任务也永远是1。

## 5. 为什么不能“测试退出码0就完成Work”

退出码只说明某个进程结果，不证明它针对当前Action revision、当前Snapshot、当前Artifact，也不证明Evidence仍
有效或用户接受产物。Result Commit在单事务内复检Claim、Requirement、Artifact字节、来源新鲜度、Decision与CAS，
代价是对象多、提交更严格；收益是不会把模型自述、旧测试或被篡改Artifact写成完成事实。

## 6. 亲手/自动验证

手动断点：`ExecutionWorkspacePrepareExecutor`、`PiWorkspaceDispatchExecutor`、
`ResultPipelineCoordinator.prepare`、`ResultValidationRunner`、`ResultCommitCoordinator.commit`。

安全SQL只查状态、Hash前缀和计数，不查Artifact正文：

```sql
SELECT status, substr(diff_hash,1,12) FROM execution_workspaces WHERE product_run_id='<Run ID>';
SELECT status, capability_key, exit_code FROM validation_runs WHERE runtime_job_id='<Job ID>';
SELECT status, substr(claim_hash,1,12) FROM completion_claims WHERE subject_id='<Action ID>';
SELECT commit_status, artifact_disposition, pre_commit_validity_check_passed,
       committed_subject_state FROM result_commits WHERE completion_claim_id='<Claim ID>';
```

自动复验：

```bash
.venv/bin/python -m pytest -q \
  backend/tests/test_continuous_pi_workspace.py::test_continuous_workflow_governs_exact_edit_in_isolated_workspace \
  backend/tests/test_result_pipeline.py::test_result_commit_gate_completes_action_after_accepted_validation
```

## 7. 判定

- 通过：活动仓库不变，Workspace有精确diff，Evidence链完整，Action完成而Work不假完成。
- 失败：无Operation却生成Claim；Validation未知仍supports；提交时不复核Artifact字节；自动commit/push。

## 掌握验收

1. 为什么pi执行成功还不能直接把Action置completed？
2. Claim hash和row_version分别防什么？
3. 为什么父Work保持in_progress？
4. Artifact Store未配置时为什么必须失败关闭？

