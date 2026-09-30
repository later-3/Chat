# Agent 设置密度、模型参数入口与完成提示检视

日期：2026-09-30。状态：实现与验证完成，未发布。

## 场景与责任

用户在 Friend 设置中选择模型，需要知道可调参数、影响范围及下一轮的有效配置；在 Workflow 中配置单个 Agent 时应复用同一套规则。用户期待整轮工作完成时通知，节点完成只是过程事实。

模型目录、保存与有效配置由 Backend/Pi 负责；Frontend 提供编辑入口与执行结果展示，不另建模型或执行控制面。本次调整 Frontend、回归测试及一条可选 experience Prompt 资源；没有新增 Agent Schema、Pi 或 NanoClaw 运行分支，不将该经验全局注入。

## 问题与处理

1. **参数入口割裂**：Agent 当前可覆写模型、思考强度；图片输入、上下文/输出上限、采样、API、兼容性等是共享模型配置。以前 Agent 页面只显示前三项规格，用户不知道去哪里编辑。现在从 Friend/Workflow 可直接定位当前模型的全局编辑器，并明确所有使用该模型的 Agent 都受影响。关闭子弹窗保留父级草稿；保存后重读目录和有效检查。能力声明来自配置/Pi，不等于已对真实供应商验证。
2. **设置层级和密度不统一**：七个大型 thinking 按钮占整行，模型与思考字段纵向堆叠；`details` 与内部内容混用 flex/gap/padding，收起时仍有过大的空白。现在模型和思考使用同高选择器，桌面并排、窄屏纵排；Friend/Workflow 使用同一个 `ConfigurationSection`，关闭行 52px、只有展开内容承担内部间距。简化工具、技能、扩展与插件标签。
3. **完成音缺少统一身份**：前台原本在整轮 Workflow 返回后播放，并非直接订阅每个 Pi `agent_end`；但前后台各有播放入口，后台只根据会话离开运行列表就播放，失败/取消/短暂缺席也可能误报。现在后台离开列表只触发事实读取，成功终态才通知；前后台以项目、Session、Run/turn ID 共同去重。当前页重连或重复观察不再重复提示，同一 Session 下一轮仍能提示。等待输入的提示保留独立语义。单次完成音本来就含两个音符，不能把两个音符当作两次 Agent 完成。

## 视觉参考与范围

既有选型为 LobeHub 和 Cherry Studio；需要落实其任务分组、表单密度与一致的控件尺度，不能只迁移组件外壳。用户补充的 [Little Plains](https://littleplains.com/?ref=siteinspire)、[Aside](https://www.a1.gallery/website/aside)、[Aside Docs](https://docs.aside.com/)、[Resurf](https://www.a1.gallery/website/resurf)、[Daybridge](https://www.a1.gallery/website/daybridge) 提供了更清晰的排版和层次参考。

本次直接检查了 Little Plains、Aside Docs 与 Resurf 的页面截图；图库和部分目标站点存在加载失败，不能声称已经完整实测全部站点。可吸收的特点是清晰的主要操作、轻分隔线、安静的背景和稳定的阅读宽度；营销首页的大标题与大留白不直接复制进高频配置表单。既有字体、色彩、圆角和主题变量继续复用，避免新增第二套视觉规范。

## 验证与边界

- `frontend/lib/execution-completion.test.mjs`：同一执行的前后台重复观察、下一轮、失败/取消、运行中与身份错误。
- `scripts/session-memory-switch-browser.test.mjs`：真实 Workflow/Pi + 本地假模型，工作 Agent 完成进入记忆 Agent 时零提示，整轮成功后一个提示；关闭 memory 的下一轮仍只提示一次，记忆尾阶段失败不播放成功音。
- `scripts/configuration-browser.test.mjs`：真实构建页保存、嵌套编辑草稿、模型目录刷新、故意延迟旧检查响应并验证后续保存结果不被覆盖、关闭行高度，以及 1440/768/390 视口和深浅主题。
- 浏览器证据保存在本机 `.data/verification/settings-sound-20260930/`，不提交正式配置、会话或截图原文。
- 完整验证在隔离源码副本执行，避免构建覆盖 43110 正式进程使用的产物；测试使用独立 CHAT_HOME、本地假模型和假 Nano 网关。

最终验证：隔离副本 `pnpm verify` 退出码 0，1061 项通过、0 失败、1 项需显式开启的真实付费模型测试跳过。其中开发工具 58、Backend 687、Frontend 274、构建后 31、开发运行链 11 项通过。类型检查、Frontend/Nitro/CLI 构建、架构导航与两个仓库的 `git diff --check` 均通过。

异步竞态回归先故意保留旧检查响应，保存新的 Agent 权限并展示新结果，再放行旧响应；最终仍保留新权限。这个用例曾在未正确推进配置版本时失败，修复后在最终完整验证中通过。截图复核包括 Friend/Workflow 桌面、手机和深浅主题，关闭行实测约 53px（含边框）。

记录与改动保留在工作区，未更新版本号、提交、推送或部署；当前改动不代表正式环境已经更新。
