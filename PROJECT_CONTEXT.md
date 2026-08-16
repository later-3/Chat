# Chat 项目上下文

## 1. 产品定义

Chat 是以对话为入口的个人操作系统。用户与一个长期协作的Agent团队持续推进生活、工作、项目和兴趣；系统负责规划、人工决定、耐久执行、知识沉淀、证据、交付与治理。

Chat不是一个聊天页面，也不是某个Agent Runtime的外壳。外部开源项目提供成熟界面或能力，Chat只维护自己的产品对象、Workflow和必要Adapter。

## 2. 当前产品链

```text
DeepSeek Harness Web
  -> LifeOS Bridge（展示与命令适配）
  -> Chat Hono API（公开Query / Command）
  -> Application + Product Store（权威产品事实）
  -> Vercel Workflow（耐久流程与暂停恢复）
  -> pi-agent-core（Planner / Executor节点）
  -> Product Commit（正式结果）
```

DSH保存的会话日志只用于原生界面与运行恢复，不替代Chat Product Session、Message、Run、Plan、Approval或Decision。浏览器和DSH Client插件都不能直接调用Workflow或pi。

## 3. 开源复用原则

1. 优先使用质量高、持续维护、许可证可接受的完整产品或模块。
2. 能作为独立服务运行的能力，不拆成自研React组件。
3. Adapter只负责身份映射、生命周期、鉴权、协议和投影，不复制上游业务实现。
4. 上游依赖必须固定版本，保留升级测试和退出路径；不在本仓库保存上游源码副本。
5. Chat核心代码只拥有产品差异：Workflow、事实模型、人工决定、记忆/规则采用和治理。

## 4. 主要产品对象

Product Session、Interaction、Message、Product Run、Run Attempt、Project、Stage、Milestone、Work、Action、Resource、Observation、Evidence、Context Package、Workflow Definition、Plan、Approval、Decision、Tool Execution、Artifact、Memory与Trace。

这些对象不等同于DSH Session、Workflow Run、Checkpoint、pi Session或Provider请求。

## 5. 已冻结边界

- DeepSeek Harness Web是唯一前端；本仓库不维护第二套Chat UI。
- Hono只终止协议、建立认证上下文和校验DTO。
- Application拥有用例、权限、事务、幂等和状态转换。
- Product Store拥有产品事实。
- Vercel Workflow拥有耐久控制流与Checkpoint。
- pi拥有Agent loop、模型和Tool运行，不拥有产品完成事实。
- 高影响动作必须先形成可读、可修订、版本绑定的Decision。
- 失败不能产生假成功；未知副作用必须查询、对账或人工处置。

当前实现与下一步分别见[PROJECT_STATE.md](./PROJECT_STATE.md)和[PROJECT_PLAN.md](./PROJECT_PLAN.md)。
