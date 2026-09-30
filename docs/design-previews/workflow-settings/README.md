# Workflow 配置交互样板

2026-09-30。用户已授权按信息设计方案快速制作并单独启动页面，先审核效果。本目录是设计产物，不是已接入生产的配置页。

## 启动

在 Chat 仓库根运行：

```bash
node docs/design-previews/workflow-settings/preview.mjs
```

打开 <http://127.0.0.1:43118/>。只监听本机，端口占用时报错，不终止或替换其他服务。复用已安装的 Frontend React、Radix Popover、cmdk、Tabler Icons 和主题 tokens；没有安装新依赖。使用独立 Vite 配置，无 Backend 代理，不覆盖生产构建。

独立构建检查：

```bash
node docs/design-previews/workflow-settings/preview.mjs --build
```

输出到 Git 忽略的 `.data/design-previews/workflow-settings/build/`。

## 可审核的交互

- 3 种范围：当前会话、助手默认、项目默认；预览草稿按范围/Workflow/Agent 分开。
- 2 种工作流：直接执行的 2 个节点，规划执行的 4 个节点。
- 3 类内容：模型与生成、指令与输出、工具与资源。
- 模型搜索、能力/Thinking 变化、参数继承、输出预算校验。
- 指令编辑、工具开关、资源添加/移除。
- 共享模型定义使用同一工作区返回导航，保留原节点草稿。
- 应用、撤销、模拟保存失败及有效配置预览。
- 人工审核节点只展示审核职责，不出现模型表单。
- 明暗主题；窄屏节点横向导航与纵向表单。

模型名称只是示例，能力、参数支持与限额均为演示数据，不能用于判断真实 Provider 支持情况。应用仅更新页面内的模拟状态；刷新清除修改，不调用正式配置 API，不启动 Workflow，不运行模型。生成参数、会话模型覆盖等目标合同尚未接入，不能由该样板声称生产已支持。

方案来源：`docs/history/reviews/2026-09-30-agent-configuration-information-design.md`。样板批准后，应将内容和交互收敛到正式共用组件，复用后端 Resolver、持久化、冲突保护与 i18n；不要把样板的内存数据复制成产品配置事实源。

## 本轮验证

实际浏览器验证：参数应用成功；模型搜索切换后，图片/Thinking/采样支持随样例变化；模拟失败保留草稿；范围切换互不覆盖；人工审核无模型表单；补充指令、工具开关、共享模型详情与返回。窄视口观察没有页面横向溢出（浏览器报告 clientWidth 与 scrollWidth 均为 400）。

原始截图放在 `.data/verification/workflow-settings-preview/`。使用键盘操作验证表单和模型搜索；未宣称完整无障碍或正式 API 集成验收。原有生产 Frontend、Backend、Pi、NanoClaw 代码未修改。


## 材质与动效样板（同日后续）

用户认可基础布局与信息层级，授权继续增加艺术感与交互质感，并将玻璃作为可选外观。本轮保留原工作流、节点、表单、保存范围和布局，用独立的 `AppearancePicker.jsx` 与 `appearance.css` 增强展示。

- **基础款「经典纸感」**：暖灰与墨色延续；补充柔和接触阴影、选中边界、按压状态、字段聚焦和操作反馈。节点/分类内容使用 200ms 的轻微淡入，浮层使用同一时长体系；无循环装饰动画。
- **可选「柔光玻璃」**：静态环境光底色，容器/顶栏/浮层使用磨砂与半透明；输入区保留较实的底色。桌面容器 blur 为 24px，窄屏 14px，减少嵌套滤镜。
- **主题独立**：两种材质均支持浅色/深色；切换外观不重建表单或清空草稿。
- **偏好可控**：右上角「外观」可切换材质、关闭动效、降低透明度。浏览器只保存该样板的外观偏好，键为 `chat:workflow-design-preview:appearance:v1`；与正式产品设置、Agent 配置隔离。`?skin=classic` / `?skin=glass` 可直接选择材质。
- **渐进增强**：尊重系统减少动态效果/减少透明度；不支持 backdrop-filter 时使用实色表面。系统偏好优先于页面开关。无障碍完整验收仍待正式接入时完成。

