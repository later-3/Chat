# 浏览器尺寸变化不等于响应式布局已完成

## 现象、原因与边界

2026-09-30，全局外观验证中，`session-memory-switch-browser.test.mjs` 在 768px 切到 1440px 后立即测量输入框，得到宽度 0、left 1471；同源码单独复测通过。失败只发生在几何断言，之前的真实发送、记忆开关、取消与刷新恢复已完成。

测试只等待 `innerWidth`。该值会先于 React 的 resize / matchMedia 订阅提交更新；随后 `.workspace-dock` 的 width/min-width 还有 `--duration-panel` 过渡。原等待条件无法保证测量的是静止布局，单次通过也不能证明没有这个竞态。

## 修正与回归门禁

尺寸设置后等待两次绘制帧，再等待 Dock 上有限过渡结束，下一帧读取几何值。被新过渡取消的动画允许退出；不轮询“直到断言成立”，不放宽可见边界、不禁用产品动画。该断言验证的是**最终可用布局**，不能因此声称动画每帧都不遮挡；动效连续性另做人工验收。

门禁仍由同一真实浏览器用例覆盖 390×844、768×1024、1440×900、720×450、390×420 的输入框、工具栏和设置按钮，全部要求非零尺寸且完整处于视口内，进入 `pnpm test:dev` / `pnpm verify`。首次全量失败与修复后的重跑结果分别记录在前端实施记录，不用单例通过冒充完整验证。

可显式导入的 experience Prompt，不自动注入：

```json
{
  "schemaVersion": 1,
  "id": "responsive-layout-readiness",
  "revisions": [{
    "schemaVersion": 1, "id": "responsive-layout-readiness", "revision": 1,
    "kind": "experience", "title": "尺寸更新后等待响应式布局就绪",
    "purpose": "避免浏览器几何断言与 React 响应式提交、面板过渡竞争。",
    "content": "innerWidth 更新不代表布局已完成。测量最终布局前，等待响应式提交及相关有限过渡结束；保留非零尺寸与视口边界断言，不轮询到预期结果、不扩大视口掩盖失败。最终几何验收与动效过程验收分别记录。",
    "tags": ["development", "frontend", "layout", "testing"], "status": "active",
    "sources": [{ "type": "manual", "entryIds": [], "context": "docs/development/experiences/responsive-layout-readiness.md", "capturedAt": "2026-09-30T23:55:00.000+08:00" }],
    "author": { "type": "agent", "agentId": "codex" }, "createdAt": "2026-09-30T23:55:00.000+08:00"
  }]
}
```
