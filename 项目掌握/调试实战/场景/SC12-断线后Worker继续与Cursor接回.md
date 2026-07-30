# SC12：断线后Worker继续与Cursor接回

<!-- debug-scenario: id=SC12; status=current; oracle=exact -->

**归档日期**：2026-07-30  
**目标**：在收到`RUN_STARTED`后关闭SSE订阅，证明这只断开浏览器，不取消Product Run  
**自动证据**：`backend/tests/test_runtime_execution.py::test_http_disconnect_does_not_cancel_worker_and_cursor_replays_rest`

## 1. 运行前预言机

1. HTTP响应头给出Runtime Job ID和签名Cursor。
2. 浏览器/客户端关闭SSE后，不新增cancel Control Command。
3. Execution Worker继续同一Runtime Job/Run Attempt。
4. Provider/Tool不会因重连自动创建第二个Attempt。
5. Job最终成功后，`GET /api/runtime/jobs/{jobId}/events?cursor=...`返回连续Sequence。
6. 回放最后一条是唯一terminal `RUN_FINISHED`；Product Message可从REST恢复。

## 2. 数据链

```text
AG-UI POST接纳
-> Runtime Job queued
-> Worker claim(lease_owner/epoch)
-> Runtime Event先写Journal
-> SSE订阅读取Event
-> 订阅断开
-> Worker继续追加Event
-> Product终态
-> Cursor Replay补齐缺口
```

`RuntimeJobRecord`拥有`last_event_sequence/earliest_retained_sequence/external_dispatch_state`；
`RuntimeEventRecord`按`runtime_job_id + sequence`唯一，且每Job只允许1条terminal事件。

## 3. 为什么执行不能依赖SSE连接

移动网络、刷新和浏览器后台都会断开连接。如果HTTP连接拥有执行生命周期，用户一切换页面就可能取消模型/Tool，
或重连造成重复执行。持久Job/Worker解耦增加Journal、Cursor和Reconciler复杂度，但建立活动Run恢复和多端投影基础。

## 4. 亲手验证

1. 在浏览器发起一条会运行数秒的请求。
2. 记录Product Run/Runtime Job/当前Cursor。
3. 在`RUN_STARTED`后切断网络或关闭页面，不点“停止”。
4. 等待后端Job终态，再恢复网络/重开Session。
5. 核对同一Job、Sequence连续、Attempt没有增加。

断点：`durable_agent_endpoint`的SSE生成器、`ExecutionWorker._execute_claim`、
`RuntimeExecutionService.append_event`、前端`use-runtime-reconnect.reconnect`。

自动复验：

```bash
.venv/bin/python -m pytest -q \
  backend/tests/test_runtime_execution.py::test_http_disconnect_does_not_cancel_worker_and_cursor_replays_rest
```

## 5. 判定

- 通过：断线后同一Job完成，Cursor补齐1..N且唯一terminal，0隐式取消。
- 失败：断线即cancel；重连创建新Run/Attempt；事件缺口被前端静默忽略。

## 掌握验收

1. Product Run、Runtime Job和SSE订阅哪个拥有执行生命周期？
2. Cursor为什么要签名并带Sequence？
3. 410/Cursor过期时前端应该怎样降级？

