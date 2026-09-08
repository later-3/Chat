# 配置、Tool、Skill、Extension 与 Prompt 调试

精确格式与优先级由[配置文档](../../configuration.md)维护。修改前先确定“我要改变哪个Project、哪个Agent、哪一轮”，否则很容易改对文件但观察错Session。

## CFG-01：修改模型/Thinking却未生效

在 Debug Lab 新建普通Session，打开Agent配置，选择调试Provider和模型。保存后重读页面，再发送一轮。断点依次放在：

1. [chat-config](../../../src/chat-config.ts) 的 `resolveChatConfig()`：Personal与Project覆盖后的结果。
2. [workflow-configuration](../../../src/workflows/workflow-configuration.ts) 的 `prepareChatWorkflowTurnConfiguration()`：Session最近选择与本轮调整如何冻结。
3. [agent-config-loader](../../../src/workflows/agent-config-loader.ts) 的 `resolveWorkflowAgentDefinition()`：最终model、thinkingLevel、tools和resource路径。
4. [公共装配](../../../src/agents/pi-agent-session.ts) 返回前：实际`created.session.model`和`thinkingLevel`。

| 你要改变什么 | 正确位置 | 常见误区 |
|---|---|---|
| 调试实例默认模型 | `.data/debug/chat-home/agent/settings.json` | 改了正常`~/.chat`或`~/.pi` |
| 调试Provider与认证 | 调试Home的`agent/models.json`、认证流程 | 把生产凭据复制到Git/日志 |
| Project Workflow默认选择 | 该Project`.chat/config.json` | 在Chat源码Project改配置，却在Debug Lab观察 |
| 某Project的某Workflow Agent模型/Thinking | Backend模型配置API；数据在调试Home项目目录 | Personal config.json不支持直接保存这些model字段 |
| 当前Session或本轮 | 运行界面选择与请求中的调整 | 旧Session选择覆盖新默认；新建Session或重置后再测 |
| Long Agent模型/能力 | 长期同事配置页的Personal运行策略 | Project Workflow Agent配置不覆盖Long Agent定义 |
| Group长期身份/职责 | Agent Group页，Nano事实 | Chat显示别名不等于Group运行身份 |

保存Long Agent配置时观察`GET/PUT /api/long-agents/:id/config`中的revision/expectedRevision。两个页面同时修改同一revision，第二个应得到409；保留草稿并重读，不能自动覆盖。模型在保存时会验证目录与认证，实际Provider请求失败则是执行期错误。

默认假模型忽略Thinking和自然语言指令；配置实验应查看有效对象与日志，不能用固定回复推断推理能力。

## RES-01：Skill“有文件但没用”

准备命令会创建：

```text
.data/debug/chat-home/workspaces/debug-lab/.chat/skills/debug-trace/SKILL.md
```

打开Debug Lab，并在直接执行Agent上选择资源inherit。先在资源目录查到debug-trace，再打开Agent检查结果。检查API是：

```text
GET  /api/workflows/minimal-pi-coding-agent/agents/pi-coding-agent/catalog
POST /api/workflows/minimal-pi-coding-agent/agents/pi-coding-agent/resolve
```

resolve请求包含`projectId: "debug-lab"`，需要复现本轮选择时同时传入页面实际的selection；检查默认值并不能替代检查本轮选择。请求通过浏览器现有客户端构造，精确结构见[resolve路由](../../../src/routes/api/workflows/%5BworkflowId%5D/agents/%5BagentId%5D/resolve.post.ts)。

将问题拆成 5 个检查点：

| 检查点 | 证据 | 定位入口 |
|---|---|---|
| 发现 | Catalog有文件、正确scope/path | [resources/skills](../../../src/resources/skills.ts) |
| 选择与授权 | inherit/explicit、实际skillPaths、允许的Project根 | `resolveWorkflowAgentDefinition()` |
| 装配 | reload之后的Skill列表与diagnostics | `DefaultResourceLoader.reload()`、[inspectWorkflowAgent](../../../src/workflows/agent-inspection.ts) |
| 模型可见 | System Prompt中的摘要/路径；调用方式限制 | `session.systemPrompt`、Skill元数据 |
| 正文使用 | 原生read Tool调用和ToolResult正文 | Pi read与Session历史 |

