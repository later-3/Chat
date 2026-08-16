# Chat Session Handoff

## 当前结论

1. DeepSeek Harness Web是唯一前端，不再维护旧`apps/web`或Agent Canvas。
2. `@chat/dsh-lifeos-bridge`是DSH与Chat公开Query/Command之间的唯一适配层。
3. DSH Session仅是UI/运行缓存；Chat Product Store仍拥有Session、Message、Run、Plan、Approval和Decision。
4. 当前实施顺序是：DSH切换完成并提交，再完成Code Workbench并单独提交。

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

运行`pnpm dev`后，固定端口上的DSH原生页面能够完成Chat消息、Plan/HITL与正式结果；随后从DSH打开Code Workbench，真实验证Files、Terminal、Git和Diff。两步分别形成独立提交。
