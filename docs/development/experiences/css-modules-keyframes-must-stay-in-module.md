# CSS Modules 动画 keyframes 必须与引用同文件

2026-09-29，在排查"确认框关闭后页面挂死、动画像没画过"时定位：`ui.module.css` 的 `.overlay`/`.confirmation` 引用 `@keyframes scrim-in/scrim-out/layer-in/layer-out`，而这些 keyframes 定义在全局普通 CSS（`src/styles/precision.css`）里。CSS Modules 处理器会把模块内 `animation:` 引用改写为哈希名（`_layer-out_1cn73_1`），但全局文件中的 `@keyframes` 保持原名；引用指向一个不存在的哈希定义，浏览器不会创建 Animation 对象，`animationend` 永不触发，Radix Presence 等待退出动画完成后再卸载节点，于是关闭确认框永久挂起。`ModelsConfig.module.css` 的 `.pickerScrim` 同理。

诊断特征：computed style 仍显示 `animation: _layer-out_xxx 0.2s running`（声明有效），但 `element.getAnimations()` 返回空数组。这一步可直接区分"动画没写"与"动画没生效"。另注意全局 `layer-in` 的 `to { transform: none }` 配合 `both` 填充会覆盖确认框的 `translate(-50%,-50%)` 居中，模块内局部副本必须保留居中 transform。

修复：模块类引用的每个 keyframes 都定义在同一 module 文件内（`DeviceWorkspaceRoot` 的 `device-workspace-spin` 是既有正确先例）；全局动画体系仍可用，但模块文件不得引用全局 keyframes 名。

自动门禁：`scripts/session-memory-switch-browser.test.mjs` 的共享确认框关闭/Escape/二次确认步骤在 keyframes 断裂时会以关闭挂起超时失败，覆盖该回归；浏览器最小复现可用 `getAnimations()` 计数验证。

## Experience Prompt 资源

供显式导入，不自动注入运行 Agent。

```json
{
  "schemaVersion": 1,
  "id": "css-modules-keyframes-must-stay-in-module",
  "revisions": [{
    "schemaVersion": 1,
    "id": "css-modules-keyframes-must-stay-in-module",
    "revision": 1,
    "kind": "experience",
    "title": "CSS Modules 的 animation 引用不能指向全局 keyframes",
    "purpose": "诊断 CSS 动画声明存在但节点不卸载、关闭挂起的 Radix Presence 问题。",
    "content": "CSS Modules 会把模块内 animation 引用哈希化，全局文件中的 @keyframes 不参与哈希，引用与定义失配后浏览器不创建 Animation，animationend 永不触发，Presence 卸载挂起。诊断用 getAnimations() 计数：computed style 有动画而计数为 0 即此病。修复是 keyframes 与引用同文件；模块内副本需保留居中等关键 transform，避免全局 to{transform:none} 覆盖。",
    "tags": ["development", "frontend", "css", "animation"],
    "status": "active",
    "sources": [{ "type": "manual", "entryIds": [], "context": "docs/development/experiences/css-modules-keyframes-must-stay-in-module.md", "capturedAt": "2026-09-29T00:00:00.000Z" }],
    "author": { "type": "user" },
    "createdAt": "2026-09-29T00:00:00.000Z"
  }]
}
```
