# Workflow 开发链没有真正走到 Pi SDK

## 现象与影响

2026-08-31 至 2026-09-01，`minimal-pi-coding-agent` Run 被后端接受后，页面长期显示“正在等待模型”。用户 Prompt 没有进入 Pi Session，Workflow 本地队列对同一消息持续返回 HTTP 500；2026-09-01 的复现中至少观察到 117 次重试。

## 直接根因

Workflow 与 Agent 入口使用合法的 Node ESM JSON 导入：

```ts
import config from "./agent.json" with { type: "json" };
```

故障跨越两层构建链：

1. `@workflow/builders` 4.1.10 先通过 SWC 转换模块。未启用 `keepImportAssertions` 时，单层转换会丢失 import attribute。
2. `nitro dev` 使用 `LocalBuilder(dev=true)` 生成可直接从磁盘加载的 `node_modules/.nitro/workflow/steps.mjs`。开发模式会外置非 Step 模块，原实现虽然继续打包 Step 可达的本地 TypeScript，却没有把这些模块引用的本地 JSON 纳入 bundle；最终 5 份 `agent.json` 都成了裸外部 import：

```ts
import config from "./agent.json";
```

Node 在 Workflow/Step 模块装载阶段抛出 `ERR_IMPORT_ATTRIBUTE_MISSING`。错误发生在 `createWorkflowAgentSession()` 和 Pi Agent 启动之前，与 Pi Agent 的模型调用无关。

生产模式还有后续 Nitro/Rolldown 构建，会把 JSON 内联到最终 `.output`，因此生产构建和生产 Built Server Runtime smoke test 可以通过，而开发 Step 产物仍然失败。

修复 JSON 后，真实 `nitro dev` Run 又暴露了下一层问题：日志已经出现`[pi] step starting`和`creating AgentSession`，但`createWorkflowAgentSession()`读取被错误建模成全局运行时资源的`chat-architecture/SKILL.md`失败。开发 Step bundle 中的`nitro/storage`是stub，Pi AgentSession和模型仍未真正启动。

这里包含两个不同问题：`chat-architecture`本来就是Chat Project的`.chat/skills`资源，不应打包、物化或全局注入；真正由Workflow实现拥有的`memory`和`rule-library`私有Skill，才由Backend控制面在接受Workflow前准备到运行目录，Workflow Step不依赖Nitro宿主资源API。

## 为什么原验证没有发现

第一次修复后，`pnpm verify`已经覆盖单元测试、前端合同、类型检查、生产构建、Builder 单层 SWC 输出和生产 Built Server 的真实 Workflow Run，但漏掉`LocalBuilder(dev=true)`产物。第二次只补了完整开发`steps.mjs`生成与Node import，仍没有通过`POST /runs`真正执行Agent装配，所以又漏掉了内置Skill资源。两次都证明：验证相邻层不等于打通用户实际链路。

## 正确姿势

1. 分别验证源码、Builder 单层转换、完整开发 Step bundle、生产 bundle 和真实 Runtime；任何一层通过都不能代替下一层。
2. SWC 转换显式保留 JSON import attribute；开发模式直接加载的 Step bundle 还要内联可达的本地 JSON 配置，不依赖 Node 加载源码目录里的原始 JSON。
3. Project Skill通过标准`.chat/skills`目录发现；Backend初始化只准备Workflow私有构建资源，Workflow Step只消费已经准备好的私有资源。
4. 回归测试调用项目实际解析到的`LocalBuilder(dev=true)`，检查完整`steps.mjs`中没有Agent JSON外部import，并让Node实际import该产物。
5. 还必须启动真实Nitro dev，通过Frontend使用的`POST /runs`合同提交请求，确认Agent节点、Pi SDK、本地假模型和Run终态全部成功。
6. 模块装载与队列错误必须进入`failed`或`cancelled`，不能让Run长期保持`running`。
7. 一个Workflow的装载失败不应悄悄表现为“等待模型”，前端必须得到明确错误。

## 自动化门禁

- 后端测试直接调用项目实际解析到的 `@workflow/builders`，断言转换结果保留 `with { type: "json" }`。
- 后端测试调用 Nitro `LocalBuilder(dev=true)` 构建真实开发 Step bundle，断言 5 份 Agent JSON 已内联，并让 Node 实际加载生成的 `steps.mjs`。
- Built Server 测试启动生产 `.output`，提交使用本地假模型的真实 Workflow Run 并等待 `completed`。
- `pnpm test:dev`使用隔离Nitro buildDir、Chat Home、Project和本地假模型启动真实`nitro dev`，通过`POST /runs`验证`Frontend合同 → Workflow → Agent节点 → Pi SDK → 模型 → completed`。
- Backend初始化测试断言2个Workflow私有Skill在Workflow执行前已经准备好，并断言`chat-architecture`不会出现在运行目录。
- Prompt 资源测试断言本案例作为 Personal `experience` 自动归档且只初始化一次。
- 内置案例升级只在磁盘历史仍与产品版本前缀完全一致时追加；用户修改或归档过的资源不会被覆盖。
- Agent 执行测试选择本案例，断言内容进入 `<chat_agent_custom_instructions>`。
