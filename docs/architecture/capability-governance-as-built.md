# Capability 身份、动作授权与证据闭环 As-built

本文是任务 03 集成后的唯一 Capability 治理事实源。它描述已经落地的身份、授权、持久化、崩溃恢复和验证边界；历史任务书只保留验收来源，不作为运行时授权。

## 1. 事实所有者

| 事实 | 所有者 | 非所有者 |
| --- | --- | --- |
| Tool 定义、真实 handler、Extension SourceInfo、AgentSession 最终目录 | 对应 Pi Runtime/Provider | DSH、Product Store |
| qualified Capability Descriptor 与运行 Scope 解析 | Runtime Catalog；Run 采用快照由 Application 冻结 | Tool 本地名、浏览器配置 |
| AgentVersion、RunSpec、Prompt Assembly v4 | Product Store / Application | Workflow、Pi Session |
| Tool Intent、Decision、Result、一次性 claim | Product Store / Application | Pi Journal、DSH |
| Tool 调用顺序、完整输入/结果事件、Result 先落盘证据 | Pi Operation Journal | Product Store |
| Tool Review 展示和同一 Command 的网络重试投影 | DSH Bridge State v16 | Product Intent/Decision |
| Product Run 终态和正式 Assistant Message | Application | Workflow、Pi、DSH |

## 2. 版本兼容矩阵

| 边界 | 当前写版本 | 历史读取 | 升级与降级政策 |
| --- | --- | --- | --- |
| Product Store | `chat-product-store.v20` | v1–v19 | main 的 v18→v19 先保留 Project Bootstrap Outbox；v19→v20 只增加 Tool Intent/Decision/Result 空集合。严格 v19 不接受 donor 私有歧义 Tool 集合；迁移原子落盘、重启字节幂等，未知/损坏失败关闭 |
| DSH Bridge State | `chat-dsh-lifeos-state.v16` | v1–v15 | v15 保留新会话偏好、Message 提交状态和 bootstrap lifecycle；v15→v16 只允许每条 Request 增加 `pendingToolExecutionDecision` 本地重试投影。pending逐字段绑定Run、Intent、revision、完整Capability、input、scope、kind和explanation；Product Tool事实不进入Bridge |
| Agent Profile API / Agent Version | `chat-agent-profile-api.v3` / `agent-version.v2` | Profile v2、Version v1 严格只读 | v2 Profile保持原字段集；v1 Version禁止qualified扩权。新Version必须显式携带`enabledCapabilityRefs`，合法零Tool用空数组表达 |
| Direct Prompt Assembly | `prompt-assembly.v4` / compiler v4 | v1/v2 历史读取；v3 属于多节点 Workflow | v4 强制冻结 `runtimeProfileSha256`、Workspace Grant 配对、完整 Resolved Capability Snapshot 和 Resources；历史裸名 Run 不能新建 Tool Intent |
| Pi Direct Protocol / Store | `pi-direct-executor.v2` / `pi-direct-executor-operation-store.v2` | v1 文件只读投影 | Service入口只接受v2；v1文件不原地改写，任何恢复写入失败关闭。Client把首次request hash写入Workflow checkpoint，逐次核对POST、Events、Event和Snapshot的Operation/Request身份；v2→v1降级失败 |
| Planning/Coding Journal | `pi-executor-operation-store.v2` / `full-operation.v3` | 外层v1中的真正旧记录与`full-operation.v2`只读 | 新外层代际强制v3，删除integrity、settled、visible hash或Capability不能降级。Client钉住首次代际，v3→v2/v1失败 |

## 3. donor 资产采用表

| donor 资产 | 集成结论 | 最终实现 |
| --- | --- | --- |
| Capability 合同与目录 | 基于 main 重写 | 保留 qualified ID、来源、描述符、实现、Scope、审批和 Evidence 政策；增加依赖树 Hash、普通重复 localName、冲突 ID 与受管 bootstrap SourceInfo 门 |
| Tool 产品事实 | 直接采用并加固 | Intent/Decision/Result 三集合进入 Product v20；Intent 必须属于 Attempt 的 Prompt Assembly v4 Manifest |
| Agent 与 Runtime 冻结链 | 基于 main 重写 | `enabledCapabilityRefs` 从 Version/Temporary 进入 RunSpec；Prompt Assembly v4 冻结完整 Snapshot，Runtime 再与真实 AgentSession Manifest 逐项比较 |
| Pi Tool Gate | 采用并补崩溃顺序 | Product claim 在 handler 前；Journal Result 先于 Product Result；响应未知同 Command 重放，重启从 Journal Result 恢复，不重新 claim/执行 |
| DSH Tool Review | 直接采用到 Bridge v16 | 独立 Tool 卡片显示 qualified ID、来源、effect、scope、输入摘要和 Hash；拒绝映射 `tool.blocked` |
| Planning 结构化 Evidence | 采用并修复旁路 | `strictEvidence` 只控制文字逐条匹配；结构化 Evidence 永远开启并按 Attempt、Capability、toolCallId、Result Hash 验证 |
| 非付费真实纵向 | 基于 main 重新接线 | 独立 455xx 端口与数据根；真实 DSH/Router/Workflow/Pi AgentSession，进程内 Faux Provider；显式环境白名单、响应丢失、拒绝和 Pi 进程重启 |
| donor 私有 Product v19 / Bridge v13 | 明确淘汰 | 不兼容未部署歧义格式；使用 Product v20、Bridge v16 |

