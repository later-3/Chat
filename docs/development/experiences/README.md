# 开发经验案例

- [原生摘要准入与取消恢复](./native-summary-admission-and-recovery.md)：共用请求边界、摘要预算、信号取消与原生维护恢复。

这里归档已经发生、可复用且会影响后续工程决策的开发问题。案例不是第二套规则系统；需要长期影响 Agent 的结论会同时归档为 `experience` Prompt 资源，继续通过现有规则与经验库发现、选择和装配。

每个案例必须包含：

1. 现象与影响。
2. 已验证的直接根因。
3. 为什么现有验证没有发现。
4. 正确实现与验证姿势。
5. 至少一条自动化回归门禁。

当前案例：

- [配置、能力与 Memory 闭环](./configuration-capability-memory-contract.md)：模型可见 CAS 版本、自定义系统提示下的工具说明，以及设置页保存/检查与布局回归。

- [历史消息归属与加载就绪](./session-history-provenance-and-readiness.md)：日终维护与用户轮次分开，过程保持原顺序，异步历史响应直接触发呈现。

- [中等视口的抽屉与会话深链接](./medium-sidebar-deep-links.md)：统一覆盖断点，真实指针与显式视口共同验收。

- [Linux 调试僵尸进程组](./linux-debug-zombie-process-groups.md)：退出不等于 PID 立即回收，暂停启动器恢复和失败清理必须有界。

- [业务上下文投影撤销了 Pi 压缩](./writer-compaction-boundary.md)：本轮归属不等于原始全文回填，完整父链、原生摘要与实际 Provider 请求共同验收。

- [统一会话执行接缝](./unified-session-runtime-seams.md)：冻结装配元数据、Nitro 句柄共享、轮询碰撞与首帧闪动。

- [Workflow尾阶段：记忆节点的分流、收尾与失败记录](./workflow-tail-stage-routing.md)：按当前阶段分流、有限响应、事件流归属与可恢复的失败记录。

- [主题会话接入公共聊天的验收接缝](./topic-session-public-chat-closeout.md)：耐久执行恢复、工作答案与记忆回执分开、真实指针与窄屏验收。

- [异步返回与原生 Session 写入权](./asynchronous-session-writer.md)

- [进程健康不等于 Web 就绪](./web-readiness-build-parity.md)

- [Session 迁移保留原件与归属](./session-migration-provenance.md)

- [原生压缩摘要与公共聊天恢复](./native-summary-web-projection.md)

- [嵌套项目身份与文件边界](./nested-project-identity.md)

- [Workflow正常结束与开发中断收尾](./workflow-terminal-state.md)
- [新消息与工具动作未自动滚动](./chat-live-auto-scroll.md)
- [路径开头的消息被命令处理静默拦截](./path-prompt-command-interception.md)
- [整套启动器中的终端输入归属](./terminal-stdin-ownership.md)
- [远程 TUI 的原生渲染副作用](./remote-tui-renderer-boundary.md)

- [Workflow 开发 Step 产物外置 Agent JSON](./workflow-builder-json-import-attribute.md)
- [Workflow Step复用与Registry依赖必须保持运行时边界](./workflow-step-runtime-boundary.md)
- [本地运行时升级掩盖部署 Node.js 语法不兼容](./deployment-runtime-version-parity.md)
- [Planner 未区分任务澄清与可执行计划](./planner-readiness-contract.md)
- [Planner 续聊中的阶段与输出协议修正](./planner-conversation-output-repair.md)

- [Long Agent 切换 Provider 的认证与工具合同](./long-agent-provider-validation.md)

- [调试构建目录重入 Workflow 源码扫描](./debug-build-directory-isolation.md)
- [Nitro Step 断点映射目录遗漏](./debug-step-source-map-locations.md)
- [停机检查遗漏监听地址](./stop-service-port-verification.md)

- [朋友圈被侧栏约束与缺失翻译](./social-feed-surface-and-translations.md)

- [前端已停发的字段，后端不得仍是必填](./frontend-backend-field-contract-drift.md)：跨仓字段退役必须同时改发送与准入，并用真实入口做对偶准入回归。

- [模态焦点与层级归属](./modal-focus-and-layer-ownership.md)

- [发送确认前的草稿保护](./submission-draft-recovery.md)：乐观清空与持久输入分开，确认不能清掉后续草稿。
- [Friend 日期导航与输入区遮挡](./friend-date-navigation-and-composer.md)：日期、会话、工作列表与完整工具栏沿真实用户入口验证。

- [合并控件时保留领域策略事实](./shared-control-server-policy.md)：共享记忆入口必须保留主题节点的持久化、冲突和刷新恢复合同。

- [侧栏轮询拖垮事件循环](./periodic-event-loop-stall-session-list-polling.md)：周期任务的全量解析会阻塞事件循环，指纹缓存与一次解析共同消除切换卡顿。
- [CSS Modules 动画 keyframes 必须与引用同文件](./css-modules-keyframes-must-stay-in-module.md)：模块内 animation 引用指向全局 keyframes 会因哈希失配静默失效，关闭动画挂起。
