# DSH前端派生与维护

## 1. 当前结论

Chat的唯一产品前端是由Chat维护的DeepSeek Harness窄派生，不再承诺“永远只安装上游发布包且完全不改上游源码”。插件优先仍是默认决策：LifeOS Bridge继续通过公开Host/Client插件、Slot、Conversation Definition和LLM Adapter接入Chat；只有公开扩展点无法表达DSH原生表面的必要语义时，才允许修改DSH宿主。

当前唯一例外是Trajectory。rc.6允许插件向`trajectory` target贡献独立Tool tree，也把Conversation Location交给Contribution；但快照和layout没有保留、消费这项Location，完成后的独立根调用只能落到Turn序言。rc.6同时把标签固定为`TOOL/SUBTOOL`，并把完整调用参数与结果直接用作列表预览。插件不能在不复制Trajectory组件、不修改DOM、不伪造Assistant事件的前提下显示`WORKFLOW/NODE/STEP/AGENT/MODEL/TOOL`，同时把完整Payload留在检查器。因此单靠LifeOS插件无法同时满足真实时序、原生树形交互、业务语义标签和摘要/详情分层。

窄派生只补齐三个通用宿主能力：保留独立Contribution的Step Location、允许Contribution提供表现标签，以及允许Contribution覆盖紧凑的输入/输出行预览。原始调用参数和结果仍由原生检查器读取；底层记录仍是DSH原生`tool/subtool`，折叠、计时、详情、颜色、无障碍语义和搜索仍由原生Trajectory拥有；DSH不知道Chat Workflow对象，也没有第二套历史或执行。

统一会话显示不增加派生例外：原生侧栏继续拥有DSH Session的新建、历史选择和归档；LifeOS Bridge直接
使用rc.6公开`SessionQuery`读取live/persisted日志，并通过公开`conversation.view`加法注册“会话记录”。
双方只在Bridge查询时按身份组合，DSH源码不认识Product Session，Chat也不接管DSH日志或归档集合。

## 2. 仓库与分支

- 官方只读上游：<https://github.com/deepseek-ai/deepseek-harness>，本地remote名为`upstream`。
- Chat公开派生：<https://github.com/later-3/deepseek-harness-chat>，本地remote名为`origin`，仓库可见性保持Public。
- 公开派生的默认分支：`main`。
- 当前维护分支：`codex/chat-trajectory-location-rc6`。
- rc.6上游基点：`15148dbd9a1d1f1ef1a26e5749b32af0cd663935`。
- Trajectory实现提交：`708cca1ed78995b986c3400493809ee06d1c3b0e`。
- 当前公开派生分支头：`bcca246a5e4ab4e002e9caa0e4e20160a8bd06e8`，在实现提交之上记录维护规则，不改变运行代码。

Chat主仓库不复制DSH源码。运行安装仍固定`@deepseek-ai/dsh@0.1.0-rc.6`，并以可审核pnpm补丁消费同一差异；公开DSH派生仓库拥有派生源码与上游汇合历史，Chat仓库拥有固定版本、补丁、Hash、Bridge和运行时漂移门。

## 3. 上游跟踪与汇合

每次上游正式版本、安全修复或相关Trajectory变更都触发一次评估：

1. 从`origin/main`建立独立`codex/dsh-upstream-<version>` worktree和分支，获取`upstream`的新tag与提交。
2. 先审阅上游是否已经提供等价公开扩展点；若已经提供，优先删除本地差异并让Bridge改用上游合同。
3. 若仍需派生，把新的固定上游版本汇合到维护分支，只重放Contribution Location、表现标签和紧凑行预览三项差异；不得顺便换皮、复制页面或加入Chat业务对象。
4. 在DSH源码仓库运行受影响测试、`pnpm run typecheck`、bundle、lint和`pnpm run doc-sync`。
5. 从已验证源码重新生成Chat仓库的pnpm补丁，更新版本、补丁SHA-256、lock patch hash、派生提交和运行时漂移标记。
6. 在Chat仓库通过Bridge合同、根级门和真实浏览器Planning/HITL/Trajectory E2E后，才更新公开派生`main`与Chat固定依赖。

