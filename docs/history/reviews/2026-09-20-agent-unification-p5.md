# P5 数据兼容与全链验收

状态：代码、无损迁移演练与本地全链验收完成；真实 Telegram 外部收发及用户最终审核待完成。不能据此宣称 P1–P5 的全部退出条件已满足。承接[阶段计划](../../development/agent-unification-plan.md)，操作步骤见[升级与恢复](../../operations/friend-migration.md)。

## 场景、机制与变更

既有历史必须继续可读，新的 Friend Home 不能吞并旧 Project 的身份、Memory 或渠道目的地。本轮沿用 Pi JSONL、Backend Session 读模型及现有迁移目录，没有新增消息库或第二套运行时。

| 发现的问题 | 已实施的修复 |
|---|---|
| 合并跳过冲突后仍删源；重试覆盖首次备份 | Home 迁移 v2 保留源目录与配置；无覆盖复制，冲突明确失败；首次备份原子发布，完成标记最后写 |
| 老 Project 登记与原生历史被搬走，旧链接失效 | 新迁移保留原位；针对已完成 v1 的数据，记录精确 sourceProjectId＋sessionId→targetProjectId，保留旧备份 |
| Memory 被自动提升到 Personal | 移除自动提升，保留旧 Project 作用域；不修改 Nano Markdown Memory |
| 只索引当前 primary，昨日及 schema1 非主历史被当普通会话 | 所有 dailySessions、原始旧绑定和迁移收据进入公共所有权索引；冲突拒绝 |
| 前端只读可能被后端 Workflow/改名绕过 | 服务端也禁止接管历史 Friend Session；旧链接通过统一 Session API 解析 |
| 定义拆分冲突、state 写完但标记未写，重试缺恢复依据 | 校验全部定义后拆分，保留首次备份；定义迁移加锁，补齐 schema4 完成标记恢复 |
| 相同每日 Session 的两个渠道可能选中错误绑定 | 同时校验来源地址、Group、实例和目的地，已有绑定不因失效默认项目被重新解析 |
| 页面恢复丢掉显式项目身份 | URL 与设备恢复保留可选 sessionProjectId；未知精确目标报错，不搜索另一项目冒充成功 |

变更位于 `src/migrations/agent-home-normalization.ts`、`src/long-agents/{storage,bridge}.ts`、`src/session-{owner,read-model,name}.ts`、Workflow 启动门禁及 Frontend 导航适配。普通/Friend 仍复用公共聊天更新与渲染。

## 自动化与数据副本

完整 `pnpm verify` 在隔离源码副本执行，含架构检查、34 个工具测试、351 个后端测试、170 个前端测试、严格类型、Frontend/Backend/CLI 生产构建、30 个 Built Server 测试、1 个 Nitro dev→Frontend Run 合同→Workflow→Pi→本地模型测试，共 586 项。父仓库与 Frontend 的 diff 检查另行执行。没有修改 Pi/Nano 源码，不宣称重跑其原生完整测试。

新增 `test/long-agents/migration.test.mjs` 10 个场景测试，替换 1 个只验证旧破坏性归一结果的测试；覆盖原件哈希、两端冲突、失败重试、非法 JSON/符号链接、v1 两类历史、schema1 非主历史、每日归属、并发定义、state 中断恢复及服务端只读。已有渠道测试增加同 Session 不同地址回归。Frontend 补显式项目导航与精确读取合同。

真实 debug 数据的受限副本共 21,829 个文件；演练仅调用迁移函数，不启动副本服务或重放渠道事件。26 份历史与资源原件哈希全部不变；2 条旧链接均可读且仍归 Friend、只读；第二次迁移返回无操作，文件差异为 0。副本检查后删除，不归档私人历史或凭据。既有 v1 若已删除内容且不存在独立备份，v2 不能凭索引恢复其字节。

生产代码与隔离构建的文件摘要存于本地 `source-version.json`；浏览器版本另存 `browser-source-version.json`。浏览器验收后仅补入可选择的迁移 experience 资源，再运行完整门禁，聊天与迁移执行代码未变。工作区含本轮及此前未提交改动，不能仅以 Git HEAD 代表验收版本。所有构建使用独立目录；未部署、提交或推送。

## 真实 Chrome 与 DeepSeek

使用本机 Chrome、生产构建、独立 CHAT_HOME、隔离“思考/学习”项目及现有已配置的 DeepSeek 模型。Nano Group 为测试快照，Gateway 不连接；因此这些结果只证明真实 Web→Backend→Pi→模型链，不能替代真实 Telegram/Nano 收发。

