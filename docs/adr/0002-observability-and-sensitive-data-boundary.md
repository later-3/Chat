# ADR 0002：可观测性与敏感数据边界

- 状态：已接受
- 日期：2026-07-23
- 范围：HTTP、Product Run、MAF Workflow、Provider、Worker、Outbox、诊断接口

## 决策

1. 每个HTTP请求生成或接受合法`X-Request-ID`，并通过结构化上下文关联Product Session、Product Run、Attempt、Runtime Job、Workflow和Worker。
2. 日志、OpenTelemetry Span和Metrics只记录白名单元数据、状态、耗时、计数与错误分类。
3. 默认禁止记录Provider完整Payload、用户消息正文、Checkpoint正文、API Key、Authorization Header、模型隐藏推理和数据库连接串。
4. `/api/live`只证明进程响应；`/api/ready`检查Product Store；运营诊断与时间线使用独立只读端点。
5. 对外错误统一为Problem Detail；内部异常进入受控日志。`outcome_unknown`保持独立语义，不标记为普通可重试错误。

## 原因

跨进程恢复故障必须能沿稳定ID定位，但审批产品又持有完整Provider请求和用户内容。把“记录得更多”当作可观测性会泄露真正受审核的内容，也会把隐藏推理误当Trace。产品需要的是状态与因果链，而不是复制敏感正文。

## 不变量与后果

1. Request ID不是Principal、权限或幂等键。
2. 进程内Metrics只适合当前单实例诊断；生产多实例聚合必须接入外部OpenTelemetry Collector或Metrics后端。
3. 诊断端点不得返回秘密配置和正文。需要检查Provider字节一致性时，只在受控测试中使用Hash和测试替身。
4. 自动测试必须注入敏感样本并验证日志、错误响应和诊断包均未包含它们。

## 验证

- `backend/tests/test_observability.py`
- `backend/tests/test_app.py`
- `.venv/bin/python -m backend.app.diagnostics_cli`

## 回退

可关闭Exporter，但不能回退请求关联、错误脱敏或敏感字段白名单。Exporter故障不得阻止Product事务提交。
