# 嵌套项目身份与文件边界

## 现象与根因

2026-09-19，用户选中“思考”项目，在普通 Session 的规划执行 Workflow 中询问项目用途，回答却把外层 Chat 仓库描述为当前项目。Session cwd 与项目快照均正确；模型读取目录得到 EISDIR 后，主动读取了父级仓库 README，随后错误归因。

公共工厂此前只对 Friend 安装 `scopedFileTools`，普通 Workflow 只冻结 read 的资源正文，没有同等文件边界；普通 Workflow 的替换型 System Prompt 也没有统一装配的项目名称和用途。正确的 URL、cwd 或 AGENTS 文件选择都不能单独证明模型使用了正确的项目事实。此前 Friend 的两个项目测试没有覆盖普通 Workflow 中的嵌套目录与缺失文档。

## 修复与验证

`createChatPiAgentSession` 为普通 Workflow 和 Friend 共用项目身份说明及原生文件工具作用域。普通项目身份随既有上下文快照冻结，不另建 Session；检查与运行共用工厂。Project 身份来自可信 ProjectContext，资源来源与父级仓库不改变它。Skill 仍按已有配置选择，资源读取例外不扩展为整个父仓库授权。没有修改页面标题来掩盖错误，没有把 Bash 声称为沙箱。

自动化门禁：`test/agents/public-assembly.test.mjs` 的 nested project 场景实际让本地模型请求父级 README，检查收到越界 ToolResult、没有父级正文；另覆盖相邻项目、符号链接、六种文件工具、模型可见的名称与用途、检查入口和重试冻结。

2026-09-19 最终源码在隔离副本完成 `pnpm verify`：568 项通过（工具链 34、Backend 338、Frontend 165、构建后运行 30、Nitro dev 1），包含生产构建与 Frontend Run → Workflow → Pi → 本地模型开发链。架构导航和父仓库/Frontend diff 检查通过。没有重建或重启用户正在使用的服务。

真实验收使用 Chromium、完整构建的 Chat Web/Backend、独立 CHAT_HOME 和真实 `deepseek/deepseek-flash`；所有消息通过页面发送按钮提交，未拦截或伪造聊天响应。隔离的“思考”“学习”均没有 README/AGENTS，父目录另放 Chat README 复现混淆条件。

| 场景 | 最终结果 |
| --- | --- |
| 普通 Session 选择“思考”，规划执行，输入原问题“这是一个啥项目” | Planner 识别项目名称、用途与根目录，进入可审核状态；页面批准后 Executor 实际只读当前项目，正常完成，没有认领父级 Chat README。Session `01a0ba29-cdb9-7d6d-afc9-62cad31eb5a5` 的两阶段快照均为 thinking。 |
| Friend Nexus 在“思考”发消息，切换“学习”再发消息 | 两轮分别使用 thinking/learning 的名称、用途和 cwd；身份与 ownWorkspace 不变。请求与原生装配记录都指向同一个每日 Session `01a0ba23-0ef7-7cd0-89b3-43d648574134`，并非只检查模型文字。 |
| Friend 完成后刷新 | 仍为同一 Session，项目选择与两轮历史保留，没有再次发送消息。 |
| 页面检查 | 桌面 1440×1000 暗色及明亮主题、手机 390×844 明亮主题；页面非空、标题正确、回复可读、无整页横向溢出。最终验收期间没有浏览器 console error/pageerror。 |

首次探索中发现 Planner 在正确识别“思考”后仍重复询问用户指的是哪个项目，因此在公共说明中补充“未显式指定其他目标时，本项目就是已选项目”，以上最终验收已使用该版本。一次探索性直接执行遇到供应商流超时，Pi 自动重试后完成；这不是最终规划执行用例的失败。规划批准后的事件连接曾短暂进入状态确认提示，随后自动恢复并显示真实完成，未手动刷新来伪装收尾。

验证边界：Nano 使用隔离的缓存身份快照，页面如实显示网关未连接；空 Memory 检索使用本地 embedding fixture。因此这轮证明真实 Web/模型/项目装配，不宣称完成外部 IM 或真实 Memory 提供商验收。Friend HTTP 仍等待整轮完成后更新，实时增量明确归 P4，不属于本缺陷修复；历史中的错误回答不回写。

## Experience Prompt 资源

以下资源供显式导入，不自动注入任何 Agent。

```json
{
  "schemaVersion": 1,
  "id": "nested-project-identity",
  "revisions": [{
    "schemaVersion": 1,
    "id": "nested-project-identity",
    "revision": 1,
    "kind": "experience",
    "title": "项目身份与工具边界必须覆盖每种执行入口",
    "purpose": "排查项目选择与模型回答不一致，避免把父级仓库或Skill来源误认作用户项目。",
    "content": "先核对Session归属、接受时项目快照、实际工具参数与ToolResult，区分前端错绑和模型错误归因。公共装配应为普通Workflow及Friend提供当前项目名称、用途、根目录和相同的原生文件工具边界。README缺失或目录读取失败不能使模型隐式读取并认领父仓库；Skill资源可读不等于父仓库已授权。用嵌套项目、空项目、相邻项目、符号链接及真实浏览器两入口做验证，Friend单条链通过不能代替普通Workflow。",
    "tags": ["development", "incident", "project", "agent-assembly"],
    "status": "active",
    "sources": [{ "type": "manual", "entryIds": [], "context": "docs/development/experiences/nested-project-identity.md", "capturedAt": "2026-09-19T00:00:00.000Z" }],
    "author": { "type": "user" },
    "createdAt": "2026-09-19T00:00:00.000Z"
  }]
}
```
