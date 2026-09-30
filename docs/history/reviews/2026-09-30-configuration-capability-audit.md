# 配置、能力认知与记忆闭环排查

状态：本轮排查与关键修复已完成，验证通过；3 项后续工作见末节。未提交、推送或部署。范围为 Long Agent 设置、Workflow Agent 配置、模型配置，以及配置到公共 Pi 装配、模型可见工具结果、持久 Memory 的完整链路。正式服务只读检查；源码验证使用隔离 CHAT_HOME，不改正式身份、记忆或认证。

## 场景与机制

用户选择助手或 Workflow Agent，理解能力及作用范围，编辑后在下一轮使用；助手能区分自己的 Markdown 记忆、共享事实、当前会话记忆及每日归档，按真实工具完成读改写。关键边界是未授权工具、网关离线、旧身份说明、revision 冲突、切换对象与未保存编辑。

属于 K1 能力装配、K3 连续性、K6 反馈，采用 E2/E3 修复已有合同。NanoClaw 继续拥有 Group Markdown Memory，Chat Catalog 拥有 Personal/Project Memory，Pi 拥有消息；不增加存储或运行时，不扩张工具权限。依据：配置 README、模块合同、Long Agent 能力模型及工程基线、Memory README、Frontend UI/UX §17–20。

## 问题与修复

| 问题 | 证据与影响 | 修复/验证方向 |
|---|---|---|
| Agent Memory 读改写合同不完整 | agent_memory_read 仅将正文放入 content，revision 只在 details；模型不能可靠取得写入必需版本。已有测试只断言正文与新建，未覆盖读取后更新 | 返回模型可见的路径、revision、正文；经真实 Pi 假模型完成读取→更新→冲突 |
| Nano 原生说明与 Chat 运行环境错位 | 核心 Markdown 的说明沿用原生容器路径、rg/find；chat-pi 只允许通过窄接口访问 Agent Memory | 装配明确当前入口及能力事实优先级，工具说明包含方法；保留用户原文，不自动重写身份/记忆 |
| 自我管理知识不完整 | long-agent-management 已发布，但描述仅生命周期，未解释不同 Memory 作用域；若资源 explicit 未选则不存在 | 公共可信身份给出边界；实际激活工具通过 Pi 原生 promptGuidelines 提供说明；管理 Skill 补足导航，尊重 explicit |
| 正式身份有旧能力描述 | 只读检查发现仍有“Web 尚未上线”的旧职责说明；不能将其视为现行平台事实 | 运行能力以本轮注册工具为准；记录配置漂移，不把目标文档写成已部署能力 |
| 模型编辑器内部仍套旧弹窗 | 当前截图：双层表面、模型长名称跨越导航边界遮挡表单；仍携带旧 dialog 尺寸与 first-child 覆盖样式 | 只保留 SurfaceDialog 外壳，内层用有界列表/详情；宽窄屏、长名和键盘验证 |
| 模型能力信息断层 | 图片开关实际上已存在于单模型详情；Friend/Workflow 选择只展示模型与思考；模型级 baseUrl/samplingParams 等 Pi 已支持字段未可编辑 | 从同一 /api/models 显示输入能力和规格；补模型编辑入口、严格响应解析及保存回读 |
| Workflow 配置仍用独立 dialog/按钮 | 原生 dialog 与其他 SurfaceDialog 分叉；首屏混杂模型、完整工具列表与资源；保存作用范围容易混淆 | 复用公共弹窗/按钮，模型与高级工具资源分组，明确项目持久配置和会话覆盖 |
| 配置检查与编辑会漂移 | Friend 保存后不刷新 inspection；资源目录/inspection 使用默认渠道项目，不等于当前无项目的运行；Workflow 切 Agent 时保留旧 inspection 直到异步完成 | 同目标请求代次、保存后重读、明确预览范围；回归快速切换/失败和草稿保留 |
| 页面包含未接入的后台操作 | 模型页调用待迁移的 catalog/discover/test 与 auth 接口，按钮可点且授权目录错误被吞掉 | Backend 下发 operations 能力，Frontend 禁用未接入动作并说明手动配置仍可用；浏览器断言没有请求缺失接口 |
| 渠道项目配置与统一目标有差距 | bridge 新绑定和旧 schedule 仍使用 defaultProjectId，存量绑定保留 contextProjectId；设置页对应当前实现，却不满足新目标 | 记录为 P1 后续迁移，须覆盖新旧绑定、排队/已受理轮次及任务归属；不能只删字段改变前端外观 |
| 文档和测试存在缺口 | 部分入口仍声称管理 Skill 未发布、旧创建入口存在；Memory 测试没有模型实际可见版本验证 | 更新当前合同与经验资源，区分源码/部署/假模型/真实模型证据 |

