# Chat Session Handoff

## 当前结论

1. DeepSeek Harness Web是唯一前端，不再维护旧`apps/web`或Agent Canvas。
2. `@chat/dsh-lifeos-bridge`是DSH与Chat公开Query/Command之间的唯一适配层。
3. DSH Session仅是UI/运行缓存；Chat Product Store仍拥有Session、Message、Run、Plan、Approval和Decision。
4. DSH切换已经完成；Code Workbench首期实现保留为Beta且不进入通用CI/CD；下一纵向是Browser Provider。

## 开始工作前

以`AGENTS.md`的“上下文恢复顺序”和“Agent开工与交付闭环”为唯一入口，本文件不复制另一套读取顺序。阶段目标和历史任务书都不是开工授权；只能依据当前对话中用户的明确请求开始实现。

## 不能回退的决定

- 不恢复旧自研Chat UI。
- 不把Agent Canvas/OpenHands整套前后端引入产品。
- 不复制DeepSeek Harness源码到仓库。
- 不让浏览器或DSH Client直连Workflow/pi。
- 不让code-server或未来Browser Provider拥有Chat产品事实。
- 删除内容由Git历史恢复，不在当前树建立archive/legacy目录。

## 下一完成门

运行`pnpm dev -- --workbench=off`后，`127.0.0.1:43110`上的DSH原生页面能够完成Chat消息、Plan/HITL与正式结果。Code Workbench当前是Beta，不阻塞这个基线；单独启用、修改或准备提升为稳定能力时再执行其Files、Editor、Terminal、Git、Diff和进程回收真实门。下一完成门是把实时人机共用Browser Provider以同样的服务/Adapter方式接入。
