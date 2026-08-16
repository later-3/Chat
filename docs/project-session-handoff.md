# Chat Session Handoff

## 当前结论

1. DeepSeek Harness Web是唯一前端，不再维护旧`apps/web`或Agent Canvas。
2. `@chat/dsh-lifeos-bridge`是DSH与Chat公开Query/Command之间的唯一适配层。
3. DSH Session仅是UI/运行缓存；Chat Product Store仍拥有Session、Message、Run、Plan、Approval和Decision。
4. DSH切换与Code Workbench已分别完成；下一纵向是Browser Provider。

## 开始工作前

依次读取`AGENTS.md`、`PROJECT_LESSONS.md`、`PROJECT_CONTEXT.md`、`PROJECT_STATE.md`、`PROJECT_PLAN.md`、`docs/architecture/technology-contract.md`和与任务直接相关的文档。

## 不能回退的决定

- 不恢复旧自研Chat UI。
- 不把Agent Canvas/OpenHands整套前后端引入产品。
- 不复制DeepSeek Harness源码到仓库。
- 不让浏览器或DSH Client直连Workflow/pi。
- 不让code-server或未来Browser Provider拥有Chat产品事实。
- 删除内容由Git历史恢复，不在当前树建立archive/legacy目录。

## 下一完成门

运行`pnpm dev`后，`127.0.0.1:43110`上的DSH原生页面能够完成Chat消息、Plan/HITL与正式结果；从侧边栏底部的全局入口打开Code Workbench，即使停留在空白新会话也可真实使用Files、Editor、Terminal、Git和Diff。下一完成门是把实时人机共用Browser Provider以同样的服务/Adapter方式接入。