正式只读样本：Nexus inspection 返回 3 个已激活 Agent Memory Tool、无装配诊断；Agent Memory list 返回 10 个文件。因此不能把“Agent 不会使用”归因为 Nano Memory 完全未接入，也不能由列表成功推断更新闭环成功。截图留在忽略目录 `.data/verification/capability-audit-2026-09-30/`，不提交真实用户内容。

## 整体架构与模块内部结论

整体链路应是：Frontend 编辑 → Backend 校验与持久化 → 同源解析检查 → 公共 Pi 装配 → 模型收到工具说明和结果 → 领域服务落盘及回执。此次问题分布在五个接缝：UI 暗示了不存在的 API、检查作用域与运行不同、身份文案覆盖能力事实、工具输出遗漏后续动作所需输入、测试只证明函数返回。继续保留 Nano 的长期身份/Markdown Memory 与窄网关，不在 Chat 复制记忆库、另起 Agent Loop 或赋予额外权限。

模块内部：Frontend 统一 SurfaceDialog、Button、信息分组和请求失效处理；模型服务保留 Pi 的原生字段与严格响应解析；Agent 装配同时兼容 Pi 默认和替换 System Prompt；Memory 工具的使用方法进入实际 description，版本令牌进入模型 content；测试从字段断言推进到真实 Pi 和构建后的浏览器闭环。

## 同类问题扩展核对

- `session_memory`、`task_manage`、`duty_manage`、`summary_manage`、`long_agent_manage` 的结果序列化：均把结构化领域结果放入模型 content，未发现本次 Agent Memory read 那种仅将关键版本藏在 details 的相同缺陷；不能由此推断所有业务组合已测。
- 普通 Pi prompt 与替换 System Prompt：后者不会自动使用默认工具指南，因此说明同时进入实际 Tool description；回归检查模型收到的请求，而非只检查服务端工具注册对象。
- 本地假模型门禁：处理函数断言不能只转成 HTTP 500，否则 Pi 记录错误后返回可能造成假通过；已补收集/抛出处理函数错误及最终正常 assistant 回复断言，公共装配 13 项独立复跑通过。
- 权限预览：区分 registered 与 active；撤销写入能力后重读并核对实际装配。Memory 能力文案不提供工具，也不突破 none/explicit 或群作用域。
- Frontend 迁移残留：不止修复一个按钮；发现同一模型页面的发现、补全、测试与授权四类操作都未有 Backend 实现，统一通过服务端 capability 控制。
- 配置窗口：不仅检查桌面截图和页面无溢出，还检查手机标题实际宽度/头部高度、长名称、暗色、键盘切换和草稿保护。公共 SurfaceDialog 头部改为窄屏操作分行，所有共用窗口受益。

## 实施与验收计划

1. 修复 Memory 模型可见合同及能力说明，以同一 Pi 装配验证普通/explicit/受限群作用域。
2. 修复模型字段与选择能力投影，保留未知兼容字段；模型规格声明不等于供应商在线能力实测。
3. 收敛三个配置表面与保存/切换/检查状态，保留各领域独立 revision 和保存入口。
4. 领域/HTTP 合同、前端解析、真实 Pi 读改写、浏览器表单及响应式验收；隔离副本运行 pnpm verify、diff checks。真实供应商与外部渠道不属于默认回归。