## 4. Capability 身份与 Scope

`capabilityId` 至少区分 Runtime owner、能力种类和来源 namespace。built-in 绑定 Later Pi Fork revision 与受管源码路径；Workspace/受管 Extension 绑定规范化来源路径、输入 Schema Hash 和排序后的实现树 Hash。树 Hash 把相对路径、文件长度和正文共同计入，拒绝 symlink、非普通文件、空树、不可读或超限目录；导入 handler/包文件变化会改变 Descriptor。

同一目录的任何可执行 Tool 重复 `localName` 均失败关闭，包括 ResourceLoader 最终 Map 之前的原始 Extension 注册。重复 Capability ID 映射到不同 Descriptor 同样清空目录并产生 diagnostic。来源未知、工件不能证明、built-in 被覆盖或 Extension 加载失败时 Profile 显式不可用；不存在“最后写入者获胜”。

Scope 按 Descriptor 自己的 `scopePolicy` 解析：

- `global` 只能得到 `{kind: "global"}`；
- `workspace_required` 必须取得当前产品授权的 Workspace Root/Grant，缺失时没有 `resolvedRef`，创建 Run 或执行前失败；
- `provider_defined` 必须由 Provider 注册表提供精确 `{kind: "provider", providerRef}`。

首轮 `project_bootstrap` 尚无新项目 Workspace Grant，因此只启用受管 `project_bootstrap_prepare`，不把文件 Tool 伪装成 global。该 Tool 必须具有精确 inline SourceInfo、Chat 受管实现树和 provider scope；同名第三方 Extension 直接 diagnostic。它只准备 Candidate，仍由 Project Bootstrap 专用 Decision/Outbox/Dispatcher 执行实际 Plane/Workspace 写，不创建 Generic Tool Decision。

## 5. Run 全链冻结

新 Direct Run 的链路为：

`DSH Agent配置 qualified refs → AgentVersion/Temporary → RunSpec → Prompt Assembly v4 → Operation授权 → AgentSession Resolved Manifest → Journal/Activity/Trace`。

Version 保存时 Application 从当前 Runtime Catalog 重新计算有序 `enabledCapabilityRefs`；客户端若提交不一致引用会失败。Temporary 配置也必须携带同样的引用，Compiler 不得退化为裸 Tool 名。Prompt Assembly v4 保存每个 Capability 的 descriptor、implementation、input schema、scope、effect、approval 和 evidence 信息。

Application 接受 Tool Intent 时同时验证：Run/Attempt 活跃；`runtimeOperationRefSha256` 绑定 Run、Attempt 和 Attempt input manifest；该完整 Capability Snapshot 精确存在于唯一 v4 Assembly；Scope 符合自身政策及 Assembly Workspace。Runtime Manifest Hash与首次绑定都比较完整Snapshot而非仅ref，Descriptor Hash在目录解析时由Canonical Descriptor字段重算。只读 Run 不能自行发布 bash/write。历史裸名 Version/Run只读保留，不猜来源、不原地升级，也不能发布新 Tool Intent。

## 6. 高影响 Tool 耐久顺序

固定顺序是：

`Provider Tool Call → Product Intent → Product Decision → claim → handler 一次 → Journal Result → Product Result → Agent loop`。

`read` 等 `run_policy` 能力不制造人工 Decision；`local_write/shell/external_write` 必须取得绑定 Intent revision、Capability descriptor、参数 Hash、Scope 和 Principal 的一次性批准。claim 事务再次验证 Run/Attempt 仍活跃及 Operation 绑定未变化；Run 终结后旧批准不能执行。

Intent状态使用一张完整矩阵：reject只形成`rejected`；approve才可进入`approved→dispatching→completed/failed/outcome_unknown`。Run失败、取消或unknown时，waiting/approved原子转为`not_executed`，dispatching与Run共同转为`outcome_unknown`；终态Run存在活动Intent属于Store损坏。completed/failed必须精确引用唯一`pi_journal_result`。

拒绝在 handler 前返回 `tool.blocked`，Pi 将其作为 Tool error 交给 Agent，而不是伪造 handler 失败。等待、dispatching、outcome_unknown 任一 Intent 会阻止 Candidate、Run 和正式 Product Commit 成功。

### 6.1 崩溃点矩阵

