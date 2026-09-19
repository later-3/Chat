# P3 每日生命周期交付与自检

日期：2026-09-19。范围：开发计划 P3；用户要求每阶段逐项自检，不把缺失场景挪到后续阶段。当前状态：代码、文档、场景自检与最终完整门禁完成，待用户第一轮审核；P4–P5 未实施。

## 1. 交付与事实入口

- `src/long-agents/project-agent.ts`、`calendar.ts`：持久 IANA 时区、Home 日期唯一索引、旧链接拒写、原生日历标记恢复、不创建空闲日 Session。
- `daily-state.ts`、`turn-queue.ts`、`runtime.ts`：耐久接受、冻结公共装配、来源幂等、Friend 内排序、排队取消/受限重试与不明中断保护。没有第二套模型运行时。
- `daily-maintenance.ts`、`summaries.ts`：旧日内部只读维护轮次、原生 cutoff、原子总结、派生文件修复、崩溃输出恢复、1/5 分钟最多 2 次自动重试、缺失交接说明。
- `bridge.ts`：已配置/绑定私聊与调度共用接受服务；冻结目的地，完成后只 Delivery/Ack，不在次日重建空 Session。
- 现有 Friend 配置与新 daily GET/POST 合同、Frontend `FriendDailyStatus`：查看日历/错误/旧记录、重试总结/失败请求、取消 queued。不宣称已经取消运行中模型。

