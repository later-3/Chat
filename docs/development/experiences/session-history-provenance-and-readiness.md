# 历史消息归属与加载就绪

## 场景与影响

2026-09-30 核对真实 Friend 日常会话，发现日终总结继承数小时前的 `session-memory-writer` 标识，与上一用户轮次合并；页面显示 `Thinking 30560s`，累计用量与记录用时也混入维护工作。最终回答前的短 Thinking 被排到记忆回执之后。完整历史接口约 48ms 返回约 751KB HTML，但页面一直显示加载中。

## 根因与职责

1. Backend 公共历史读模型忽略隐藏的日终触发消息，却持续沿用前一个 Workflow 阶段。运行记录本身没有错，错误在来源投影；独立 HTML 导出也复现了同一阶段泄漏。
2. Frontend 只以用户消息划分轮次，缺少后台维护边界；将消息时间差标成 Thinking/工具用时，把空闲和模型生成时间当作局部计时。
3. 最终答案的过程块被拆出后追加到所有记忆尾消息之后，破坏原消息顺序。
4. 完整历史成功响应只更新 ref，文档合成 effect 没有可观察的成功状态依赖；网络已完成，超时已清除，界面却未进入就绪态。修复状态后，内嵌浏览器仍无法导航到 sandbox Blob，换用 srcDoc 后正文和树实际呈现。

截图中的短 Thinking 原文确为 `Now respond.`，不是缺失内容；不能为消除疑惑而篡改或删除模型原文。`session-memory-writer` 是真实 Workflow 记忆 Agent，但日终 `{did,reflections,handoff}` 来自另一维护请求，不能沿用其标签。

另外，展开长历史会触发 ResizeObserver 自动滚底，让用户直接看到末尾块。共享滚动控制器现在在用户点击或键盘展开折叠控件时暂停跟随，直到下一次真实消息活动。

## 修正机制与边界

- 聊天读模型与 HTML 导出共用 `src/session-history-activity.ts` 从原生维护 CustomMessage 投影来源及 triggerEntryId，原始 Session 不迁移、不改写；新轮次/阶段/压缩清除临时归属。未识别的阶段版本同样形成边界，避免继承旧 Agent。
- 维护结果在公共聊天组件中独立显示；普通对话中的 JSON 不自动分类。有效结构按业务段落展示，异常/扩展格式完整回退原文。
- 用户轮次统计排除后台维护，过程顺序遵循原记录。没有可靠起止事件的历史 Thinking/工具不展示推测时间。
- 历史文档用 React state 表达成功就绪，缓存按 Project/Session 绑定；保留超时、重试与取消；使用稳定的 srcDoc，避免内嵌浏览器的 sandbox Blob 导航空白。延迟 Thinking 请求也有界。

这些是 Backend 来源合同与 Frontend 呈现修复，沿用 Pi 历史事实源；不增加 NanoClaw 状态或另一套运行记录。

## 为什么此前门禁未阻止

原有单测分别覆盖记忆回执、轮次统计及 HTML 样式，缺少“回复→记忆整理→数小时后日终维护”的组合。测试切到 Prompt 标签前未确认首次历史已呈现；已有群聊浏览器用例具备首帧断言，但此前未阻止缺陷进入当前运行版本，不能以用例存在代替交付证据。

## 自动化门禁

- `test/session-read-model.test.mjs`：真实 Pi SessionManager 记录序列，维护/普通续聊、未知阶段隔离、原文及 entry ID/时间对齐。
- `frontend/lib/session-activity.test.mjs`：HTTP 来源结构、普通 JSON、过程顺序、统计隔离、结构化及原文回退。
- `scripts/prompt-capture-browser.test.mjs`：首次点击完整历史后直接呈现历史正文与分支树，不依赖切标签或主题，同时验证维护区不属于记忆 Agent；既有群聊完整历史用例继续覆盖共享组件。
- `frontend/lib/chat-auto-scroll.test.mjs`：展开历史保留阅读位置、相同轮询不抢滚动、真实新活动恢复跟随。
- `frontend/lib/history-document.test.mjs`：Pi 原始数据、分支脚本与样式投影隔离。

本案例的 `experience` 资源为 `session-history-provenance-and-readiness`，通过既有 Prompt 资源机制发布并显式选择，不自动注入所有 Agent。

## 本次验证记录

- 对目标 Session 仅作受权读取；修复版本通过拒绝写操作的本机预览检查，不修改 Session 原件。用户轮次的统计从 137,498 词元 / 30,630.4 秒还原为 119,958 词元 / 40.8 秒，差额属于日终维护；记录用时仍包含等待与记忆尾阶段。
- 真实浏览器检查了首次完整历史、实际正文与分支树、503 后重试、过程原顺序、日终分段及原文入口、中文/英文与明暗显示。键盘展开日终总结前后标题均位于约 557px，未再跳到尾部。窄屏观察到的实际 CSS 视口为 520px，不据此声称已验证真实手机。
- `pnpm verify` 在隔离源码副本运行，正式 43110 的构建未覆盖。Backend 683 项、工具链 58 项、生产 HTTP 30 项通过；最终 Frontend 267 项、类型检查与构建通过。开发链首次出现 1 项历史检查失败和 1 项主题浏览器超时；历史检查补充 Chrome 独立 iframe target 读取后，两项独立复测均通过（约 11 秒与 56 秒），不能把首轮 verify 的非零退出写成一次性全绿。
- 真实付费模型用例仅在验证副本中显式跳过 1 项；未使用正式凭据调用模型，未发送外部消息。其余开发链使用本地假模型，含真实 Workflow/Pi Runtime 与 Nano 联调场景。
- 原始接口响应、日志及前后截图在 Git 忽略目录 `.data/verification/session-display-2026-09-30/`；不把私人会话正文或截图提交到仓库。上述验证阶段未部署，后续版本提交不代表运行版本已更新。