| 操作 | 实际结果 |
|---|---|
| 旧 Friend URL 打开并刷新 | 原历史可见，归属 Friend；只读提示、0 个输入框；无浏览器错误 |
| 普通 Session 读取思考 AGENTS.md 并回答 | 287 次不同内容 DOM 采样；实际 read 指向思考，返回 THINKING_PROJECT；8,126 tokens、1 工具、9.7 秒，正常完成 |
| Friend 读取同一项目，流中刷新 | 刷新前已观察 8 次不同内容采样；刷新恢复后完成；请求只提交 1 次；4,326 tokens、1 工具、3.5 秒 |
| 同一 Friend 思考→学习后再发送 | Session ID 前后一致；接受记录 contextProjectId=learning，实际 read 指向学习，返回 LEARNING_PROJECT；5,009 tokens、1 工具、2 秒 |
| 核对耐久终态 | 两个 Friend Turn 的 GET 均为 completed，保留各自项目、原生工具调用及回复 |
| 桌面暗/亮与手机 | 截图实看；390×844 下 scrollWidth=390，发送入口可见；历史上下文标签仍保留原项目 |
| 错误的显式 projectId＋session | 显示无法打开指定会话，没有静默回退；对应 404 属于故障注入 |

普通 Session：`01a0ba72-66b2-7edb-bc88-7adb590542cf`；Friend 当天 Session：`01a0ba75-64ba-726c-b033-7525d44f35d5`。真实模型测试均为隔离项目只读。采样、截图、合成输入及门禁日志存于 `.data/verification/p5-2026-09-20/`，不进入 Git。

## S01–S12 证据矩阵

自动化随本次完整门禁复验；未改的浏览器异常场景引用 [P4](./2026-09-19-agent-unification-p4.md)，不声称本轮逐个重新人工操作。

| 场景 | 证据与边界 |
|---|---|
| S01 同日项目 A/B | P2 公共装配测试；本轮真实模型与浏览器同 Session 切换、实际工具路径 |
| S02 无项目 | P2 装配隔离测试：自身空间、无上次项目泄漏 |
| S03 无效项目/规则/路径 | P2 授权与错误测试；P5 非法迁移文件及精确旧链接错误 |
| S04 在途切换 | P2 冻结测试；P4 真实浏览器取消/跨项目后续；本轮下一轮上下文实测 |
| S05 Web/渠道并发 | P3 并发排序与同日测试；本轮同 Session 不同地址回归。真实 Telegram 并发尚未验收 |
| S06 换日/总结/重启 | P3 可控时钟、失败重试与交接测试；P5 昨日只读、定义/state 中断恢复 |
| S07 刷新/切换/断网 | P4 真实浏览器断网及切页；P5 真实模型流中刷新，POST 不增加 |
| S08 异常与取消 | P3/P4 真实 Pi 故障注入、取消/排队/重启自动化及 P4 浏览器验收 |
| S09 压缩/跨日 | P3 原生 Pi 压缩恢复与总结；P4 浏览器压缩后的下一轮/刷新 |
| S10 普通/Workflow/TUI | 全量门禁含 TUI/Built/dev；本轮普通 Session 真实模型对照 |
| S11 重送/投递故障 | P3/P5 耐久 Event、模型执行去重、Delivery/Ack 的受控 HTTP 测试。真实 Telegram 投递尚未验收 |
| S12 旧数据/布局 | P5 数据副本、10 个迁移测试、旧 URL 浏览器刷新、明暗/手机截图 |

## 退役机制、兼容及自检

本轮移除：冲突后删源、自动合并原生历史、自动提升 Project Memory、启动清扫 `.chat`、迁移时创建当天空会话，以及仅凭共享 Session ID 选择渠道。旧 HTTP messages API 仍兼容；过去历史继续可读，但不能把旧 Friend 当普通 Workflow 写入。这是明确的所有权约束，不是删除历史功能。

1. **范围**：旧项目、Friend 历史、渠道绑定、URL、配置迁移均有代码与测试，不只处理新建路径。
2. **场景**：覆盖冲突、并发、重试、中断、历史只读；S05/S11 真实 Telegram 明确保留未验收。
3. **最终目标**：Project 上下文与 Home/Session 归属独立；同一天 Friend 唯一 Session，普通会话继续正常工作。
4. **统一性**：精确恢复经过公共 Backend 读模型；后端写入口执行同一归属约束；未另造聊天 Runtime。
5. **证据**：自动化、真实数据副本、真实 Chrome＋模型、受控 Nano HTTP 分开记载，586 个测试不代替外部通道证明。
6. **文档兼容**：配置、Session、Long Agent 架构、Nano 接缝、路线图及 Frontend 规范同步；[迁移经验](../../development/experiences/session-migration-provenance.md)与可选择的 experience 资源同步归档。
7. **修复闭环**：发现的源删除、备份覆盖、旧 ownership、渠道误匹配及显式 URL 缺陷已修复并回归；未通过的真实外部验收不以“后续优化”冒充完成。

下一步：用户审核本地交付；具备明确授权的 Telegram 测试私聊后补外部来信、模型执行、对应目的地投递和回执，并在 Web 核对同一日历史。该项完成前保持 P5 最终验收开放。
