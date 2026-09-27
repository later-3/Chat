# Friend 日期导航与输入区遮挡

## 原因与收敛

2026-09-27，日期选择只改变日历下的会话预览，后台工作面板仍显示全量工作。同一个周期任务的多次执行使用相同标题，列表没有开始时间，容易误认为重复工作或切日期失效。协作项目栏与高度为 100% 的聊天组件叠加，再加上单独的会话记忆行，使底部工具栏越出容器。

交互事实源为 [Chat Web 日期工作区](../../modules/web/chat-web.md#friend-的日期工作区2026-09-27)。日历直接进入所选日期，侧栏列出当天会话和工作；URL 保留 friendDate，条目切换、刷新和返回使用同一日期。点击 Friend 进入今天。工作按 Agent 时区的创建日和原生消息活动日展示，按 workId 保留身份并显示开始时间；同标题不能合并，跨日实际有活动的工作可以在两天出现。没有当前执行引用也能打开原生历史。

记忆入口放入既有输入工具栏，开关与条目放在同一 Dialog。聊天区用可收缩的 flex 空间，底部输入及工具栏不压缩；必须验证整个控件的视口边界。

## 门禁

`scripts/session-memory-switch-browser.test.mjs` 用隔离 Chat Home、本地假模型和真实浏览器验证同名工作按日期隔离、历史工作打开、同日切会话、刷新/返回、空日期幂等创建、联系人回到今天及记忆开关真实发送。布局覆盖 390×844、768×1024、1440×900、720×450、390×420。900×900 另验证直接打开设置时导航可被真实指针命中；聊天侧栏不可见时，其遮罩也不得保留在全局任务面。`CHAT_UI_EVIDENCE_DIR` 可保存合成场景截图；小高度验证不冒充真机软键盘验收。

## Experience Prompt 资源

供显式导入，不自动注入 Agent。

```json
{
  "schemaVersion": 1,
  "id": "friend-date-navigation-and-composer",
  "revisions": [{
    "schemaVersion": 1,
    "id": "friend-date-navigation-and-composer",
    "revision": 1,
    "kind": "experience",
    "title": "日期筛选与输入区必须沿真实导航验证",
    "purpose": "防止日期预览、工作列表、会话导航和输入区布局脱节。",
    "content": "日期交互需同时核对入口、侧栏、当前Session及URL恢复。周期任务按workId和时间区分，不按标题去重；按Agent时区和实际活动归日。历史读取不依赖活跃执行。辅助控件进入既有工具栏，聊天区分配剩余高度，不将100%高度与兄弟栏相加。用真实浏览器验证切日期、同日条目、刷新/返回和完整工具栏边界，不能只断言DOM存在。聊天侧栏隐藏后其遮罩也必须离开全局任务面；在中等宽度直接进入设置，以命中测试和真实指针点击验证入口未被遮挡。",
    "tags": ["development", "frontend", "navigation", "layout"],
    "status": "active",
    "sources": [{ "type": "manual", "entryIds": [], "context": "docs/development/experiences/friend-date-navigation-and-composer.md", "capturedAt": "2026-09-27T06:00:00.000Z" }],
    "author": { "type": "agent", "agentId": "codex" },
    "createdAt": "2026-09-27T06:00:00.000Z"
  }]
}
```