精确合同只维护在 [Long Agent 架构 §4.2.1](../../modules/long-agents/chat-long-agent-architecture.md#421-p3-实现合同2026-09-19)，配置、Session、模块和 Frontend 文档引用它。

## 2. 场景证据

自动化门禁使用临时 Chat Home/项目和本地假模型，不读取正式 Credential、不发送外部消息。用户要求后补做的独立真实模型验收见第 7 节，与默认门禁分开记录。

| 场景 | 实际验证 |
|---|---|
| S05 同 Friend 多入口 | 并发接受 Web/channel/schedule、规则在接受后更改、顺序执行、来源幂等；实际 Web 执行与 Nano Event 同时发起，共享唯一原生 Session |
| S06 跨日/空闲/失败 | 只替换 Date，接受在午夜前、执行在午夜后；总结不创建今天的空会话；A/B 交接进入下一日每轮装配；JSON 格式失败、网络重试上限、文件写入故障 |
| S07 重启/重复观察 | 独立 Node 进程从持久 seed 恢复 queued；完成收据重放不调用模型；有原生 stop 输出的 running 恢复完成，其余 interrupted |
| S08 失败/取消 | queued 取消不执行模型；失败重试不追加用户消息；有后续对话时拒绝回退分支；未知工具副作用不自动重放 |
| S09 压缩 | 真正调用 Pi compact，检查原生压缩输入含 A/B 历史标签，重开后继续通过 write 写入 B，随后同一旧日 Session 正式总结 |
| S11 投递 | 模型已完成而 Gateway 503，次日重试仅 Delivery/Ack；断言模型调用数、日历数、原回复和目的地；未知私聊/群聊拒绝 |
| 迁移兼容 | state 1–3 转 schema 4 并留 source/complete；恢复索引前已落盘的原生日历标记；旧 Session 仍可读，未拼接旧业务历史 |

自动化入口：`test/long-agents/daily-lifecycle.test.mjs`、`long-agents.test.mjs`、`config-root.test.mjs`；浏览器响应合同 `frontend/lib/friend-daily-browser.test.mjs`、`long-agents-browser.test.mjs`。

## 3. 本轮自检发现与修复

1. 索引提交前可能遗留日 Session：首次原生标记随 flush 提交，恢复扫描既有标记，同日多候选报错。
2. 旧失败请求重试会回退并遮蔽后续分支：后续已执行或旧日已收尾时拒绝重试，要求新消息。
3. running 恢复误用后续轮次的 assistant：按原生 Turn Marker 限定范围；只有本轮 stop 才证明完成。
4. 总结 JSON 完成而 Markdown 写入失败：保留 JSON 事实，显式重试只修派生文件，不重复调用模型。
5. 格式失败后错误复用旧无效回复：仅中断恢复复用完整原生输出，显式重试重新总结。
6. 次日重投调用每日定位导致空 Session：已接受事件直接使用固定日期/Session，不读取新日定位；完成投递可在 Friend 停用后继续。
7. 渠道事件与执行信封必须原子关联：同次状态提交保存，规范化事件字段后计算摘要，避免图片字段顺序产生伪冲突。
8. 时区修改后新请求误记日历初建时区：每轮记录当前持久配置时区，同日期仍复用原Session。
9. 默认夜间总结自身制造空闲日活动：Nano 日终草稿在无活动时只留事件收据，不分配Session；预置文本与只读执行合同同步。
10. 移动窄屏日期与按钮碎行：复用设置语义样式，按完整控件换行，保留触控尺寸；无新 UI 框架。
11. 无效总结正文包含网络故障字样时误触发自动重试：格式解析错误与认证错误先排除，只有暂时性传输故障进入自动重试；增加相应回归断言。

## 4. 七项强制审计

| 项 | 结论 |
|---|---|
| 范围 | 每日唯一、接受冻结、换日、队列/恢复、总结/交接、原生压缩、Delivery/Ack 及必要管理入口均落地 |
| 场景 | 上表覆盖 P3 分配场景的正常、错误、并发、恢复；外部真实 Telegram 未实测，明确留在 P5 |
| 最终目标 | Storage Home / Own Workspace / Collaboration Project 分离；单一公共装配和 Pi 原生 JSONL，没有前端事实缓存 |
| 统一性 | Web/Nano/调度共用接受及执行；配置同一 revision 服务；Frontend 只消费投影 |
| 证据 | 区分本地真实 Pi、模拟 Gateway、独立进程和浏览器组件实测；最终完整构建链结果见下 |
| 文档与兼容 | 权威模块、配置、Session、测试、前端文档同步；schema 4 有恢复材料；P5 历史数据副本演练仍未完成 |
| 修复闭环 | 上述缺陷均加场景断言/浏览器复验；不把 P3 必选工作藏进 P4 |

## 5. 门禁与浏览器

最终源码的 `pnpm verify` 退出码为 0：34 项工具脚本、337 项后端、165 项前端、30 项生产服务、1 项 Nitro 开发执行链，共 567 项测试全部通过，另通过类型检查及前后端/CLI 生产构建。开发执行链实际经过 Frontend Run 合同、Workflow、Pi SDK 与本地模型并进入 completed。针对性每日生命周期测试 15 项通过。

原环境有运行中的 `.output`，完整 verify 在隔离源码副本 `/tmp/chat-p2-verify.V2ET3T` 执行，不重建用户运行产物；日志 `/tmp/chat-p3-verify-final.log`。工作仓库 `pnpm check:architecture`、`git diff --check`、`git -C frontend diff --check` 通过。架构导航检查不替代上述运行时验证。

Browser plugin not available；使用已安装 Playwright/Chrome。目标流程：Friend 设置的日常记录 → 查看会话与交接 → 总结失败重试/取消排队 → 服务端响应校正状态。隔离 Vite 组件挂载与受控 HTTP 响应，不操作用户 Friend 数据。基线与修改后截图分别保存在 `/tmp/chat-p3-qa/`，覆盖 light/dark × 360/900/1440，检查页面身份、非空、无框架 overlay、无 console pageerror、键盘与 200% 缩放。真实后端动作另外由 HTTP 路由测试验证，不能把浏览器 fixture 当全栈实测。

## 6. 已知范围

P4：接受后执行引用、统一实时流、运行中取消/steer、断线观察恢复；现在 Friend Web 仍等待整轮 HTTP，管理面轮询不是流式替代。P5：生产数据副本迁移演练及经明确授权的真实外部渠道验收。未修改 Pi/Nano 源码；未提交、推送或部署。单 Backend/Chat Home 并发边界仍适用；不可恢复的旧 Extension 版本明确失败，不偷偷使用新代码。

## 7. 补充真实模型验收

首次交付只完成假模型运行链和浏览器组件验证，不能据此声称真实模型已验收。用户指出该缺口后，2026-09-19 使用现有 Provider 配置，执行独立脚本 `scripts/long-agent-live-smoke.mjs`；明确付费调用参数、命令和隔离边界见[真实模型验收](../../development/testing.md#独立真实模型验收)。

| Provider / 模型 | 结果 | 耗时 | 真实文件工具结果 |
|---|---|---|---|
| deepseek / deepseek-flash | 7 项通过，退出码 0 | 72.649 秒 | 5 次 |
| volcengine-ark / deepseek-v4-flash | 7 项通过，退出码 0 | 69.737 秒 | 5 次 |

每个模型依次验证：A 项目规则和读写；同 Friend 同日期转到 B 项目且不改 A 文件；重复请求返回原消息且原生历史不增长；真实 Pi 压缩、重新打开并继续工具操作；真实模型输出日终 JSON，总结有来源且重复维护不重做；次日新 Session 只从交接恢复随机待办验证码并加载 B 规则；日历接口返回两个日期及全部完成收据。文件文本断言允许首尾空白，不声称完成字节级复制验证。验证码只出现在前日会话与总结中，不写入项目文件，次日请求也不再次提供它。

使用生产 H3 消息/日历路由处理器与公共 Pi 装配，模型请求实际发往所选 HTTPS Provider；路由由进程内 `router.fetch(Request)` 驱动，没有启动浏览器或另一个 Nitro 服务。Nano 身份是合成测试 Snapshot，日期仅替换 Date，测试专用压缩窗口降低以触发原生压缩；没有读取现有会话、个人记忆或向 Telegram 发送消息。临时项目、Chat Home 和认证已清理，仅留下合成场景报告。

本机原始证据（临时文件不随 Git 发布）：

- DeepSeek：`/private/var/folders/19/jm_fm6vd35x97z1p1rv_3g240000gn/T/chat-friend-live-GDbvM9/report.json`。
- 火山：`/private/var/folders/19/jm_fm6vd35x97z1p1rv_3g240000gn/T/chat-friend-live-L65dcA/report.json`。
- 日志：`/tmp/chat-p3-live-model.log`、`/tmp/chat-p3-live-ark.log`。

失败记录也保留：首次因测试会话太短，Pi 正确拒绝压缩（3 项通过后停止）；调整测试保留窗口后，一次关闭重试的压缩请求返回 `Turn prefix summarization failed: Request timed out.`（3 项通过后停止）。随后去掉从故障 Fixture 带来的禁用重试设置，使用当前 Friend 同样的 Pi 默认重试策略，两个模型完整通过。未把超时推断为已确定的服务端原因，也未修改生产超时阈值来绕过；失败报告分别位于 `chat-friend-live-nI4n0c/report.json` 与 `chat-friend-live-jM84Hq/report.json`（同一临时父目录）。

用量仅统计原生 assistant 消息：DeepSeek 输入 9,861、输出 1,500、缓存读取 13,440；火山输入 19,906、输出 1,261、缓存读取 4,096。这不包含 Pi 内部压缩请求，不能当作总计费量。14 项真实模型场景与原 567 项自动化测试分开计数；本轮只增加验收脚本和文档，没有改变生产代码。