实际浏览器验证：两种材质切换后填写的 `8192` 预算仍保留；关闭动效时内容 animationName 为 none；降低透明度时容器 backdropFilter 为 none；刷新恢复三个外观偏好；浅色与深色玻璃截图检查；窄屏实际 clientWidth/scrollWidth 同为 410，无页面横向溢出，外观面板可见且在视口内。独立构建通过，截图在 `.data/verification/workflow-settings-skins/`。

用户明确要求的可选材质探索属于此样板的局部设计，不将玻璃、环境光底色或面板阴影直接改为全产品强制规范。后续正式接入时，基础交互质量、材质皮肤和可访问性偏好应保持分层。

## 七套完整主题样板（2026-09-30 后续）

用户确认 Dracula 是所指的编辑器主题，并要求把 Instagram 单独加入，共 7 套。当前样板提供 4 套浅色、3 套深色；它们是自有 Web 主题的风格参考，不是厂商原生组件或官方主题移植。

| 预设 / URL `skin` | 模式 | 展示合同 |
|---|---|---|
| 纸白 / `paper` | 浅色 | 暖白、墨字、精细边界，延续已认可基础款 |
| 冰川 / `glacier` | 浅色 | 抽象蓝紫背景；导航磨砂、胶囊动作、浅色稳定内容面 |
| 桃雾 / `peach` | 浅色 | Material 方向的彩调分组、填充输入框、圆润选中标签 |
| Instagram / `instagram` | 浅色 | 黑白内容与主按钮，粉色选择态，图标边缘与活动标签少量渐变 |
| 石墨 / `graphite` | 深色 | 炭灰层次、柔白文字、淡紫强调 |
| 黑曜 / `obsidian` | 深色 | 深蓝烟色玻璃、清晰文字、半透明导航与浮层 |
| Dracula / `dracula` | 深色 | 紫灰底、紫色动作、青色与粉色局部强调，技术参数等宽 |

底层分为 `themes.mjs`（主题注册与偏好解析）、`themes.css`（语义颜色、表面、圆角、阴影及背景）、`appearance.css`（公共组件样式、材质差异与动效）。`AppearancePicker.jsx` 提供带按钮/输入框/菜单缩略图的主题目录。页面草稿、业务模型与交互仍共用，不复制 7 个页面。主题色值集中在主题定义中；样板中的局部材质配方不宣称已经迁入正式 Frontend 原语。

右上角「组件体验」打开 `ComponentLab.jsx`：Radix Dialog 内可以切主题、编辑输入、切换开关、打开嵌套 Popover，并模拟保存等待、成功和失败。关闭清理计时器；Escape 返回触发点。演示只改变预览状态，不请求正式 API。复用已安装的 Radix Dialog，未新增依赖或生产入口。

外观偏好使用版本化键 `chat:workflow-design-preview:appearance:v2`，兼容旧 v1 的经典/玻璃和明暗选择；`skin=classic` / `skin=glass` 仍可进入相应预设。偏好包含主题、氛围背景、动效和降低透明度。Instagram 是第 7 套独立浅色预设，不暗中派生第 8 套。背景为本地 CSS 抽象图形，没有下载背景图片或引入外部字体。玻璃主要用于操作与导航层，长文本内容保留稳定表面；减少透明度与不支持 backdrop-filter 时退回实色。

验证：7 套通过主题目录依次切换，未应用的 8192 输出预算均保留；各自按钮圆角与输入表面实际不同；组件对话框切主题保留输入；保存中按钮禁用、成功/失败反馈、失败保留输入、Escape 焦点归还均经浏览器验证。3 项外观开关关闭后，侧栏 blur/内容 animation 为 none，刷新恢复偏好。窄屏重载后浏览器实际 layout/visual viewport 宽均为 400，scrollWidth=400；主题面板左右约 14/386，内部滚动；组件 Dialog 无内部横向溢出。恢复默认视口后继续提供预览。独立 Vite 构建及父仓库/Frontend diff 检查通过。

截图：`.data/verification/workflow-settings-seven-themes/`。这是浏览器样板验证，未宣称完整 WCAG、真实 iOS/PWA 设备或正式产品集成验收。后续正式接入应先修订 Frontend 的固定配色/圆角约束为默认主题及可覆盖范围，并复用正式 `useTheme`、Button、SurfaceDialog 等入口。
