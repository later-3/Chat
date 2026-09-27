# Pi 摘要回归、预算准入与会话入口

状态：Chat 完整验收通过，Pi 定向回归通过；Pi 全仓类型检查有下述既有问题。工作目录 `codex/unified-session-performance`，未提交、未推送、未部署。

## 本次实现

1. Pi SDK 共用请求边界覆盖正常生成、分段压缩、分支摘要及摘要重试的准入与 Provider 钩子；群讨论/群工作成功摘要用量进入既有持久预算链。
2. 真实 transport 的取消包装错误不再被误报为压缩失败；基于所属 AbortSignal 区分取消。失败/截断/取消不保存成功摘要，重启不自动重放收费或未知副作用操作。
3. 维护 API 接通原生 compact/abort、只读全会话统计及历史继续。Session 锁、活跃 Workflow/Friend 队列、原生群绑定、expectedLeafId 与 requestId 保护归属/并发/幂等。
4. Web 按钮、`/compact [说明]`、`/session`、运行/取消/刷新、历史浏览提示与编辑回填共用这套合同。统计不启动 Agent，压缩后未知上下文不伪装为零；新增界面文案覆盖中英文。

详细行为与有意限制以 [维护合同](../../modules/sessions/chat-session-maintenance.md) 为准，能力表已将 08/10/11/13/35/49 从缺口更新；剩余 16 项完整或局部缺口仍开放。

## 验证记录

- Pi 原生选定 3 文件、26 项通过：SDK stream options、6647 摘要重试/取消、Session stats。
- Chat 公共装配：7 项压缩恢复场景；维护 7 项、群预算 4 项；均使用真实本地 HTTP 与原生 Session 文件。
- 实际 Nitro/Workflow Runtime：自动压缩截断、配额失败、退避取消、进程被杀后的同 Session 继续；维护 HTTP 的手动压缩、统计、CAS、历史继续、重启无重放。
- 实际浏览器：手动压缩、统计、编辑回填与刷新；压缩中刷新不重复请求、显式取消。测试先等待首个实际 HTTP 请求，再比较刷新后的次数，避免把正常首请求误判为重放。
- `pnpm verify` 最终 exit 0：56 项 tooling + 681 项 Backend + 224 项 Frontend + 30 项 built server + 12 项 dev/真实浏览器/Runtime，共 1003 项通过、0 失败、0 跳过。类型检查、前后端与 CLI 构建通过；架构导航 170 入口、1586 本地链接。根/Frontend/Pi `git diff --check` 通过。日志 `.data/verification/pi-test-audit/verify-final.log`；浏览器截图在同目录 `ui/`。
- 构建仍有原有 Vite 大包提示，不能把测试通过当作包体积优化完成。最后补充的历史切换失联守卫经过 Frontend 类型检查/构建及 dev 浏览器链路，并在交付前重新打入生产资源构建。

Pi `npm run check` 未全绿：Biome、依赖 pin、TS imports、shrinkwrap/install-lock 均通过；全仓类型检查有 11 处原有 AI 测试模型 ID 与目录不匹配（9 处 workers-ai Kimi、2 处 gpt-5.2-codex）。`git -C pi diff --exit-code -- packages/ai` 无差异，未用断言或修改生成目录掩盖；独立 browser-smoke 已通过。本次成功的原生测试与 Chat 构建不能替代这项未通过检查。

## 审核边界

公共 Agent 工厂仍唯一；Pi 持有 Session/摘要/统计逻辑，Chat 只保存产品归属和维护回执。手动压缩不伪造 Workflow 调用身份，不运行工具循环；资源与压缩扩展钩子仍由原生加载。历史继续不是撤销已完成文件/Memory 副作用，也不是原生 pending tool turn 的自动恢复。群/Topic 的领域合同、扩展完整生命周期与其余待适配能力未被绕过或宣称完成。
