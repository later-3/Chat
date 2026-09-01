import type { PromptResourceDocument } from "./types.js";

export const WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID = "workflow-runtime-artifact-validation";

const WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_V1 = [
  "开发经验案例：Workflow Builder 丢失 JSON import attribute",
  "",
  "适用场景：修改 src/workflows、Workflow/Step 可达模块、Workflow SDK、Builder patch、Agent 配置装载或运行状态处理时。",
  "",
  "已发生现象：源码使用 `with { type: \"json\" }` 正确导入 agent.json，但 @workflow/builders 的 SWC 转换产物删除了 import attribute。Node 在 Workflow Runtime 装载 Step 前抛出 ERR_IMPORT_ATTRIBUTE_MISSING；前端只看到‘正在等待模型’，本地队列重试耗尽后 Run 仍未进入失败终态。",
  "",
  "正确姿势：",
  "1. 不把源码可导入、TypeScript通过或构建成功等同于 Workflow Runtime 可执行。",
  "2. Workflow/Step 可达模块使用特殊语法或非代码资源时，必须检查实际 Builder 转换产物。",
  "3. 修改 Workflow 执行链后，必须运行真实本地 Runtime smoke test，确认产生 stage_start 并最终进入 completed、failed 或 cancelled。",
  "4. 队列、模块装载或 Agent 创建失败必须向 Run 和前端传播明确失败；禁止长期停留在 running/waiting 状态。",
  "5. 每个线上或开发故障都要补回归测试；只有文档记录、没有机器门禁，不能视为完成复盘。",
  "",
  "本案例的机器门禁：@workflow/builders 转换必须保留 import attribute；内置经验必须可被前端发现、勾选，并通过 Agent 统一装配进入 chat_agent_custom_instructions 区域。",
].join("\n");

const WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_V2 = [
  "开发经验案例：Workflow 开发产物外置 Agent JSON，导致 Run 永久等待",
  "",
  "适用场景：修改 src/workflows、Workflow/Step 可达模块、Workflow SDK、Builder patch、Agent 配置装载、开发启动链或运行状态处理时。",
  "",
  "已发生现象：源码中的 agent.json 导入合法，生产构建与生产 Runtime smoke test也通过，但 `nitro dev` 生成的 `node_modules/.nitro/workflow/steps.mjs` 把 5 份本地 Agent JSON 留成了不带 attribute 的外部 import。Node 在 Step 装载、Pi Agent创建之前抛出 ERR_IMPORT_ATTRIBUTE_MISSING；前端长期显示‘正在等待模型’，同一队列消息持续 HTTP 500 重试。",
  "",
  "直接根因：开发模式的 Workflow Builder 会外置非 Step 模块，并直接从磁盘加载 Step bundle。它已经打包 Step 可达的本地 TypeScript，却没有把这些模块继续引用的本地 JSON 纳入 bundle；生产模式还有后续 Nitro/Rolldown 构建，会把 JSON 内联，所以只测生产产物无法发现开发链故障。SWC层也必须保留 import attribute，作为仍需外置 JSON 时的语法保障。",
  "",
  "正确姿势：",
  "1. 分别验证源码、Builder单层转换、完整开发 Step bundle、生产 bundle和真实 Runtime；任何一层通过都不能代替下一层。",
  "2. 开发模式直接加载的 Step产物必须自包含所有可达本地代码和 JSON配置，不依赖Node去装载源码目录中的原始JSON。",
  "3. 测试必须调用实际解析到的 Nitro LocalBuilder(dev=true)，检查完整steps.mjs中没有Agent JSON外部import，并让Node实际import该产物。",
  "4. 修改Workflow执行链后，仍要运行真实本地Runtime smoke test，确认产生stage_start并最终进入completed、failed或cancelled。",
  "5. 队列、模块装载或Agent创建失败必须向Run和前端传播明确失败；禁止长期停留在running/waiting状态。",
  "6. 每个故障都要补可复现的机器门禁；只测更容易通过的相邻链路不算完成复盘。",
  "",
  "本案例的机器门禁：SWC保留import attribute；Nitro开发Step bundle内联5份Agent JSON并可被Node装载；生产Built Server提交真实Workflow Run；案例自动归档、可在前端勾选，并进入chat_agent_custom_instructions区域。",
].join("\n");

const WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_V3 = [
  "开发经验案例：开发模式必须打通 Frontend Run 到 Pi SDK 的完整链路",
  "",
  "适用场景：修改 Workflow 构建、Agent 装配、内置 Skill/Tool/Prompt 资源、Backend 初始化或开发启动链时。",
  "",
  "第二次暴露的问题：Agent JSON修复后，Frontend请求已经进入Workflow，Agent节点也开始执行并调用createWorkflowAgentSession，但Step在读取被错误建模成全局运行时资源的chat-architecture/SKILL.md时失败，Pi AgentSession和模型仍未真正运行。Nitro dev直接加载Workflow Step bundle，其中的nitro/storage是stub。",
  "",
  "正确职责：chat-architecture属于Chat Project的.chat/skills资源，只通过标准Project资源路径发现，不打包、不物化、不全局注入。memory和rule-library属于Workflow实现的私有Skill；Backend控制面在接受Workflow前准备它们，Workflow Step不依赖Nitro宿主资源API。",
  "",
  "端到端完成标准：启动真实Nitro dev和隔离Chat Home，使用本地零成本假模型，通过Frontend使用的POST /runs合同提交请求；必须依次观察Workflow accepted、Agent节点启动、Pi AgentSession创建、模型选择，并由GET /runs/:id确认completed和确定结果。只检查Builder产物、只测生产Server或只看到HTTP 202都不能声称修复完成。",
  "",
  "本案例的机器门禁：pnpm verify固定运行test:dev；测试使用独立Nitro buildDir、Chat Home、Project和本地假模型，不访问正式模型、不污染用户数据，也不与正在运行的开发服务共享构建产物。",
].join("\n");

/**
 * Product-owned experiences are seeded into the Personal Prompt resource store.
 * After seeding they use the same versioned storage, discovery and Agent selection
 * path as user-created rules and experiences.
 */
export const BUILT_IN_PERSONAL_PROMPT_RESOURCES = [
  {
    schemaVersion: 1,
    id: WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID,
    revisions: [{
      schemaVersion: 1,
      id: WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID,
      revision: 1,
      kind: "experience",
      title: "Workflow 构建产物必须经过真实 Runtime 验证",
      purpose: "避免源码、类型检查和构建通过，但 Workflow 转换产物在实际运行时装载失败。",
      content: WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_V1,
      tags: ["development", "incident", "workflow", "runtime", "build-toolchain"],
      status: "active",
      sources: [{
        type: "manual",
        entryIds: [],
        context: "归档于 docs/development-experiences/workflow-builder-json-import-attribute.md；源自 2026-08-31 的本地 Workflow Runtime 故障复盘。",
        capturedAt: "2026-08-31T14:45:09.006Z",
      }],
      author: { type: "user" },
      createdAt: "2026-08-31T14:45:09.006Z",
    }, {
      schemaVersion: 1,
      id: WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID,
      revision: 2,
      kind: "experience",
      title: "Workflow 构建产物必须经过真实 Runtime 验证",
      purpose: "避免生产构建通过，但 Nitro 开发 Step 产物在实际运行时装载失败。",
      content: WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_V2,
      tags: ["development", "incident", "workflow", "runtime", "build-toolchain"],
      status: "active",
      sources: [{
        type: "manual",
        entryIds: [],
        context: "归档于 docs/development-experiences/workflow-builder-json-import-attribute.md；2026-09-01 根据 Nitro dev 实际产物补全根因与开发链门禁。",
        capturedAt: "2026-08-31T23:15:00.000Z",
      }],
      author: { type: "user" },
      createdAt: "2026-08-31T23:15:00.000Z",
    }, {
      schemaVersion: 1,
      id: WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_ID,
      revision: 3,
      kind: "experience",
      title: "Workflow 构建产物必须经过真实 Runtime 验证",
      purpose: "要求开发链从 Frontend Run 合同一直验证到 Pi SDK 和确定的本地模型结果。",
      content: WORKFLOW_RUNTIME_VALIDATION_EXPERIENCE_V3,
      tags: ["development", "incident", "workflow", "runtime", "build-toolchain", "e2e"],
      status: "active",
      sources: [{
        type: "manual",
        entryIds: [],
        context: "归档于 docs/development-experiences/workflow-builder-json-import-attribute.md；2026-09-01 根据 Nitro dev Skill资源故障补充完整开发端到端门禁。",
        capturedAt: "2026-08-31T23:44:00.000Z",
      }],
      author: { type: "user" },
      createdAt: "2026-08-31T23:44:00.000Z",
    }],
  },
] as const satisfies readonly PromptResourceDocument[];
