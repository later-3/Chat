# Chat 调试与开发说明书

这套手册面向学习源码、日常开发和问题定位。先跑通一条小链路，再逐层加断点；每个场景都提供入口、流程、观察点和验收条件。手册始建于 2026-09-08；2026-09-15 核对并补充了跨模块源码地图、关键数据结构、Daily 轮换和定时转发入口，后续修改相关机制时同步维护对应章节与验证记录。

**现在就要下断点：先看[源码、函数与数据结构地图](./code-map.md)。** 它按普通 Chat、公共 Pi 装配、长期 Agent、NanoClaw、定时任务/朋友圈排列，包含文件链接、函数名、观察变量和 ID 含义；首次启动再配合[环境与 VS Code](./environment.md)。

启动脚本如何选择见[场景对照](../../operations/running.md)。本手册只展开隔离调试与断点。

调试快速导航：[完整环境只调部分模块](./environment.md#功能都可用只调试选中的模块)、[命令面板逐步操作](./environment.md#操作示例后端与-nanoclaw-同时调试)、[launch.json 组合原理](./environment.md#launchjson-如何组合运行与调试)、[全部停止命令与等价脚本](./stopping.md#常用命令与等价脚本)。

## 阅读路线

让Agent搭建新机器时，先交给它[新环境初始化与部署交付清单](./first-install.md)，完成配置、Workspace/Memory和重复启动验收后，再按下面的源码学习路线使用。

| 顺序 | 章节 | 完成后能做什么 |
|---|---|---|
| 0 | [分别关闭正常与调试Chat](./stopping.md) | pnpm/脚本对照、全部/单模块停止、F5停止范围、只读检查与再次启动 |
| 1 | [环境与 VS Code](./environment.md) | 完整运行与按需调试、命令面板操作、多模块组合原理、环境隔离 |
| 2 | [源码、函数与数据结构地图](./code-map.md) | 按文件/函数下断点，追踪 4 个模块的交接对象、事件和 ID |
| 3 | [Chat Web 与 Frontend](./web-frontend.md) | 从点击发送追踪请求、事件流、React 状态与刷新恢复 |
| 3a | [Workflow TUI](./workflow-tui.md) | 终端启动、命令断点、Web共享历史与Fork |
| 4 | [Backend 与 Workflow](./backend-workflow.md) | 追踪配置冻结、Workflow/Step、Agent 装配与 Run 终态 |
| 5 | [Pi 源码调试](./pi.md) | 进入 AgentSession、模型协议、Tool 执行和 Session 持久化 |
| 6 | [配置、Tool、Skill 与 Prompt](./configuration-resources.md) | 判断改动存在哪里、何时生效、资源为何没加载或没调用 |
| 7 | [NanoClaw、Telegram 与微信](./channels.md) | 配置独立渠道，跟踪入站、绑定、Pi、Delivery 与 Ack |
| 8 | [日志与故障定位](./troubleshooting.md) | 根据最后成功节点定位问题，收集可复现证据 |
| 9 | [开发、验证与持续维护](./maintenance.md) | 修改代码、补测试和注释、更新手册、提交子模块与父仓库 |

第一次学习建议顺序：环境 → Web 普通对话 → Backend → Pi 的 `read` → Skill 装配 → Web Friend → Telegram 私聊 → 微信私聊 → 失败重试。无需先把所有架构文档读完。

## 当前系统的主要执行链

```text
普通 Workflow Session
  React / Chat TUI → POST /runs → Workflow → Step → Workflow Agent 包装
                                          ↓
                                    公共 Pi 装配 → Pi AgentSession
                                          ↑
Web Friend → Long Agent 生命周期 ──────────┤
Telegram / 微信 → NanoClaw → HTTP Event → Chat 耐久入站 → Long Agent 生命周期
                       ↑                                  ↓
                       └──── Channel 投递 ← Delivery / Ack ┘
```

普通 Web/TUI Workflow 对话不需要 NanoClaw；Web Friend当前会从 NanoClaw读取 Group 身份/Memory，因此练习它时需要已准备的调试 Gateway。Pi 是 Backend 内调用的 SDK，不是另一个必须占端口的服务。模型协议、资源加载和 Session 的权威实现都在 Pi。

## 场景编号与覆盖范围

| 编号 | 场景 | 最小成功证据 |
|---|---|---|
| ENV-01 | 与正常实例并存 | 专用端口、数据/缓存/浏览器资料隔离，停止调试后正常实例不变 |
| WEB-01 | 普通对话 | `/runs` 接收、模型返回、Run completed、Session 刷新可读 |
| WEB-02 | 流与刷新 | NDJSON 事件、重连/刷新重读，Session 归属不变 |
| TUI-01/02/03 | 普通Workflow终端入口 | 独立TTY、假模型完成、Web共享Session、恢复与Fork |
| WF-01 | Step 装载 | 真正进入 Step、公共装配和 Pi，而非仅得到 202 |
| PI-01 | Tool 调用 | 模型 tool call → 实际 `read` → tool result → 第二次模型响应 |
| CFG-01 | 模型/Thinking 覆盖 | 本轮有效定义与实际 `session.model/thinkingLevel` 一致 |
| RES-01 | Skill 与 Tool | 目录发现、选择、装配、正文读取、调用结果分别有证据 |
| LA-01 | Web Friend | owner 正确、Long Agent Turn 完成、重读 Session |
| CLI-01 | 本地渠道闭环 | Nano CLI入站、Chat/Pi执行、Nano日志投递成功、终端收到DEBUG_OK |
| TG-01 / WX-01 | 独立测试账号私聊 | 入站、稳定绑定、Pi、Delivery、平台收件、Ack |
| FAIL-01 | 渠道/模型/配置故障 | 最后成功节点明确，恢复不重复执行已完成 Turn |

`debug-local/debug-model` 是确定性的本地协议 Fixture，适合断点和重复实验，不具备理解提示词、规划任务或评估真实模型质量的能力。它能证明工程路径走通，不能证明真实模型理解了 Skill。Telegram/微信的真实平台收发需要用户单独的测试 Bot/账号；自动化验证不会登录或发送真实平台消息。

完整调试实例的停止只管理本次拥有的进程，不等于已经实现[全系统在途任务排空合同](../../architecture/chat-system-lifecycle.md)。当前源码已有 Daily 按日轮换与无 pre-task script 的到期任务转发，断点见[源码地图](./code-map.md)；更广泛的唤醒合同、资源隔离、工具 Docker 等仍需按具体实现与[实施状态](../../modules/long-agents/chat-long-agent-roadmap.md)核对，不能把单条路径可达解释为全部能力已完成。

规范事实仍由[配置文档](../../configuration/README.md)、[模块合同](../../architecture/chat-module-contracts.md)、[集成基线](../../modules/long-agents/chat-nanoclaw-pi-integration.md)维护；本手册解释如何观察和验证，不复制一套配置 Schema。
