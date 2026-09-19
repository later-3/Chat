# P2 公共装配交付与自检

日期：2026-09-19。状态：P2 工程交付、自检修复和完整门禁完成，待用户验收。无提交、推送或部署；未修改 Pi/Nano 运行时。任务范围来自[开发计划 P2](../../development/agent-unification-plan.md#p2公共装配与本轮上下文)。

## 1. 交付核对

| P2 承诺 | 实现与可观察结果 |
|---|---|
| 公共定义、存储、协作输入 | `src/agents/pi-agent-session.ts` 唯一工厂；`assembly-context.ts` 分离 storageProjectId/ownWorkspace/projectId/cwd。Friend 执行与 inspection 共用 `long-agents/assembly.ts` |
| 规则正文及版本冻结 | 精确根候选优先级沿用原 loader；Personal、自身、当前项目分区；真实路径去重；缺失允许，目录/失效符号链接/非法 UTF-8/超预算失败。原生 CustomEntry 保存正文与校验和 |
| A/B/null 与身份稳定 | 同一 Session 文件和 ID，下一轮替换工作上下文；历史保留，隐藏 CustomMessage 标注历史项目；模型来自身份定义/Personal，不受浏览项目模型设置影响 |
| 工具、Memory、资源一致 | 原生文件工具按本轮 cwd 执行；Friend 受管文件校验路径；默认 Project Memory 使用协作目标，来源仍为存储 Session；null 不暗写 Home Project Memory |
| 自有能力与策略 | inherit 发现自身和当前项目资源；explicit 不额外开启自身资源。选中 Skill 正文按快照读取；资源变更不能静默恢复旧轮次，工具默认项变更同样拒绝旧轮次恢复 |
| 检查与执行同源 | Long Agent HTTP inspection 与 messages 调用公共装配，假模型捕获的 System Prompt 与检查结果逐字相等；检查显示资源的工作项目归属 |
| 普通路径兼容 | Workflow wrapper、Tool 注册和 explicit 策略保留；普通 Workflow 也冻结规则/Skill。跨项目 workflow_call 子会话属于工作项目，父关系仍指 Home Session；读模型/前端兼容端点 projectId |

架构事实源为 [Context §15](../../architecture/chat-context-resource-model.md#15-公共-agent-装配合同p12026-09-19)、[Session §10](../../modules/sessions/chat-session-architecture.md#10-friend-每日-session-与本轮项目p1待实施)、[配置](../../configuration/README.md)。本记录只保存交付证据，不复制完整合同。

## 2. 场景与证据

| 场景 | 自动化证据 | 边界 |
|---|---|---|
| S01 A → B | `test/agents/public-assembly.test.mjs`：真实公共工厂、HTTP 假模型、原生 write 实际落盘；HTTP 检查/发送逐字比对 | 证明指定同一 Session 的本轮行为；跨入口每日唯一索引属 P3 |
| S02 无项目 | cwd 为自身 Workspace，不加载上次项目；Project Memory 默认写入拒绝，workflow_call 要求明确项目 | Personal/Agent Memory 继续各自作用域 |
| S03 失败/越界 | 失效项目、根规则为目录/坏编码/失效或越界链接、父路径和写路径链接；过长必需区域在模型请求前失败 | shell/扩展是可信宿主能力，cwd 不等于沙箱 |
| S04 在途修改 | 已装配规则/Skill 返回旧正文；同 turn 重装配保留规则，资源变更失败，新 turn 读取新内容；工具集合也冻结 | 耐久接受前移、排队、撤权再校验属 P3 |
| S10 普通 Session | Workflow 规则/Skill、显式工具、同 Session Pi 原生压缩；Frontend 合同、开发和生产 Run 门禁 | 未进行人工 VSCode F5 或真实 Telegram 验收 |

新增公共工厂测试使用临时 Chat Home、本地假模型和真实文件操作。Memory 测试使用真实 Catalog 与隔离索引适配，避免外部 embedding 请求；父子 Session 验证原生 parentSession，Tool 测试验证工作目标/父存储分离。原生接缝实验继续保留，但不代替 Chat 工厂或 HTTP 路由证据。

## 3. 自检发现与修复

1. 检查页原本经过 Workflow Resolver、资源归属使用存储项目：改为 Friend 共用准备入口和工作项目归属，HTTP 对照回归覆盖。
2. 普通 Workflow 只依赖文件现读：公共入口补规则与资源冻结，原生 read 返回选定 Skill 的本轮正文。
3. Friend 原生相对 cwd 不构成边界：补原生文件工具真实路径检查；普通图像读取保留 Pi 原生行为，不扩大为 shell 沙箱承诺。
4. Memory 与 workflow_call 原先默认绑定存储项目：分离工作目标与来源；跨项目子会话显式验证父存储归属，前端读模型同步。
5. 身份/职责被静默截断、系统区域没有预算检查：必需区域改为明确失败，可选 Memory index 仍保留省略提示。压缩回归用足够容纳系统输入的模型窗口和长历史，断言真实压缩 Entry。
6. 入口文件 hash 不足以证明扩展依赖版本：旧轮次重建含可执行扩展时明确中止，不能重新导入最新依赖假装恢复。运行中的扩展保留实例；新轮次正常装配。
7. 严格扩展诊断暴露空目录被 Pi 当模块加载：可选约定目录为空时不作为显式扩展传入；显式错误仍报告。无模型的检查预览跳过未知窗口预算，实际执行认证要求不变。
8. Personal 默认工具变化可能改变恢复能力：保存实际工具 Schema/资源版本并比较，发生变化拒绝旧轮次恢复。

## 4. 验证记录

最终 `pnpm verify` 退出码 0，全部 550 项测试通过：

| 门禁 | 最终结果 |
|---|---|
| 启停/安装/调试 Tooling | 34/34 |
| Backend | 322/322；含 11 项公共工厂测试、Long Agent 检查/发送 HTTP 对照、Workflow 委派与压缩 |
| Frontend | 163/163；含显式 null 上下文与跨项目调用端点解析 |
| 生产 Runtime | 30/30；真实 Workflow、Pi 和假模型，项目工具实际执行 |
| 开发 Runtime | 1/1；Frontend Run 合同 → Nitro → Workflow → Pi SDK → 本地假模型 |
| 类型/构建 | Backend、CLI、Frontend typecheck；Frontend/Backend/CLI 生产构建通过 |
| 架构与差异 | architecture 导航 102 入口/766 链接通过；根仓库和 Frontend `diff --check` 通过 |

Backend 门禁同时通过 Builder JSON import 单层转换与 Nitro 开发 Step bundle 的 Node 装载。最终源代码与隔离副本 `rsync -rnc` 比对无差异；之后仅回填文档结果并重跑文档与差异检查。原生接缝、公共工厂、HTTP 路由、开发/生产 Runtime 分别有证据，没有用相邻链路替代。

第一次完整 verify 通过后仍继续自检；补充冻结/预算保护后发现兼容问题，修复后相关 40 项回归及最终完整 verify 均通过。此处统计为最终版本结果。

完整验证在 `/tmp/chat-p2-verify.V2ET3T` 的源码副本运行，依赖使用本机副本，排除私有 `.env/.data/.chat/config.json`。避免改写正在服务的原仓库 `.output`；未重启或部署用户环境。最终复验包含 `pnpm verify` 的 architecture、tooling、Backend/Frontend、typecheck、生产 build、built Runtime 和 test:dev；原仓库另做 architecture 与两仓 diff 检查。

## 5. 阶段完整性结论

P2 五项交付均有实现与对应测试；发现的本阶段缺口已在本阶段修复，没有移交 P3 掩盖。最终门禁已通过，阶段标记为完成。

最终目标保持：单公共 Pi Runtime、Friend 身份稳定、项目仅为本轮工作上下文、原生 Session 为事实源。仍未完成的均属原计划后续阶段：P3 的统一每日定位/接受队列/跨日总结/故障补偿，P4 的共用实时聊天消费与操作，P5 的旧数据迁移和授权外部渠道实测。未将当前 HTTP 等待整轮或已有按项目绑定误写为统一每日生命周期已完成。

本阶段新增可观察限制：规则过长会报告来源与预算；旧任务所用资源/工具版本变化会停止恢复；带可执行扩展的旧轮次不能自动重放。需要严格进程沙箱仍须后续受控执行环境。下一阶段按计划进入 P3，不额外扩展群聊、朋友圈或 Docker 功能。
