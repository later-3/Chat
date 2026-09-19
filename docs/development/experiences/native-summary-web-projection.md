# 原生压缩摘要与公共聊天恢复

P4 浏览器验收在真实 Pi 执行链使用受控模型触发自动压缩后，下一轮显示“无效消息事件”。模型本身已正常完成压缩，问题在 Session → Web 的读投影。

Pi `buildSessionContext` 会生成 `compactionSummary` / `branchSummary` 消息。原读模型直接返回这些角色，但 Web 的既有组件期待 `customType=compaction`，新的严格 Friend 快照 Parser 拒绝了原生角色。旧前端只把这些记录强制转换为 AgentMessage，未显示摘要，因此普通页面同样存在问题。

公共 `normalizeMessageForFrontend` 负责转换为 `custom` 展示消息，保留摘要、时间、tokensBefore/fromId；Entry ID/时间数组继续一一对应，原生 JSONL 不改写。两种聊天入口和刷新/重连都经过同一读模型。不能通过只放宽 Friend Parser 或另建摘要历史库修复。

之前的 Pi 压缩测试只证明原生 Session 可继续使用，读模型测试甚至断言了原生角色，未检查实际浏览器组件。新回归检查投影角色、内容、元数据和不可变原记录；浏览器合同测试覆盖压缩、分支摘要与旧 bash 消息恢复，同时拒绝非法角色。真实浏览器再执行“自动压缩 → 下一轮 → 刷新”，核对摘要可见、无解析错误、无重复提交。

自动化：`test/session-read-model.test.mjs` 与 `frontend/lib/friend-execution.test.mjs`，并纳入 `pnpm verify`。对应经验资源为 `native-summary-web-projection`，沿用现有 Prompt 资源库选择，不全局自动注入。