发送`DEBUG_READ_SKILL`，应发生一次read并返回DEBUG_SKILL_LOADED。这只验证Tool读取路径。再将资源改为explicit且不选Skill，检查装配列表确实消失；假模型仍知道练习路径，可能继续请求read，所以不能用它来证明资源策略限制了通用文件读取权限。Skill选择和文件工具授权是不同机制。

用真实开发模型验证语义时，可要求“按debug-trace方法完成任务”，观察是否自行读取正确正文。修改Skill内容后重新检查并开始新一轮；当前没有覆盖所有资源的统一即时通知/包版本冻结合同，不要承诺运行中Agent立即重新加载。

## RES-02：Tool出现在列表却不能调用

目录由Backend提供；前端不能硬编码另一份Tool清单。Chat系统Tool位于 [tools/registry](../../../src/tools/registry.ts) 与 [tools/builtins](../../../src/tools/builtins)，Pi Tool在Pi公开注册系统中。

检查顺序：

1. 地址是否真实注册，例如`system:tool/project_read`；名称、地址、manifest是否对应。
2. Agent工具策略是pi-default、explicit还是none；explicit是完整选择，不会自动补回read。
3. 公共装配中`chatTools`、`customTools`是否构造成功；缺Project/Tool执行上下文会拒绝。
4. `session.getActiveToolNames()`中是否存在目标Tool。`getAllTools()`存在但未激活不算可用。
5. 模型请求中的Tool Schema是否被Provider接受；实际参数是否通过校验，执行是否返回错误。

实验：显式只选一个Chat系统Tool且不保留read，再发DEBUG_READ_SKILL，假模型应返回DEBUG_READ_UNAVAILABLE。恢复read后重试新一轮。不要因为Skill需要read就在装配里偷偷增加用户没有选择的Tool。

Chat Tool的projectId/chatHome/sessionId必须来自可信运行上下文，不能让模型参数伪造。断点不要执行有副作用的表达式；Watch只读值，不调用write/record/configure之类方法。

## RES-03：Extension与Plugin未加载

Project资源通常位于`.chat/extensions`，Personal资源在调试Home的agent范围；显式模式只解析明确选择的extensionPaths/pluginSources。具体格式读[Pi Extensions](../../../pi/packages/coding-agent/docs/extensions.md)与[Packages](../../../pi/packages/coding-agent/docs/packages.md)。

先看ResourceLoader的extension errors，再看扩展注册的Tool/钩子是否进入实际session。文件语法错误、依赖未安装、路径越界、重复Tool名称、显式模式没选择都是不同原因。Extension会执行宿主代码，学习实验只用自己编写的无副作用扩展；不要随便安装未知包来验证目录发现。

新增Tool/Skill通常只需Backend目录重读；如果新增的是API枚举或响应结构，则必须更新Frontend严格parser。安装成功、Catalog发现、Agent实际装配是三种不同证据。

## RES-04：Rule、Experience与Memory

Rule/Experience通过Prompt资源引用进入Agent自定义Prompt。在检查结果中核对target、id、revision、selectedBy、reason，再看Session本轮记录；同一轮检查与执行应使用相同内容。`buildChatAgentCustomInstructions()`负责可见的Chat附加区域，不能在Workflow Node中另拼一套规则。

Memory分两类：Chat Personal/Project使用`memory_*`，Nano Group Markdown使用`agent_memory_*`。读到另一类Memory不是“缓存没刷新”；先核对Tool名称、当前Project/Long Agent和实际来源。Group Memory写入带expectedRevision，409时重读；审计见[日志章节](./troubleshooting.md)。

Nano目录中的Skill并不因为文件存在就自动成为当前Chat Pi Skill。当前资源接入范围和未完成的Long Agent资源同步见[工程基线](../../architecture/chat-long-agent-engineering-baseline.md)，不要复制整棵Nano groups到Chat Home来绕过边界。
