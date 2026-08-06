# MD-01 Design QA

> Final status: `passed`
> Review date: 2026-08-01
> Scope: MD-01 快速捕获与 Idea 去向独立原型，不代表后端已实现。

## Reference and comparison inputs

1. 已批准的 Chat Home 桌面与手机视觉基线。
2. Routine Console 官方公开画面，只用于轻量浮层、输入附近解释和候选反馈的视觉参考。
3. `qa/desktop-comparison.png`：上述桌面来源与最终捕获层放在同一比较画面中检查。
4. `qa/mobile-comparison.png`：已批准手机 Home 与最终底部 Sheet 放在同一比较画面中检查。

## Required surfaces reviewed

| Surface | Evidence | Result |
|---|---|---|
| Desktop capture | `qa/desktop-capture.png` | 通过；单一主动作、背景位置可辨、未把捕获做成完整编辑器 |
| Desktop success | `qa/desktop-success.png` | 通过；成功事实、落点、撤销和查看同时可见 |
| Desktop pending Garden | `qa/desktop-garden.png` | 通过；候选、动态来源、可用的“保留为Idea”和2个明确禁用的待实现入口可见 |
| Desktop accepted Idea | `qa/desktop-accepted.png` | 通过；标题、卡片状态和计数均从“待整理”切为正式Idea语义 |
| Desktop withdrawn pending | `qa/desktop-withdrawn.png` | 通过；撤回后明确显示`MSG-01`仍已保存、输入框是可编辑副本、重新放入不重复来源 |
| Desktop returned Idea | `qa/desktop-returned.png` | 通过；撤销接受后回到待整理，并替换掉旧的正式Idea成功提示 |
| Desktop offline/failure | `qa/desktop-offline.png` | 通过；明确“尚未保存”，文字保留，具有重试与复制出口 |
| Mobile capture | `qa/mobile-capture.png` | 通过；底部 Sheet、全宽主动作和背景上下文可辨 |
| Mobile offline/failure | `qa/mobile-offline.png` | 通过；风险提示和“复制/重试”2个恢复动作未溢出 |
| Mobile pending Garden | `qa/mobile-garden.png` | 通过；候选、来源、主动作和2个禁用壳在手机端完整重排 |
| Mobile accepted Idea | `qa/mobile-accepted.png` | 通过；正式Idea与撤销接受在手机端可见 |
| Mobile reduced-height reflow | `qa/mobile-keyboard-reflow.png` | 通过；390×450可见高度下输入仍聚焦、风险信息和底部动作可见 |

## Interaction and accessibility checks

1. 桌面顶栏、主页动作和 `⌘/Ctrl + Shift + K` 均可打开捕获层。
2. `Escape` 可关闭非保存中的捕获层；关闭后本页草稿保留。
3. 输入框有可访问名称，Dialog、Alert、Status 与按钮均可通过角色定位。
4. 捕获层与Garden抽屉均限制Tab焦点；首尾Tab/Shift+Tab不会进入被遮罩背景。
5. 保存中关闭按钮、遮罩点击和Escape均不能使反馈错位。
6. Garden支持Escape；Toast提供关闭按钮，无动作Toast 6.5秒、带动作Toast 10秒后自动消失。
7. 正常、保存中、已保存、保存失败、待整理、正式Idea、撤回候选和撤销接受不只靠颜色区分。
8. 1440px桌面、390px手机与390×450短视口均无横向溢出；短视口说明文字不低于11px，按钮不低于44px。
9. 浏览器控制台检查为0条error、0条warning。

## Issue history

