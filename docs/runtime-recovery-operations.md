# Workflow Checkpoint 与 Outbox Worker 运行说明

## 1. 两种部署形态

本地单进程默认继续使用：

```bash
.venv/bin/python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8030
```

这个入口在API进程内启动一个Outbox循环，适合本地开发，不要求额外进程。

生产拆分形态使用两个进程：

```bash
.venv/bin/python -m uvicorn backend.app.main:create_api_app --factory --host 127.0.0.1 --port 8030
.venv/bin/python -m backend.app.outbox_worker
```

API只把决定与Outbox事件原子提交到Product DB；Worker用数据库Lease领取事件，从绑定的MAF Checkpoint恢复Workflow。多个Worker可以竞争，同一事件只有一个有效Lease。

## 2. 可观察日志

以下稳定事件不记录Prompt、Provider Body、密钥或Checkpoint正文：

1. `human_decision_recorded`：决定及Outbox事务已经提交。
2. `maf_checkpoint_saved`、`maf_checkpoint_loaded`：Checkpoint索引保存或加载。
3. `runtime_interrupt_bound`：Product Decision Request已绑定MAF安全点。
4. `runtime_interrupt_status_changed`：恢复状态变化。
5. `governance_outbox_published`、`governance_outbox_failed`：投递成功或进入重试。
6. `workflow_checkpoint_restored`、`runtime_resume_completed`：新进程完成恢复。

运行治理查询`GET /api/runs/{run_id}/governance`会返回脱敏的`runtime_interrupts`、`workflow_checkpoints`和`outbox_events`，不会返回Checkpoint正文。

## 3. 运维动作

1. `.venv/bin/python -m backend.app.outbox_worker --once`只处理当前可领取批次后退出，可用于部署探针和人工排障。
2. Pending事件按指数退避重试，达到8次进入`dead_letter`；不会静默丢弃。
3. `recovery_required`表示Workflow图版本、Checkpoint或绑定合同不兼容，必须人工决定Retry、Restart或迁移，不能自动重跑。
4. 当前恢复保证只覆盖`continuous-collaboration v1.2.0`中的无外部Tool副作用审批安全点；不承诺任意Workflow、嵌套Workflow或Tool Exactly-once。

## 4. 升级门

当前安装的`agent-framework-ag-ui==1.0.0rc8`没有把`checkpoint_id`传给MAF `Workflow.run`。项目在图签名、Workflow版本和Product Run绑定校验后，使用隔离的MAF Runner恢复桥；升级MAF或AG-UI时必须先跑完整后端测试和跨OS进程Worker测试，再决定是否移除该桥。
