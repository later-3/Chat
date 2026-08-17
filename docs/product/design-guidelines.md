# Chat 前端与交互准则

## 1. 唯一界面基线

Chat只使用固定版本DeepSeek Harness Web作为主界面。侧栏、会话列表、消息轨迹、Composer、模型/权限入口、主题和响应式行为默认由DSH原生实现；本仓库不得重新实现一套同类页面。

新增产品能力按以下顺序落位：

1. 先使用DSH公开Client Slot或插件Service。
2. 完整外部应用使用顶级Surface、Overlay或受控新窗口。
3. 能力运行在Host/Sidecar，Client只展示投影并提交意图。
4. 只有上游没有稳定接缝且价值被真实场景证明时，才维护最小补丁。

当前Workflow选择是这一原则的基准实现：使用DSH公开`conversation.input.left` Slot和公开
Menu primitive，作为Composer工具行上的紧凑控件，与原生权限/模型入口并排；不得退回
`conversation.input.dock`另造整行面板，也不得复制DSH内部Composer实现。

## 2. 产品事实与界面状态

- Chat Product Store拥有Message、Run、Plan、Approval、Decision和完成事实。
- DSH Session日志是原生聊天显示与恢复缓存，不是Chat产品真相。
- 面板开合、当前Tab、滚动位置和草稿可以是本地状态。
- 发送、审批和写操作必须使用稳定`commandId`；网络未知时保留同一命令恢复，不能制造第二次意图。
- 任何“成功”都必须来自Chat Query读取到的正式事实。

## 3. 人工决定

Plan和Approval应出现在对话输入区附近，不另造竞争页面。界面必须同时展示：当前计划版本、影响、可修订正文、批准/拒绝动作和过期/冲突状态。客户端只提交Decision Command；不能持有或调用Workflow Hook。

## 4. Hosted Workbench

Files、Editor、Terminal、Git和Diff由code-server完整提供。Workbench是全局Workspace能力，入口使用DSH公开的侧边栏底部root slot，在空白Hero和已物化会话中都必须可达，不依赖先发送一条消息。DSH使用全屏工作台Surface承载，不拆其React组件；关闭工作台后原会话、草稿和滚动位置保持。Workbench不能拥有Chat Session/Run，也不能绕过Workspace授权边界。

## 5. 可访问与响应式

1. 新入口必须有键盘路径、可访问名称和明显焦点。
2. 手机不把桌面多栏压成窄栏；完整外部工作台允许顶层打开。
3. 错误、离线、运行中、等待人工和结果未知必须有文字语义，不能只靠颜色。
4. 不覆盖DSH Token与主题系统，不为单个插件复制整套全局CSS。

## 6. 验收

每个用户可见变化至少验证：真实DSH Host、桌面与手机视口、键盘路径、刷新恢复、网络未知、过期决定、没有Runtime私有身份泄漏。截图只能辅助审查，不能替代浏览器E2E和服务端事实验证。
