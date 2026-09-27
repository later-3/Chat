# 中等视口的抽屉不能遮挡会话深链接

## 现象与根因

Ubuntu 浏览器从主题进入同一 Session 的直接链接后，“会话记忆”按钮存在且位于视口内，真实鼠标却命中侧栏的时间文字。800×513 视口可稳定复现；本机默认 756px 宽的浏览器未暴露问题。

布局在宽度小于 960px 时把侧栏改成覆盖式抽屉，初始化收起却只判断 768px 以下的移动端。两个断点不一致，使中等窗口默认展开抽屉并遮住交流区；原测试依赖浏览器默认窗口尺寸，所以两个平台结果不同。

## 修正与门禁

抽屉布局、焦点约束和默认收起共用同一条件；进入或切换 Session 时收起抽屉，同一 Session 的普通数据刷新保留用户手动展开状态。不能靠放大测试窗口、DOM 强制点击或提高被遮挡按钮的层级掩盖问题。

`scripts/topics-browser.test.mjs` 固定从 800×513 开始，使用真实指针验证主题到 Session 深链接、记忆开关、编辑冲突和刷新恢复，再继续既有移动端、平板、宽屏和缩放场景。命中失败记录按钮边界和实际命中元素，归入 `pnpm test:dev` / `pnpm verify`。浏览器关闭先等待进程退出，再有限重试清理临时 profile，避免目录仍被写入导致清理竞态。

以下是可显式导入的 experience Prompt，不自动注入任何 Agent：

```json
{
  "schemaVersion": 1,
  "id": "medium-sidebar-deep-links",
  "revisions": [{
    "schemaVersion": 1,
    "id": "medium-sidebar-deep-links",
    "revision": 1,
    "kind": "experience",
    "title": "抽屉断点与导航生命周期保持一致",
    "purpose": "避免中等视口的会话深链接被默认展开的侧栏遮挡。",
    "content": "覆盖式抽屉的布局、焦点约束与默认收起必须使用同一断点。进入或切换会话时露出交流区，数据刷新保留用户手动展开状态。跨平台浏览器回归显式设置视口，使用真实指针并核对实际命中元素；不能用放大窗口或 DOM 强制点击绕过遮挡。进程拥有者等待浏览器退出后再清理临时目录。",
    "tags": ["development", "frontend", "navigation", "layout"],
    "status": "active",
    "sources": [{ "type": "manual", "entryIds": [], "context": "docs/development/experiences/medium-sidebar-deep-links.md", "capturedAt": "2026-09-28T00:00:00.000+08:00" }],
    "author": { "type": "agent", "agentId": "codex" },
    "createdAt": "2026-09-28T00:00:00.000+08:00"
  }]
}
```
