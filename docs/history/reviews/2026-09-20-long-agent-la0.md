# LA0 验收：Friend 独立工作、任务与群聊接缝

日期：2026-09-20。范围：用户授权的 LA0 合同及可执行可行性验证，不是 LA1–LA6 功能上线。采用 [chat-architecture Skill](../../../.chat/skills/chat-architecture/SKILL.md) 的场景→机制→模块合同→原生证据流程。

## 产物与架构判断

- [开发计划](../../development/long-agent-functionality-plan.md)记录 7 个阶段的场景、交付、验证、限制和 8 项自检。
- [机制 §9](../../modules/long-agents/chat-long-agent-mechanism-contract.md#9-la0交互任务与调度的实施合同)固定身份/任务/群、授权、调度所有者、取消、结果返回和 3+1 产出边界。
- [Session §11](../../modules/sessions/chat-session-architecture.md#11-la0独立工作与群聊的原生-session-合同)固定公共引用、独立参与上下文、工具/压缩/恢复及来源投影。
- [Workflow 接入](../../modules/workflows/chat-subworkflow-design.md#la0friend-执行绑定与后台返回目标)区分现有子 Workflow 与指定 Friend 后台执行。

结论：可以继续沿现有 Chat→Workflow/Long Agent→公共装配→Pi 架构实现，不需要第二套运行时。公共工厂具备独立并发能力，但现有 Friend 生命周期仍按每日 Session 和身份队列约束，必须在 LA1 改造真实入口。旧父 SessionManager 的异步返回风险已复现，尚未作为生产代码修复。

## 验证证据

新增 `test/long-agents/la0-session-seams.test.mjs` 的 6 项测试通过，使用真实公共工厂、Pi、文件和本地 HTTP 假模型：

| 场景 | 实际观察 | 能力边界 |
|---|---|---|
| 同 Friend 两条 Session | 两个请求同时到达模型屏障；各自仅收到 A/B 项目规则，重开历史无串线 | 公共工厂可行；不代表 Friend turns API 已开放 |
| 任意 Session 冒充每日会话 | 真实接受入口拒绝，未调用模型 | 现有保护必须保留，后续显式扩展绑定 |
| 私有日终交接 | 当前装配确实包含私有内容标记 | 群不能盲用；授权裁剪留在生产接入阶段 |
| 旧父写入器 | 新用户 Entry 仍在原始文件，但被新的 leaf 分支绕过 | 真实风险，不将测试通过解释成问题消失 |
| 锁内重开和重复完成 | 新输入保留在分支；模拟落盘后丢回执，再次完成只留一个收据 | 测试原型证明写法可行；不是完整任务恢复实现 |
| 公共消息引用 | 实际 read 工具执行、Pi 压缩、重开后仍能解析原 assistant Entry；公共根没有私有原文/工具材料或答案副本 | 引用可行；生产授权投影、成员撤权和流式发布仍待 LA5 |

Nano 接缝验证 **3 个文件、30 项通过**。这包括原生 A2A 路由、chat-pi 调度转发与执行驱动；原生测试中“无往返上限”的 BUG 用例也通过，意味着限制确实缺失，不表示自由讨论已经安全。Chat 群入口当前仍拒绝映射到私有日常会话，不能直接打开路由绕过授权。

完整 `pnpm verify` 在隔离源码及独立依赖副本中通过：44 项脚本、357 项后端（含新增 6 项）、170 项前端、30 项 Built Server、1 项 Nitro dev→Frontend Run 合同→Workflow→Pi→本地模型，共 **602 项测试**；严格类型、前后端/CLI 构建和架构导航同时通过。Nano 的 30 项另计。父仓库和 Frontend 的 `git diff --check` 通过，三个 Submodule 工作区保持干净。

测试日志保存在本地 `.data/verification/la0-2026-09-20/`，不提交运行数据。`source-version.json` 校对隔离副本与工作区 **2680 个源码/配置文件**，无差异；最终仅补录文档证据并复查导航。未部署、重启正式服务、提交或推送。

首次隔离副本将 node_modules 链接到原仓库，导致 Nitro Step bundle 的相对依赖路径错误；该次 verify 为 44 项脚本通过、后端 356/357，通过独立依赖副本修正验证环境后，Builder 两项专项重跑通过，再重新运行完整门禁。未因此修改产品构建代码。最终通过日志为 `verify-independent.log`，首次失败日志保留为 `verify.log`。

Nano 验证使用其现有测试，不修改 Submodule：

```bash
cd nanoclaw
./node_modules/.bin/vitest run src/modules/agent-to-agent/agent-route.test.ts src/modules/chat-integration/task-forwarder.test.ts src/modules/chat-integration/execution-driver.test.ts
```

## 自检与进入下一阶段的条件

| 检查 | 结论 |
|---|---|
| 是否只实现容易的部分 | LA0 约定产物是合同与接缝，覆盖独立执行、任务/调度、职责、笔记/动态、群聊和失败返回；后续阶段均有明确入口验收要求 |
| 是否改变底层架构 | 无运行时/生产 API/状态格式改动；使用既有工厂、Pi Session 和 Session 操作锁 |
| 是否假称群聊安全 | 没有。现有私有交接已作为风险举证；成员 ACL、资源裁剪、撤权和公开投影是 LA5 上线门槛 |
| 是否漏掉主聊/后台冲突 | 已复现旧 manager 风险，LA1 必须修复真实 settle 路径、身份队列和每日绑定，而非仅新增文件 |
| 是否丢失原生能力 | 原生工具消息、压缩和 Entry 重开已验；前端仍需后续真实入口验证，不能由此推断群聊 UI 完成 |
| 是否遗漏长期任务 | 职责与具体任务、时间/事件触发、Occurrence/attempt、实际产物和投递分开；三项学习与 3+1 作为最终贯通验收 |
| 是否虚报真实模型/浏览器 | 本阶段未运行外部真实模型、浏览器群聊或真实渠道收发；没有新增这些产品入口，本地模型只验证机制，不验证自主学习/讨论质量 |
| 是否偏离最终目标 | 每日唯一约束限定为直接交流，任务/群不受其限制；同身份可多上下文，任务成果和消息均可追溯 |

LA0 按本阶段范围完成，具备进入 LA1 的条件。LA1 开工输入已明确：扩展真实会话选择/队列与工作身份绑定；修复父结果写回；保持每日直接交流和现有 Workflow 行为；提供真实用户可用的后台工作/状态/取消/返回入口并做真实模型、浏览器验收。LA0 不能作为绕过这些工作的理由。
