# 交互 harness 索引

**协作资产与规范的事实源不在本仓库，而在用户级 Chat Home 的交互 harness 中**；
本目录只保留索引，避免出现两份互相矛盾的副本。

```text
~/.chat/interaction-harness/                     通用层：用户 + 所有 Long Agent 共同使用
  AGENTS.md            本层指引：角色与责任、阅读顺序、部件与关系、两层结构、七个板块协议、版本控制
  concept-space.md     概念空间元规则（概念空间是什么、什么时候建档、怎样使用）
  concept-space/       概念索引 + 各作用域的概念正文（一个概念一份正文）
  flywheel.md          飞轮（条目类型：方法 / 原则 / 工具 / 教训）
  cases.md             案例（类型：正例 / 反例）
  standards/           规范（需求 / 前端 / 开发 / task / 测试 / 维护）
  todo/                通用层遗留事项

~/.chat/long-agents/<agentId>/projects/<projectId>/
  AGENTS.md            项目层指引（组织方式与填写要求）
  project-guidance.md  该 Long Agent 在该项目下的专属规范
  daily/               每日记录（随手记；实例绑定 Agent × Project）
  todo/                项目层遗留事项
  tasks/               任务（A 类含 phases/ 阶段与阶段任务）
```

## 七个板块

规范 · 概念空间 · 飞轮 · 案例 · 每日记录 · Todo · 任务。
各自的作用、价值、边界、维护方式与**类型取值**见 Chat Home `AGENTS.md` §10「七个板块的协议」——
类型集合是协议的一部分，新增类型前必须先声明并检查跨板块协调。

## 版本控制

Chat Home 已纳入**本地 git**（白名单式 `.gitignore`：纳入 harness 与任务文档，排除凭据、会话、数据库与运行态）。
修改协作资产后提交，恢复用 `git log` / `git checkout <commit> -- <path>`。

开始任务时按仓库 `AGENTS.md` 的指向读取上述文件；规范变化必须与仓库文档、测试同批更新。
