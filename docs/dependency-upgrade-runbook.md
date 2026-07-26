# 关键依赖升级手册

## 1. 当前锁定基线

| 依赖 | 当前版本 | 高风险使用点 |
|---|---:|---|
| `agent-framework-core` | 1.11.0（由`uv.lock`锁定） | Workflow、Checkpoint、RequestInfo、私有Runner恢复 |
| `agent-framework-openai` | 1.10.1 | Agent与OpenAI兼容Provider接合 |
| `agent-framework-ag-ui` | 1.0.0rc8 | AG-UI SSE、Interrupt/Resume；当前不转发`checkpoint_id` |
| `@ag-ui/client` / `@ag-ui/core` | 0.0.57 | Web事件投影、Thread/Run、Interrupt |
| pi | 0.82.0运行时合同 | JSONL RPC、内部Tool拦截、Provider Gateway |
| Playwright | 1.61.1 | 桌面/窄屏真实浏览器门 |
| `c8` | 12.0.0 | Node 20/22一致的前端源码覆盖率与阈值门 |

版本事实以`uv.lock`、`frontend/package-lock.json`和运行时合同为准；本文只记录升级风险与步骤。

## 2. 私有或脆弱接合登记

1. `workflows/checkpoints.py`使用MAF私有Checkpoint编码函数。
2. `workflows/runtime.py`使用`workflow._runner_context`与`workflow._runner.restore_from_checkpoint`，弥补AG-UI RC8不转发Checkpoint ID。
3. 多个受治理Executor使用私有`RequestInfoMixin`。
4. `workflows/visible_executor.py`使用私有类型判断工具转发嵌套Workflow生命周期。
5. pi通过外部CLI的JSONL RPC和本地Provider Gateway接入，不是MAF原生持久Session。

每一项都必须保留安装版合同测试和替代计划。目标替代是：优先使用MAF公开Checkpoint/Resume、公开RequestInfo与嵌套事件API；若上游仍无公开能力，则继续隔离在Adapter中，禁止扩散到领域层。

## 3. 升级步骤

1. 新建升级分支，记录旧/新锁文件和上游Release Note；不得直接修改私有`backend/config.json`。
2. 先只更新一组强关联依赖：MAF三包、AG-UI前后端，或pi Runtime；不要同时升级框架、数据库和前端构建链。
3. 执行`UV_PROJECT_ENVIRONMENT=.venv uv sync --frozen --dev`与`npm ci`，确认实际安装版本。
4. 运行`./scripts/verify-fast.sh`，再运行`./scripts/verify-fault-lab.sh`和`./scripts/verify.sh`。
5. 核对OpenAPI、Product Schema和Workflow Catalog指纹；任何变化必须先判断是计划内合同升级还是回归。
6. MAF升级必须验证Checkpoint编码、私有Runner恢复、Pending Request、终态顺序和子Workflow事件。
7. AG-UI升级必须验证SSE事件顺序、Cursor重放、Interrupt/Resume、断线不取消和前端投影。
8. pi升级必须验证JSONL RPC命令、Tool拦截、逐次Provider审批、超时与进程退出。
9. Provider协议变化必须分别运行Responses与Chat Completions规范Body测试；真实模型回归使用显式受控Job，普通PR不自动计费。
10. 覆盖率、Playwright或其他测试工具升级后必须重新运行许可证策略；当前`c8`传递依赖使用SPDX `BlueOak-1.0.0`，分发时需保留许可证文本或官方链接。

## 4. 失败与回退门

以下任一情况禁止合并：审批Hash与发送字节不一致、旧Epoch可写终态、Checkpoint无法兼容识别、AG-UI事件缺口被静默忽略、`outcome_unknown`被自动重试、私密正文进入日志。

回退只回退依赖与适配代码；已经提交的Product事实和迁移不得用破坏性命令删除。若新版本已经写出不兼容Checkpoint，先停止恢复Worker并保留记录，按人工处置而不是盲目重跑。
