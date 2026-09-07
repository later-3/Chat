# 2026-09-07：Agent 开发入口与架构治理审核

状态：用户已认可 Long Agent 机制与工程基线；本轮补齐文档、开发 Skill、验证入口和本地开发工具。未来 Long Agent 业务能力仍待执行 Agent 提交技术方案；本轮未实现这些目标、未迁移生产配置、未部署。

## 审核范围与结论

核对 Chat Backend 的公共 Pi 装配、Project 管理、Skill 目录与安装、Long Agent 执行和 Memory/Group 桥接；核对 Frontend 的配置 Parser、Session 归属、Workflow 流消费；核对 Nano 原生 Skill/调度及 chat-pi 启动边界。实现源定位见[模块合同](../chat-module-contracts.md)与[工程基线 §2.1](../chat-long-agent-engineering-baseline.md)。这是聚焦本次机制的架构审核，不是整个代码库的逐行审计。

| 发现 | 本轮处理 | 剩余交付 |
|---|---|---|
| 开发入口与动态资源生效导航不够直接 | Skill 增补分层导航、工作顺序、并发和验证入口；AGENTS/CLI 指向同一正文 | 生产 Agent 是否选择/装配仍按资源策略验证 |
| 部分前端和 README 把旧唯一主Session等说成长期约束 | 标注迁移前现状并链接已认可目标 | 前端新配置/资源/多Session页面随合同实施 |
| “模块自动感知”容易被理解成任意接口都无须适配 | 分开数据、合同、语义变化；明确失效通知→重新查询权威事实 | 通用资源通知、完整包版本固定与下一轮生效待 B2 设计 |
| NDJSON、长连接、耐久事实和通知容易混淆 | 记录真实 Web 流、Long Agent 请求、Nano Event/Delivery边界 | 不宣称已有统一SSE或完整逐事件浏览器游标 |
| 日志、审计和用户反馈缺少统一定位说明 | 增补诊断链、ID、记录用途、隐私与事故回归 | 多Agent审计actor、诊断视图与保留策略待设计；当前actor局限已公开 |
| 一键启动绕过版本入口、日志覆盖、子进程清理不足 | 复用版本注入，隔离开发数据，按次日志，就绪检查及进程组清理 | VSCode实际手工断点仍需开发者验证 |

已确认决策 D1–D6 作为设计输入落盘；字段、消息投影、调度写入/重试归属和迁移细节尚待技术方案。下一阶段按 B0→B1→B2/B3 等依赖推进，不按前后端各自长时间封闭开发。[贡献工作方法](../../development/agent-contribution.md)给出短任务记录、影响分析、交接和红线例外流程，不新建管理运行时。

## 两轮只读问答测试

均使用没有本轮前文的子 Agent，只阅读入口及最多 3–4 份相关文档，不写文件、不运行需求、不调用模型服务实施工作。测试关注概念、来源与判断，不能替代实际产品验收。

| 题目 | 必须识别的要点 | 结果与改进 |
|---|---|---|
| 新旅行 Skill，两个 Agent 下轮发现，页面自动更新 | Catalog/Resolver、inherit与explicit、在途版本、权限和实际使用证据、目标缺口 | 正确识别；发现动态生效导航绕路，已补工程基线直达入口 |
| 两 Agent/微信/Web续聊且偶发重复；诱导建议前端映射、直读Nano DB、同Session并发写、SSE兜底 | 拒绝四种错误归属/机制；区分NDJSON现状、会话/投递幂等、目标与当前、诊断和交接 | 正确识别；补机制合同§3.2和交互模拟§4.3的并发导航 |

没有将测试写成巨大的系统提示词，也未额外创建用户任务。后续修改入口时可复用题型，新增场景只补相应概念与证据。

## 验证证据

- `pnpm verify` 通过：架构导航、3项开发工具测试、223项Backend、112项Frontend、类型检查、生产构建、27项生产服务测试、1项真实Nitro开发链测试。生产和开发链均使用本地假模型执行Project Skill及6个Tool。
- 架构与Project管理两个Skill均通过 `quick_validate.py`；Pi公开 `loadSkills` 对正文和CLI相对链接只返回1份架构Skill、0个诊断。这个测试证明加载与去重，不证明所有CLI或生产Agent自动选择了它。
- 一键脚本真实启动Nitro+Vite：后端健康、前端页面、前端API代理均HTTP 200；SIGTERM后两个端口释放。使用临时Chat Home，不复制生产数据。
- VSCode配置通过JSONC解析与关联启动名称校验；`killOnServerStop`核对了本机VSCode扩展Schema。未进行VSCode GUI手工断点验收。
- NanoClaw类型检查、构建通过。初次全量测试有3个5秒超时；改为 `pnpm exec vitest run --maxWorkers=2` 后208个文件、2344项全部通过，没有增大超时或跳过测试。
- 检查既有微信接入时发现异步入站Promise未处理，补齐错误处理；微信注册及异步拒绝恢复2项测试通过，修改文件ESLint为0 error、3 warning。Nano全仓库ESLint另有11个既有error（Telegram与Chat桥接等未修改文件），本轮未扩展修复；不能报告为全仓库lint通过。
- 父仓库、Frontend、NanoClaw的`git diff --check`通过。提交包含此前同一任务的Project管理实现、模型校验兼容修复及微信接入；未来Long Agent重构仍只有已认可文档。

自动测试日志保存在本机临时目录；公开记录只保留可复现命令和结论，不提交用户配置、凭据或私有对话。

## 给下一位执行 Agent

先读[贡献工作方法](../../development/agent-contribution.md)与[实施基线](../chat-long-agent-engineering-baseline.md)，围绕 B0 提交：配置字段所有权和版本、Skill完整包发现/装配、调度触发与结果反馈、多方消息投影、并发/恢复以及迁移顺序。每个接缝都给当前复用点、受影响消费者和最小验证计划；架构师审核后再按基础场景实施。不要把这份记录当作已授权开发全部目标或已部署证明。
