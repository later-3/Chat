# ADR 0001：应用组合根与进程入口分离

- 状态：已接受
- 日期：2026-07-23
- 范围：FastAPI、Product API、AG-UI、Execution Worker、Outbox Worker

## 决策

1. `backend.app.main:create_app`只负责接收显式`Settings`或在被调用时加载配置，并装配应用组件。
2. `backend.app.composition`拥有依赖构建；`backend.app.lifecycle`拥有启动、迁移、后台任务和关闭顺序。
3. `backend.app.api`拥有HTTP DTO、Router、请求上下文和错误映射；Router只调用应用服务，不直接写数据库。
4. `backend.app.asgi:app`是Uvicorn进程入口。导入`backend.app.main`不得读取私有`backend/config.json`、连接数据库或创建后台任务。
5. Worker继续使用各自CLI入口；共享服务由组合根构造，不把FastAPI对象传入领域或运行时服务。

## 原因

原`create_app`同时承担配置、依赖装配、生命周期、约30个路由和错误处理，导致测试导入会触发运行配置，而且任一产品能力都扩大组合根。分离后，测试可用`Settings.for_test()`构建同一合同，ASGI部署仍有唯一显式入口。

## 不变量与后果

1. OpenAPI、Product Store Schema、Workflow Definition与节点ID不得因本次拆分变化；由架构指纹测试锁定。
2. Product DB仍是产品事实源，MAF/AG-UI仍只拥有运行时和协议语义。
3. 新Router必须通过依赖对象调用应用服务。跨聚合事务由应用协调器拥有，不能回退到路由内拼事务。
4. 新进程角色需要独立健康、关闭和Lease语义，不通过导入Web进程的全局`app`复用状态。

## 验证

- `backend/tests/test_architecture_contract.py`
- `backend/tests/test_app.py`
- `./scripts/verify-fast.sh`

## 回退

若组合根拆分引发未计划合同变化，保留新的模块文件，但把对应装配调用回退到上一个已验证指纹；不回滚数据库，也不改变已提交产品状态。
