# 开发规范（索引）

**规范的事实源不在仓库里，而在用户级 Chat Home 的交互 harness 中**（规范属于交互 harness 的一部分）：

```text
~/.chat/interaction-harness/                     通用：用户 + 所有 Long Agent 都要遵守
  README.md            对象模型与使用要求
  flywheel.md          飞轮
  concept-space.md     概念空间（新概念先解释再使用）
  cases.md             正反案例
  daily/YYYY-MM-DD.md  每日关键事件
  standards/           通用规范：需求规范、前端规范
~/.chat/long-agents/<agentId>/projects/<projectId>/交互harness.md
                                                   该 Long Agent 在该项目下的专属规范
```

本目录只保留索引，避免规范出现两份互相矛盾的副本。开始任务时按 `AGENTS.md` 的指向读取上述文件。
