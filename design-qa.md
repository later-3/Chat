# P1.1 平铺工作空间 Design QA

## 对照对象

- 设计真相：`docs/design/workspace-prototype.html`
- 设计参考截图：
  - `docs/design/screenshots/workspace-v3-today-light.png`
  - `docs/design/screenshots/workspace-v3-okr-split-light.png`
  - `docs/design/screenshots/workspace-v3-okr-node-light.png`
  - `docs/design/screenshots/workspace-v3-mobile-chat.png`
  - `docs/design/screenshots/workspace-v3-mobile-work.png`
- React实现：`apps/web/src/components/WorkspaceShell.tsx`
- 本地实现地址：`http://127.0.0.1:4175/`
- 实现截图：
  - `docs/design/screenshots/app-workspace-v3-today-light.png`
  - `docs/design/screenshots/app-workspace-v3-okr-light.png`
  - `docs/design/screenshots/app-workspace-v3-node-light.png`
  - `docs/design/screenshots/app-workspace-v3-mobile-chat.png`
  - `docs/design/screenshots/app-workspace-v3-mobile-work.png`

## 视口与密度归一化

- 设计参考桌面截图：`1280 × 800`像素，对应约`1280 × 800` CSS区域。
- 实现桌面截图：`2560 × 1600`像素；内置浏览器请求`1440 × 900`后报告`1920 × 1200` CSS区域，截图密度约`1.33`。
- 设计参考手机截图：`347 × 750`像素，对应约`346 × 750` CSS区域。
- 实现手机截图：`693 × 1500`像素；内置浏览器请求`390 × 844`后报告`520 × 1125` CSS区域，截图密度约`1.33`。
- 对照前统一使用`contain`缩放并保留完整画面：桌面对照单侧归一化为`1280 × 800`，手机对照单侧归一化为`390 × 844`。不把浏览器密度差异误判为界面层级或字号错误。

## 完整页面对照证据

- 今日：`docs/design/screenshots/app-workspace-v3-qa-today.png`
- OKR会话：`docs/design/screenshots/app-workspace-v3-qa-okr.png`
- 手机对话：`docs/design/screenshots/app-workspace-v3-qa-mobile-chat.png`
- 手机工作：`docs/design/screenshots/app-workspace-v3-qa-mobile-work.png`

对照结论：React实现保留了原型的全局导航、会话列表、持续对话、工作窗口、顶部工作空间条和手机底部导航。实现没有改变区域顺序、核心比例、视觉层级或状态表达；额外加入“本地示例”字样，是为了遵守前端不伪造服务端事实的产品边界。

## 聚焦区域对照

- 节点详情：`docs/design/screenshots/app-workspace-v3-qa-node.png`
- 设计和实现都在原工作窗口内打开用户可读详情，不跳出会话，也不展示内部运行身份、原始日志或隐藏推理。
- 实现详情使用“目的、使用的信息、可见结果、接下来”4段结构；关闭后组件从DOM移除，因此不进入关闭状态的键盘与可访问结构。

## 五项设计检查

1. 字体与排版：使用设计规范指定的系统字体栈、400/600字重与13/15/17字号层级；今日标题和幻灯片标题使用独立语义Token。长中文标题能够自然换行，辅助文字没有低对比度漂移。
2. 间距与布局：桌面4区、侧栏宽度、顶部工作空间条、对话输入区和右侧工作窗口与原型一致；分栏比例限制在32%～68%，防止任一区域被拖到不可用。手机底部导航不遮挡输入区或工作内容。
3. 颜色与Token：产品骨架只使用黑白中性色；成功、进行中和失败使用语义Token，并同时有文字、边框形状和颜色。无渐变、重阴影或发光。
4. 图像与资产：目标没有照片、插画、品牌图或非标准图标；实现也没有伪造图片或装饰图标。工作流连线是运行关系的数据可视化，由Canvas绘制；节点仍是可操作、可访问的DOM按钮。
5. 文案与内容：会话、运行、PPT、代码和白板均明确属于本地示例；本地发送显示“未发送”，没有把fixture或浏览器内存写成正式成功。

## 行为、响应式与可访问性

- 已验证桌面同时显示4个区域；全局导航和会话列表可分别折叠并重新展开。
- 已验证分栏键盘调整`46% → 50%`、工作窗口最大化/还原、收起对话和收起工作。
- 已验证当前工作卡片只聚焦右侧运行，URL不变化，输入区仍在当前会话。
- 已验证OKR、PPT和代码会话分别恢复自己的工作标签；切回OKR后分栏比例仍为`50%`。
- 已验证工作窗口独立打开；独立窗口没有对话区，运行/结果标签可切换。
- 已验证手机会话抽屉、“对话 / 工作”Tab、底部主导航、本地发送和工作流图；`body`与文档宽度均等于视口宽度，没有页面级横向溢出。
- 已验证浅色/深色主题和模型偏好；浏览器主页面及独立窗口控制台均无error或warning。
- 11个组件测试覆盖默认今日、API不可达、会话工作台、本地发送、键盘发送、模型、主题、分栏、节点详情、手机切换和多会话。

## 比较与修复历史

### 第1轮

- [P1] 独立工作窗口的标签最初只展示，点击“结果”不会改变当前面板。
  - 修复：独立窗口复用每个会话的`activePanels`状态，并为标签接入同一切换逻辑。
  - 修复后证据：浏览器中`?detached=okr&panel=run`可以从“运行”切换到“结果”，控制台无错误。
- [P1] 今日提醒和会话列表最初没有直接说明它们来自本地fixture，容易被误认为真实服务端数据。
  - 修复：会话列表标题和今日提醒补充“本地示例”；工作摘要继续显示“本地示例数据”。
  - 修复后证据：`app-workspace-v3-today-light.png`与`app-workspace-v3-okr-light.png`。

### 第2轮

- 重新完成桌面、手机、节点详情和独立窗口对照，未发现新的P0、P1或P2问题。
- 允许的差异：实现截图密度更高；实现为了产品安全增加“本地示例”说明；这两项不改变目标布局或交互。

## 最终结果

final result: passed
