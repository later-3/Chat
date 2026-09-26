# 开发经验案例

这里归档已经发生、可复用且会影响后续工程决策的开发问题。案例不是第二套规则系统；需要长期影响 Agent 的结论会同时归档为 `experience` Prompt 资源，继续通过现有规则与经验库发现、选择和装配。

每个案例必须包含：

1. 现象与影响。
2. 已验证的直接根因。
3. 为什么现有验证没有发现。
4. 正确实现与验证姿势。
5. 至少一条自动化回归门禁。

当前案例：

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

- [模态焦点与层级归属](./modal-focus-and-layer-ownership.md)

- [发送确认前的草稿保护](./submission-draft-recovery.md)：乐观清空与持久输入分开，确认不能清掉后续草稿。
