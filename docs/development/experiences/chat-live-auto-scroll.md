# 新消息与工具动作未自动滚动

## 现象与根因

2026-09-18，Web 会话产生长回复和连续工具动作时，最新内容落到输入框上方可见区域之外，用户必须持续手动滚动。

旧实现仅在第一次载入消息时滚到底部，发送后通过底部占位空间把用户提问固定在顶部。后续 ResizeObserver 只更新占位高度，没有跟随流式内容或工具进度。后端健康和事件流正常不能证明内容实际可见，原先也没有覆盖长回复溢出视口的滚动回归。

## 修复与回归

滚动归 Frontend 消息容器所有，Session Hook 不再维护 DOM 滚动引用或提问锚点。`ChatWindow` 按消息末尾、流式内容和动作状态的实际变化通知 `lib/chat-auto-scroll.ts`，相同内容的轮询不触发跟随。新活动恢复到底部，延迟 Markdown/图片布局及容器尺寸变化由 ResizeObserver 补齐，滚动按帧合并并在卸载时清理。

新一轮发送会折叠前一轮工具组，浏览器因此可能在定位帧执行前调整 scrollTop。此类布局滚动不能取消已排队的新活动跟随；空闲时的主动上翻与历史分页仍保留阅读位置。

自动门禁 `frontend/lib/chat-auto-scroll.test.mjs` 覆盖 6 个场景：消息/流式/工具连续更新、延迟布局与输入区尺寸变化、发送时上一轮折叠、相同轮询与历史分页、主动上翻/返回底部、隐藏及卸载清理。

浏览器验收使用真实 ChatWindow、Session Hook 和事件解析，在 HTTP 边界替换测试会话与 Run 事件；拦截所有业务写请求，不调用真实模型或工具。验证 1440、768、390 像素下初次载入、历史分页、相同轮询、外部新消息、发送、10 段流式增量、工具开始/结果、再次跟随、延迟布局和视口缩小，断言消息末尾距视口底部小于 3px。

上述 3 种宽度验收均通过；桌面还验证了工具进度与完成后重读 Session。隔离 checkout 的 `pnpm verify` 通过：27 项 tooling、298 项 Backend、139 项 Frontend、29 项生产构建测试及 1 项真实 Nitro dev 测试，类型检查与构建通过；没有覆盖正在运行的生产产物。

## Experience Prompt 资源

以下资源供显式导入，不自动注入 Agent。

```json
{
  "schemaVersion": 1,
  "id": "chat-live-auto-scroll",
  "revisions": [{
    "schemaVersion": 1,
    "id": "chat-live-auto-scroll",
    "revision": 1,
    "kind": "experience",
    "title": "流式会话必须验证最新内容在视口内",
    "purpose": "排查消息持续产生但用户仍需手动滚动的问题。",
    "content": "检查消息容器的跟随策略，而不只检查事件流和消息数量。新消息、流式增量、工具动作及延迟布局都可能增长高度；只在首次载入滚动或固定用户提问不能保证最新内容可见。区分真实新活动与相同轮询，保留空闲历史阅读位置。发送时历史工具组折叠造成的浏览器滚动不能取消本轮跟随。通过长消息、连续工具动作、历史分页、视口变化和卸载清理做自动回归，并在真实页面断言底部距离。诊断数据在 HTTP 边界模拟，避免调用真实模型和工具。",
    "tags": ["development", "incident", "frontend", "scroll"],
    "status": "active",
    "sources": [{ "type": "manual", "entryIds": [], "context": "docs/development/experiences/chat-live-auto-scroll.md", "capturedAt": "2026-09-18T00:00:00.000Z" }],
    "author": { "type": "user" },
    "createdAt": "2026-09-18T00:00:00.000Z"
  }]
}
```
