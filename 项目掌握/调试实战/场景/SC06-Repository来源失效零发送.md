# SC06：Repository来源失效时零发送

<!-- debug-scenario: id=SC06; status=current; oracle=exact -->

**归档日期**：2026-07-30  
**目标**：批准旧模型请求后改变Repository事实，证明发送前新鲜度门阻断旧Context  
**自动证据**：`test_repository_source_change_invalidates_old_model_approval_before_attempt`、`test_repository_change_stops_pi_before_process_dispatch`

## 1. 安全前置

只在测试Fixture或你明确允许修改的仓库中制造变化；不要为实验改正式Chat工作树。优先直接运行自动用例。
手动实验使用Repository绑定的安全刷新入口，不读取私有配置或秘密文件。

## 2. 运行前预言机

| 时点 | 预期 |
|---|---|
| Context装配 | 绑定Repository Snapshot ID、Semantic Hash与治理文档Hash |
| 用户审批 | Approval绑定当时的Context/Source revision |
| 来源变化 | HEAD、Binding代次、Semantic Hash或治理文档任一变化会使旧上下文过期 |
| Provider发送前 | `RepositorySourceFreshnessGuard`再次核对并抛`context_source_stale` |
| 外部副作用 | Provider Attempt=0；pi进程=0；Tool Operation=0 |
| 产品结果 | Run可恢复失败；UI提供按最新仓库重新准备，而不是自动重放 |

## 3. 代码与数据链

```text
Repository Binding/Snapshot
-> detail Context Item(source_id + source_revision)
-> ContextPackage hash
-> ExecutionDraft/ModelCallDraft binding hash
-> 用户批准
-> Provider/pi dispatch前再次读取最新Snapshot
-> 不一致：失败关闭，旧Approval失效
```

关键符号：`RepositorySourceFreshnessGuard`、`GovernedSemanticAgentExecutor._require_fresh_context`、
`ExecutionDispatchService`的pi派发前Fence。

## 4. 为什么要检查3次

系统在Draft准备、用户审批和真实dispatch之间可能经过几分钟甚至进程恢复。只在装配Context时检查一次会产生
TOCTOU窗口：用户批准的是旧仓库，实际执行却针对新仓库。重复核验带来额外Git/数据库读取，但避免错误代码基线、
旧规则和未审核副作用。

## 5. 亲手验证

1. 使用已绑定Repository的Project发起需要读取仓库的问题。
2. 在模型审批卡停住，记录Snapshot ID和Context hash。
3. 在安全Fixture产生一个可识别的新提交或治理文档变化并刷新Snapshot。
4. 批准旧卡。
5. 观察Run以`context_source_stale`失败，Attempt数仍为0。
6. 点击“按最新仓库重新准备”，应创建新Run/新Context/新审批，不复用旧Hash。

只读核对：

```sql
SELECT status, failure_code FROM product_runs WHERE id='<Product Run ID>';
SELECT COUNT(*) FROM model_call_attempts WHERE run_id='<Product Run ID>';
SELECT external_dispatch_state FROM runtime_jobs WHERE product_run_id='<Product Run ID>';
```

## 6. 判定

- 通过：`context_source_stale`、0 Attempt、0 pi/Tool副作用、用户能显式重新准备。
- 失败：先发Provider再发现过期；自动重试旧请求；只比较HEAD却忽略治理文档/Binding代次。

## 掌握验收

1. 为什么Approval存在仍不能直接发送？
2. Semantic Hash相同的新Snapshot是否一定要阻断？回到代码/设计查依据。
3. 为什么“重新准备”应创建新绑定而不是Resume旧Provider Attempt？
