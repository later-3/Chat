# 无Docker部署与可选环境边界

场景：机器未安装Docker，仍需运行Chat Web及Nano渠道；未来可选择隔离工具环境。

机制与结论：保持唯一Chat Pi装配，Nano固定chat-pi模式。`agent-execution-startup.ts`在外部driver存在时不获取Session Runtime、不探测Docker或接管容器；`setup/service.ts`跳过Docker组/Socket检查，`deploy/chatctl`无Docker安装步骤。无需增加运行时开关或修改子模块。

部署文档明确当前无Docker路线、未来可选工具环境的未实现状态、缺环境时不得退回宿主执行，并修正原生镜像与微信适配器安装的过时描述。Nano通用environment/verify仍带独立运行假设，文档如实标注检查器适配差距，以Chat/Gateway/消息实际链路验收；没有把通用verify失败当作必须安装Docker或向Nano传模型密钥的理由。

验证：在独立Nano调试worktree运行`src/agent-execution-startup.test.ts`、`setup/service.test.ts`、`src/modules/chat-integration/execution-driver.test.ts`，3个文件21条测试通过；文档本地链接、架构导航和Git diff检查通过。本次仅更新文档，不安装/卸载/停止Docker，不重启或部署生产服务，也不声称已在一台全新无Docker机器完成部署。