| Round | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | P1 | 从正常态切到离线演示时可能残留旧成功 Toast，造成事实冲突 | 打开捕获或切换演示状态时清除旧 Toast |
| 1 | P1 | 失败态只有重试，网络长期不可用时没有保底出口 | 增加“复制原话”，并验证反馈变为“已复制” |
| 1 | P2 | 接受候选后的 Toast 仍复用保存态撤销动作 | Toast 增加动作开关；接受成功只报告事实，不显示错误的保存撤销 |
| 2 | P0 | 首批截图受浏览器0.75缩放影响，4张出现右侧空带，不能作为布局证据 | 按真实1440px与390px视口重拍全部最终图；`qa/raw`不作为交付证据 |
| 2 | P0 | 正式Idea未有独立证据，且仍显示在“待整理/0”标题中 | 增加`desktop-accepted.png`；标题改为“正式Idea”，计数为1，保留撤销接受入口 |
| 2 | P1 | 保存前显示“候选/待整理”，可能被误读为已经持久化 | 改成“保存后进入”与“尚未保存” |
| 2 | P1 | 关联/升级看似可操作但只有空壳；来源又硬编码为主页 | 两个入口禁用并标“待实现”；来源按默认、顶栏、主页、快捷键或手机入口动态记录 |
| 2 | P1 | 背景壳可能让用户把相邻模块一并拍板 | 加深遮罩，并在桌面/手机层内固定显示“MD-01·只审核捕获与去向” |
| 2 | P2 | 保存中仍可点遮罩退出；失败态同时显示“重试/保存”重复CTA | 保存中禁用遮罩；失败后只显示“复制原话/重试” |
| 2 | P2 | 缺少手机软键盘压缩后的重排证据 | 增加390×450短视口走查和`mobile-keyboard-reflow.png` |
| 3 | P2 | 自定义Dialog未明确限制键盘焦点 | 为捕获层和Garden抽屉增加焦点闭环并实测首尾Tab/Shift+Tab |
| 4 | P1 | 撤销接受后仍残留“已接受为正式Idea”Toast | 撤销处理改为原子更新抽屉状态与“已撤销接受”Toast，并补`desktop-returned.png` |
| 4 | P1 | 撤回待整理后显示“尚未保存”，却声称来源仍保留 | 增加`sourceSaved`投影与`MSG-01`稳定来源；输入层明确为可编辑副本，重新放入复用同一来源 |
| 4 | P2 | Toast永久占位、Garden不响应Escape | Toast增加关闭与自动消失；Garden加入Escape关闭并实测 |
| 4 | P2 | 短视口文字/按钮过小，且缺少手机Garden/正式Idea证据 | 说明文字提高到11px、按钮44px；补手机Garden与正式Idea截图 |
| 5 | P1 | 撤回副本关闭后，顶栏/快捷键/手机重开可能丢失`MSG-01`关联 | 以`sourceSaved && !capture`识别恢复；3个入口重开均保留`MSG-01`，快捷键同时清除旧Toast |
| 5 | P2 | 范围标签与禁用动作标签仍低于11px | 两处均提高到11px |

Round 5独立复核结论：P0、P1、P2均无未解决项，可交付用户拍板。

## Build evidence

1. `npm run build`：通过。
2. `npm run test:standalone`：1/1通过；根`index.html`内联全部CSS/JavaScript且没有外部资源引用，可作为直接文件交付。
3. `npm run test:sites`：4/4通过。
4. 同一生产构建通过本地HTTP打开后，首屏可见、根组件已挂载、无横向溢出、保存后出现“原话已保存到待整理”，浏览器0条error/warning。
5. 视觉比较、桌面/手机主路径、正式Idea、两种撤销、离线失败、短视口重排、键盘焦点、Escape和浏览器日志：通过。

浏览器自动化安全策略禁止导航`file://`，所以不把第4项的HTTP视觉检查冒充文件协议实测；直接文件保证由
自包含结构、无外部资源合同和用户最终点击共同收口。

## Known shells, not defects

1. 对象选择器与升级目标在原型中明确禁用；目标表单、幂等Command、回执对账与来源回链均待后端合同实现。
2. 页面刷新后的草稿恢复与真正离线队列未实现；原型明确写出这一限制。
3. 本轮只确认MD-01，不对Home、Garden完整信息架构或相邻模块作批准外推。