| 崩溃点 | 耐久事实 | 恢复行为 |
| --- | --- | --- |
| Intent 前 | 无 Product Intent | handler 未执行，可重新产生新调用 |
| Intent 后、Decision 前后 | waiting/approved | 继续同一审核；不执行 handler |
| claim 前 | approved | 重新校验 Run/Attempt 后才可 claim |
| claim 响应未知 | 可能已消费 | Product/Operation `outcome_unknown`，不再次执行 |
| handler 前 | dispatching | 重启保守 unknown，不猜测执行 |
| handler 后、Journal 前 | 无可信 Result | Product 不得 completed；Tool/Operation/Product 收敛 unknown，handler 不重跑 |
| Journal 后、Product Result 前/响应丢失 | 完整 Journal Result | 使用同一确定性 Command 与 Intent ID 重放 Product Result/Receipt，不重新 claim/执行 |
| Product 已提交、响应丢失 | Product Receipt + Journal Result | 同一请求读取 Receipt；没有第二条 Result |
| Operation 已 failed 但有开放 Intent | 未闭合副作用 | Store 启动仍先收敛 Tool/Operation unknown，不能跳过 |
| 并发 approve/claim | 一个 Decision、一个 claim | 迟到者得到已决定/`already_claimed`，handler 至多一次 |
| Run 取消与旧许可交错 | Run/Attempt 终态 | claim 事务拒绝，handler 0 次 |

## 7. Planning Evidence

`structured-tool-result.v1` 是不可关闭的事实门。模型提交面只有`stepId/output`；Evidence Ref由`full-operation.v3`真实Journal的闭合Tool Result确定性派生。Application通过窄Evidence Verifier读取Runtime Snapshot/Event Receipt，重新运行完整Journal Validator后核对Attempt、qualified Capability ID、本地 Tool名、唯一toolCallId、输入Hash、结果Hash和outcome，不把Journal复制到Product Store。合同要求`shell_execute`时只有bash可满足；`workspace_write`只接受edit/write；read/grep/find/ls不能冒充写入或shell。

`strictEvidence=false` 只放宽成功标准和完成标准的文字逐条包含检查。没有合格结构化 Evidence 时，“测试已经通过”等文本仍然失败。Execution Candidate Hash 和 Product Store 复核都包含 `evidencePolicyVersion` 与 Evidence Refs；Product Commit还要求所有高影响 Product Tool Intent 已闭合。

## 8. 历史复检问题闭包

| 问题 | 根因 | 实现与反例 |
| --- | --- | --- |
| Product v19 碰撞 | 两条开发线复用版本号 | 严格任务 02 v19→v20；带 Tool 集合的歧义 v19 fixture 被拒绝 |
| Bridge v13 碰撞 | donor 忽略 main 后续状态 | 保留 main v15→v16；重启字节幂等 |
| RunSpec 丢 refs | Compiler 只复制 names | Compiler 冻结 `enabledCapabilityRefs`，Temporary 纵向测试逐项比较 |
| Intent 不属于 Manifest | 只验 Runtime 自洽 | 错 Operation、实现 Hash、Capability 和 Scope 均 0 Intent |
| Scope Policy 未执行 | 统一复制调用方 Scope | global/workspace/provider 分流；缺 Workspace/provider 反例失败 |
| Evidence 两个旁路 | 开关覆盖结构化门且未匹配 Capability | strict=false 缺 Evidence、read 冒充 shell 均失败 |
| 重启不收敛 Product unknown | 只写本地 Journal | 重启按确定性 Intent/Command提交 Product unknown；Result 已落盘则重放 Result |
| settlement 漏 tool_review | 等待态枚举不完整 | waiting_human/tool_review 作为合法等待边界测试 |
| 终态 Run 旧许可 | claim 未复核生命周期 | Run 终态后的 claim 返回 revision conflict |
| bootstrap 同名冒充 | 只比较 localName | 精确 SourceInfo + managed tree + provider scope；伪造 Extension diagnostic |
| Extension 只 Hash 入口 | 依赖闭包未冻结 | handler 文件变化导致 content/descriptor Hash 同时变化 |
| Faux E2E 继承凭据 | 子进程 spread `process.env` | 四服务显式白名单；Pi sentinel 检查 8 类凭据不可见 |
| Product Result 早于 Journal | Tool Result callback 顺序相反 | Journal close 返回真实事件 Hash，Product Result必须引用；Journal失败只报 unknown |
| 普通重复 localName/ID 被覆盖 | Map 最后写入 | 原始注册和最终目录双重碰撞检测，目录为空且 unavailable |

## 9. 真实非付费门

`pnpm test:e2e:dsh-capability-governance-real` 使用独立455xx端口和`.data/e2e/dsh-capability-governance-real`。DSH Host/Client、Chat Router/Application、Workflow、真实Pi AgentSession/bash handler全部为生产实现，只有模型Provider是进程内确定性Faux。

该门用append型调用日志证明批准handler恰好1次、拒绝handler为0次。Product Result已提交后，E2E Adapter故意悬停而不返回；Supervisor在该响应未知窗口真实SIGTERM并启动新Pi进程，Journal/Receipt恢复与再次重启都保持调用计数为1。环境sentinel证明Pi子进程看不到DashScope/OpenAI/Anthropic/Google/Gemini、GitHub、Plane和SSH凭据。

Run Activity不再使用全局“一次迁移完成”marker。每次进程启动扫描全部Operation/source sequence，依赖Activity Sink耐久`sourceKey`实现重复幂等、缺失sequence补投和同key不同payload失败关闭；投影失败不会重跑Provider或Tool。