## 结果

已实现的主要变更：

- 模型结果包含输入能力；模型选择显示图片、上下文和输出上限。编辑器补齐模型 baseUrl/samplingParams/compat、Provider name/authHeader/compat；非法 JSON 阻止保存，保留未编辑字段。
- 模型页、Workflow 配置与 Friend 设置复用公共弹窗和按钮；手机头部将标题与操作分行，长名称不遮挡表单，高级工具/资源分组，Workflow 支持键盘切换；Friend 刷新前保护草稿，保存后重新检查，工具预览仅列 active 项。
- Agent Memory read 支持无 path 列目录，返回可供模型读取的路径、正文与 revision；更新沿用 CAS，冲突不覆盖。工具说明及可信装配提示区分私有 Memory、共享事实、Session 要点与每日归档。
- 更新能力文档、失效的实施状态与经验 Prompt 资源；经验为可选资源，不全局强制注入。

验证在隔离源码副本和 CHAT_HOME 执行，正式 43110 服务的 `.output` 和前端产物保持原样。

| 门禁 | 本轮结果 | 证据 |
|---|---|---|
| Tooling | 58 通过 | `verify-final-mobile.log` |
| Backend | 687 通过 | 同上 |
| Frontend | 271 通过 | 同上 |
| 类型检查、Builder/Nitro 生产构建、架构检查 | 通过 | 同上 |
| 构建后 HTTP / 浏览器 | 31 通过 | 同上，含新增配置场景 |
| Runtime | 11 通过，1 付费真实模型测试按显式环境变量门禁跳过 | `verify-final-mobile.log`；包括 Nitro、HTTP、浏览器、进程重启及 Workflow 切换 |
| 公共 Pi 装配补强复跑 | 13 通过 | `pi-memory-final.log`；模型处理函数断言和正常终态均受校验 |
| NanoClaw 原生资源 / Gateway / chat-pi 初始化 | 3 文件、13 测试通过 | `nanoclaw-memory.log` |
| Git diff 检查 | 根仓库和 Frontend 通过 | `git diff --check`、`git -C frontend diff --check` |

`pnpm verify` 最终 exit=0，总计 1,058 通过、1 跳过；新增门禁包含在对应套件内，不把复跑数量累计成新增覆盖。最终产品源码的全量通过后，公共装配测试夹具另行补强并独立复跑 13/13，见上表。

日志和截图均位于 `.data/verification/capability-audit-2026-09-30/`。配置浏览器覆盖 1440/768/390 宽度、明暗、无横向溢出、手机标题有效宽度、键盘导航、读写回读、非法 JSON、草稿保护和撤销写工具后的有效预览。人工浏览器复核 Friend 设置与 Memory 列表；正式环境只做读取。

### 剩余边界与整改顺序

1. **P1：项目合同迁移。** 新 IM/旧 schedule 兼容路径仍有 defaultProjectId；需以绑定和已受理轮次为迁移单位完成独立闭环验收。本轮仅纠正设置检查/资源目录的 Home 范围，不声称入口合同已统一。
2. **P1：模型页缺失 API。** 自动发现、资料补全、连接测试和授权管理仍未实现。本轮修复虚假入口，手动配置正常；后续依 api-migration 合同接入，验证后才能将 operations 标为 true。
3. **P2：存量身份漂移。** 正式助手仍有旧能力状态与原生路径说明；本轮提供可信运行合同及工具用法，不擅自改写用户身份/Markdown。后续应逐 Agent 检查来源、提出具体修订，再沿既有 revision 保存。
4. 模型图片能力为目录声明；本轮没有付费真实供应商请求或正式 Memory 写入。真实 Pi + 本地模型证明工具接缝，Nano 原生 13 项证明该窄合同的文件处理；两者不是正式生产整链路写入验收。
5. 全量浏览器覆盖当前三种配置表面，未穷举每种模型 API、每个 Plugin/Extension 和所有配置组合；不可把本次修复概括为整个项目已无缺陷。
