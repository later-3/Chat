# 模态焦点与层级归属

2026-09-19，在 Chat Web 第二步浏览器验收中发现：配置保存失败后按钮经历禁用，焦点可能落到页面 body。仅在配置根节点监听 Escape 会失效；缩窄视口还可能新挂载底层抽屉的焦点逻辑，覆盖正在编辑的高层弹窗。

此前检查在输入仍聚焦时按 Escape，没有覆盖异步按钮禁用导致的焦点丢失，也没有在已打开弹窗时跨抽屉断点。

修复复用 `useDialogFocus`：键盘处理归当前最高可见模态层，文档级监听不依赖焦点恰好在按钮中。原生 dialog 保留浏览器处理；关闭时只由当前最高层恢复触发点焦点。未保存确认仍由具体表单拥有，不通过 DOM 输入变化猜测脏状态。已折叠面板使用 inert 与 aria-hidden 排除交互。

自动门禁 `frontend/lib/dialog-layer.test.mjs` 覆盖先打开设置、后激活低层抽屉、嵌套编辑器及逐层关闭；浏览器回归覆盖未保存取消离开、409 保留草稿、保存失败后 Escape、Medium 抽屉退出。层级单测不冒充真实键盘/浏览器验收。

## Experience Prompt 资源

供显式导入，不自动注入运行 Agent。

```json
{
  "schemaVersion": 1,
  "id": "modal-focus-and-layer-ownership",
  "revisions": [{
    "schemaVersion": 1,
    "id": "modal-focus-and-layer-ownership",
    "revision": 1,
    "kind": "experience",
    "title": "模态关闭不能依赖焦点或挂载先后",
    "purpose": "诊断异步保存及响应式抽屉引起的焦点和 Escape 失效。",
    "content": "保存按钮禁用可能使焦点离开弹窗；仅绑定根节点的键盘事件不能可靠关闭。按真实显示层级确定键盘所有者，避免响应式变化后新启用的底层抽屉抢占已打开弹窗。原生 dialog 使用浏览器机制；表单自行判断未保存和冲突，不用 DOM 猜测。验证保存失败、焦点丢失、嵌套模态、缩放和逐层返回。",
    "tags": ["development", "frontend", "accessibility"],
    "status": "active",
    "sources": [{ "type": "manual", "entryIds": [], "context": "docs/development/experiences/modal-focus-and-layer-ownership.md", "capturedAt": "2026-09-19T00:00:00.000Z" }],
    "author": { "type": "user" },
    "createdAt": "2026-09-19T00:00:00.000Z"
  }]
}
```
