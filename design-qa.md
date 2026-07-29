# Design QA — Workflow Run 设计者执行链升级

## 验证对象

- 用户参考截图：`/var/folders/19/jm_fm6vd35x97z1p1rv_3g240000gn/T/codex-clipboard-e1eb6c2a-e550-43e1-ac47-66dadac23753.png`
- 最终实现截图：`/Users/xulater/Code/Chat/workflow-workbench-implementation-final.png`
- 同屏比较：`/Users/xulater/Code/Chat/workflow-workbench-before-after.png`
- 页面：`http://127.0.0.1:5073/`
- 参考截图是旧版“已放弃”投影，最终截图是真实模型成功Run；本次比较目标是信息结构、密度、字号和可读性，不把两个不同运行状态做像素级克隆。

## 视觉与概念检查

| 检查项 | 最终结果 | 证据 |
|---|---|---|
| 工作台标题 | 通过 | 改为“设计者工作台 / 代码执行链”，不再只显示含糊的Workflow Run标题 |
| Workflow与代码阶段边界 | 通过 | 明确显示4层、12阶段、1个MAF Executor；只有`ModelCallApprovalExecutor`标为真实MAF图节点 |
| 执行链完整性 | 通过 | 从AG-UI入站、Product Run准备、MAF执行、审批、Provider传输、解码、AG-UI投影、Product提交到终态共12阶段 |
| 正文字号 | 通过 | 阶段标题16px、阶段说明14px、源码13px、状态/元数据12px；节点展开内容正文14px；旧界面的阶段小字约7–10px |
| 层级字号 | 通过 | 工作台标题19px（窄屏17px）、Workflow标题17px、组标题14px |
| 长ID和源码 | 通过 | 使用等宽字体、自动换行或受控省略，没有撑破容器 |
| 784px视口 | 通过 | 工作台680px覆盖显示，页面横向溢出为0 |
| 窄屏 | 通过 | 工作台满宽，横向溢出为0；内部滚动容器`scrollHeight=4728`、`clientHeight=1001`，可以滚到第12阶段 |
| 宽屏 | 通过 | Chat Pane与680px工作台平行显示，文档横向溢出为0 |

## 真实交互检查

| 场景 | 结果 | 观察证据 |
|---|---|---|
| 发送前暂停 | 通过 | 输入“只回复 WORKFLOW_STAGE_OK”后出现完整模型请求审批界面，Provider调用尚未发生 |
| 批准并发送 | 通过 | 真实Provider返回HTTP 200，传输为SSE，页面得到`WORKFLOW_STAGE_OK` |
| 实时阶段Trace | 通过 | Product Trace记录26条`workflow.stage`事件，最终12个阶段全部为“已完成” |
| Product提交 | 通过 | Assistant Message、Run、Attempt、Interaction和Session Revision完成提交 |
| 刷新/历史投影 | 通过 | 持久Trace优先恢复；没有阶段Trace的旧Run使用确定性终态投影 |
| 放弃 | 通过 | 等待审批阶段为“已放弃”，Provider及后续阶段为“已跳过”，保持零发送语义 |
| 控制台 | 通过 | 浏览器error日志为0 |

## 修正记录

1. 把原先横向压缩的4个公开阶段替换成纵向12阶段执行链，避免名称截断和把代码阶段伪装成Workflow节点。
2. 将阶段标题、说明、源码、状态和元数据分别提高到15/14/13/12px；在正常浏览距离下可以直接阅读。
3. 首轮窄屏复查发现Flex子项会压缩执行链并裁掉后半段；已给3类工作台卡片增加`flex: 0 0 auto`，复查可独立滚动到第12阶段。

final result: passed

---

# Home Design QA

状态：**通过（2026-07-28）**

## 对照材料

- 视觉基线：[prototypes/chat-uiux-v1/qa-home.png](./prototypes/chat-uiux-v1/qa-home.png)，1707 × 960。
- 生产桌面截图：[design-qa-home-desktop.png](./design-qa-home-desktop.png)，1707 × 960。
- 生产手机截图：[design-qa-home-mobile.png](./design-qa-home-mobile.png)，390 CSS px 响应式视口。

## 结论

1. 生产实现保留了已批准基线的固定 Activity Rail、问候 Hero、今日轨道、双列继续卡、年度日历、下半区集合卡和低饱和 Material 3 Expressive 视觉层级。
2. 参考图中的示例 Project、假进度百分比和随机日历信号已替换为 Product DB、Harness、Governance 与 Evidence 的真实只读投影；因此内容密度和日历颜色分布允许不同。
3. 桌面 1707 × 960 同尺寸对照未发现裁切、错位、异常边距、边框或圆角问题。390 CSS px 手机视口无横向溢出，底部 5 项主导航可见。
4. 已在应用内浏览器验证：主页默认打开；Project/Work/Note 搜索返回真实资源；“继续”将事项标题带入 Chat 输入框但不自动发送；日历日期可切换；浏览器控制台无 error/warning。
5. 完整 Conversation Day、Artifact 在线预览和 Idea→Work 治理仍是明确标注的功能桩，没有用示例内容冒充实现。

## 有意差异

- 顶栏沿用生产环境现有连接状态、新对话、资源和配置入口，没有复制原型中的个人头像与示例 Workflow 状态。
- 继续卡不显示未经权威模型支持的百分比，只展示真实状态、归属 Project 和更新时间。
- 当前 Artifact 和 Idea 数据为空时展示真实空态；不会为视觉丰满度生成假产物或假灵感。