公开派生`main`不直接在共享checkout上开发，不强推覆盖远端历史。任何超出上述三项能力的DSH源码改动都必须重新说明插件为何不能完成、修改面、退出方式和升级成本，并取得用户确认。

## 4. DSH运行时与Chat后端边界

“不使用DSH后端”只能理解为“不使用DSH自带模型Provider和Agent业务执行作为Chat产品执行”。当前产品仍使用DSH Host侧的Session、事件日志、Agent loop请求组装、插件生命周期、Trajectory投影和Web服务；`lifeos/workflow` LLM Adapter取代模型执行入口，将真实用户命令提交给Chat Workflow，等待Product Run终态，再把Product Store中的正式Assistant Message流回DSH。

Bridge的`lastUserPrompt`只接受`role === "user" && source.kind === "user"`的最后一条非空消息。DSH注入的Context虽然保留在DSH Session与Trajectory中，但不会作为Chat Message提交，也不会进入Planner/Executor上下文，更不会产生第二套Workflow执行。

## 5. User之后的三类Context

当前DSH base bundle在模型每个`pre-step`重新检查生产者Context。会话第一次发送消息时尚无既有快照，
因此首个模型Step会在真实User之后、`request/header`之前生成当时实际可用的Context；后续Step只有在
工作区指令、运行权限或Skill目录发生变化，或者compaction已经替换旧快照时，才追加新的耐久Context，
内容没有变化时不会机械重复写入。已落入Session surface的Context仍会随后续请求继续发送，并非只在首轮生效。

当前可见输入来自三类生产者；“三类”不代表每个Profile固定产生三条，例如没有可发现Skill的隔离Profile
可以没有Skill Catalog：

| Trajectory内容 | DSH来源 | 作用 | 是否进入Chat Workflow |
|---|---|---|---|
| `The following workspace instructions...` | `@deepseek-ai/dsh-agent-instructions`，`source.kind = agent-instructions` | 从`AGENTS.md`等文件装配工作区指令基线 | 否 |
| `Current runtime context...` | `@deepseek-ai/dsh-system-prompt`，plugin snapshot | 声明DSH文件沙箱、审批和运行权限快照 | 否 |
| `A skill is a reusable...` | `@deepseek-ai/dsh-tool-skill`，`source.kind = skill-catalog` | 有可发现Skill时，告知DSH Agent当前目录 | 否 |

它们来自DSH Host的基础插件图，与LifeOS PWA manifest、Service Worker和安装能力无关。它们之所以出现在Trajectory，是因为DSH坚持“模型可见输入必须可从Session日志重建”；对当前LifeOS路由而言，Adapter会忽略这些注入，只保留其DSH会话审计价值。是否在未来精简默认DSH profile或调整其Trajectory呈现，需要单独评估，不能把它们误认成Chat业务Context后直接删除或改名。

LifeOS Bridge通过公开`SessionStore.get(SessionId)`和`Session.deriveMessages()`提供同源只读
`GET /lifeos/sessions/:dshSessionId/context-injections`。Client把“上下文”入口注册到空白Hero与活动会话都存在的
`conversation.input.left` Slot，打开后显示当前surface中的来源、form、结构化来源提示和有界正文；它读取的是
compaction替换后的下一次请求输入，不从Transcript DOM反推，也不写DSH事件。空会话明确显示“尚未组装”：
rc.6没有无副作用执行全部`pre-step`中间件的纯预演合同，Bridge不会复制AGENTS、权限和Skill组装规则来伪造
首次发送前的精确内容。正文按需读取，不进入每秒Product Run轮询；单项最多显示50000字符、最多64项，截断或
省略都会在面板标明。当前版本是查看/刷新管理面，不提供启停或编辑生产者Context的写能力。
