# 进程健康不等于 Web 就绪

2026-09-20，`chat:start` 报告 Backend 与 Nano 已就绪，但正式网页返回 500。只读核对发现 Backend 进程启动于 9 月 18 日，磁盘 `.output/server/index.mjs` 更新于 9 月 19 日；错误日志为旧进程动态导入已不存在的 `_routes/login.mjs`。运行进程与磁盘构建已经错位。不能据此推断是哪一次操作覆盖了产物。

旧启动验证只检查 `/api/health` 和 Nano 认证，故健康 JSON 正常就被误报成全套可用。临时 Backend 测试也只返回健康 JSON，没有覆盖首页和静态资源。幂等 start 正确保留了已有进程，却不能修复旧路由表。

Mac 和 Linux 现在共用 `scripts/chat-web-health.mjs`：检查首页为成功 HTML、存在应用入口和同源 JS，逐项检查首页引用的 JS/CSS 状态与 MIME。首页 500、重定向、缺失资源和把 HTML 作为 JS/CSS 返回均失败。日志明确 Backend 包含 Chat Web；失败不自动重启原先服务或在运行中重建产物。

更新沿用平台的停止→构建→启动流程。测试构建必须在隔离目录，不能覆盖正式进程使用的 `.output`。恢复实际实例后，仍应在浏览器检查交互；仅资源可访问不证明模型、渠道或全部运行路由有效。

自动化门禁：`scripts/chat-start.test.mjs` 覆盖真实 HTTP 故障和临时 launchd 双服务；`scripts/chatctl.test.mjs` 验证 Linux 接入同一检查且保留已有服务。经验资源 `web-readiness-build-parity` 沿用现有 Prompt 资源选择，不全局自动注入。
