# Vercel Workflow 机制详解

本文以 Chat 项目真实代码为唯一依据,解释 Vercel Workflow 本地运行时(`@workflow/world-local@4.2.4`)的内部机制。读者假定会一点 C++、刚开始接触 TypeScript / Node.js;涉及编译、链接的概念用 C++ 工具链(`.o`、`ld`、静态库 / 动态库)来类比,不依赖操作系统内核背景。

一句话定位:Vercel Workflow 是一个**进程内的耐久编排运行时**,你可以把它理解成一个"能自动存档、崩溃后能读档继续、能在指定点暂停等人指令"的工作流执行器。它在 Chat 里以独立进程运行(HTTP 端口 `43112`,Inspector 端口 `43121`),用预编译的 bundle 执行 workflow 函数,在每个耐久 step 边界落盘 checkpoint,进程崩溃后重启可从最近 checkpoint 重放并恢复执行。

---

## 1. "use workflow" / "use step" 编译器指令

### 1.1 它们是什么

`"use workflow"` 与 `"use step"` 是写在函数体第一行的**字符串字面量指令**,语法形式与 JavaScript 的 `"use strict"` 完全一致——一条语句、一个字符串,运行时被解释器当作无副作用表达式丢弃,但**构建期的转换器会识别它**。

主工作流函数的指令见 [planning-execution-workflow.ts:92-95](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L95):

```typescript
export async function planningExecutionWorkflow(
  input: PlanningExecutionWorkflowInput,
): Promise<PlanningExecutionWorkflowResult> {
  "use workflow";
  ...
}
```

每个耐久 step 函数体内同样的指令,例如 [workflow-planning-steps.ts:219-227](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-planning-steps.ts#L223):

```typescript
export async function beginPlanningContextStep(input: {
  productRunId: string;
  attemptId: string;
}): Promise<BeginPlanningContextResponse> {
  "use step";
  return runStep(input.productRunId, input.attemptId, "begin_planning_context", () =>
    beginPlanningContextWithinStep(input),
  );
}
```

同样的 `"use step";` 出现在 [workflow-planning-steps.ts:72](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-planning-steps.ts#L72)、[workflow-planning-steps.ts:119](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-planning-steps.ts#L119)、[workflow-planning-steps.ts:164](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-planning-steps.ts#L164)、[workflow-planning-steps.ts:378](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-planning-steps.ts#L378)、[workflow-planning-steps.ts:535](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-planning-steps.ts#L535)、[workflow-planning-steps.ts:722](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-planning-steps.ts#L722),以及执行阶段 [workflow-execution-steps.ts:56](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-execution-steps.ts#L56) 和决定阶段 [workflow-decision-steps.ts:18](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-decision-steps.ts#L18)、[workflow-decision-steps.ts:95](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-decision-steps.ts#L95)、[workflow-decision-steps.ts:135](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-decision-steps.ts#L135)。

### 1.2 用 C++ 工具链类比

如果你写过 C++,可以这样理解:`"use workflow"` / `"use step"` 类似给函数加了一个**编译期注解**,告诉构建工具"这个函数不是普通函数,请对它做特殊处理"。最贴近的类比是:

- 你给 C++ 函数加 `__attribute__((section(".special")))`,编译器会把这段代码放进特殊段,链接时可以做不同处理;
- 或者你在代码里加 `#pragma`,告诉编译器"从这里开始优化方式变了"。

| C++ 世界 | Vercel Workflow 世界 |
|---|---|
| `__attribute__((section("...")))` 把函数放进特殊段,链接器据此特殊处理 | `"use workflow"` 告诉 SDK 转换器这是一个耐久编排函数,需在 step 边界插桩 checkpoint 逻辑 |
| 注解本身不改变函数语义,但改变编译产物位置 | `"use step"` 把函数标记为耐久边界,转换器在该函数调用前后注入落盘 / 重放桩 |
| 编译器在编译时识别注解、改写代码 | SWC 转换器在构建时识别指令、改写 AST、生成带 checkpoint 调度的 bundle |

### 1.3 为什么 SDK 需要这个指令

耐久编排的核心需求是:**函数执行到任意 step 边界都可能被挂起,之后必须能从磁盘恢复并跳过已完成 step**。要做到这点,转换器必须知道**哪些函数是耐久边界**,才能在那里插桩:

1. 在 step 进入前,记录"即将执行 step N,输入哈希为 X";
2. 在 step 返回后,把输出值序列化落盘;
3. 在重放时,若发现 step N 已有落盘结果,直接返回缓存值而**不真正执行**函数体。

这套插桩不能由开发者手写(容易遗漏且不可校验),必须由转换器基于 `"use step"` 指令自动注入——就像你不能手写每个函数的栈帧管理代码,得让编译器统一生成。从可观察行为看,每个带 `"use step"` 的函数执行后,`.data/workflow/steps/` 下都会生成一份对应的 step checkpoint 文件(见第 3 节),这就是插桩后的落盘产物。

注意:`runStep()` 本身([workflow-step-support.ts:51-72](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-step-support.ts#L51))只负责发射 Trace 事件与包装错误,**不负责 checkpoint**。Checkpoint 由 SDK 在 `"use step"` 边界的外层调度逻辑完成,`runStep` 是被它调用的内层业务包装。

---

## 2. SWC 转换和打包机制

### 2.1 构建脚本

打包由 [build-bundles.ts](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts) 完成,脚本头部的产物说明见 [build-bundles.ts:23-34](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L23):

> - `.workflow-bundle/workflows.mjs`:workflow 编排入口(SWC 转换后)
> - `.workflow-bundle/steps.mjs`:step 入口;非 step 模块保持 external,由运行时经 tsx 解析到 TS 源码,VS Code 断点直接命中 TypeScript
> - `.workflow-bundle/manifest.json`:workflowId 解析与版本证据

构建器 `ChatWorkflowBuilder` 继承自 SDK 的 `BaseBuilder`,见 [build-bundles.ts:71](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L71)。核心 `build()` 方法见 [build-bundles.ts:85-154](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L85),它依次调用两个 SDK 原语:

1. `createStepsBundle`([build-bundles.ts:88-94](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L88))产出 `steps.mjs`,关键参数 `externalizeNonSteps: true`、`rewriteTsExtensions: true`、`format: "esm"`。
2. `createWorkflowsBundle`([build-bundles.ts:95-100](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L95))产出 `workflows.mjs`,参数 `bundleFinalOutput: false`、`format: "esm"`。

随后显式写出 `manifest.json`([build-bundles.ts:101](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L101))与 `runtime-build-evidence.json`([build-bundles.ts:150-153](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L150))。

### 2.2 实际产物清单

构建后 `.workflow-bundle/` 目录下的真实文件:

- `workflows.mjs` - workflow 编排入口(含主函数与调度桩)
- `steps.mjs` - step 入口(含各 `"use step"` 函数转换后的代码)
- `manifest.json` - workflowId 解析表
- `runtime-build-evidence.json` - 构建证据(gitSha、源码/产物 SHA256、版本号)
- `workflows.mjs.debug.json` - **SDK 自动产出的构建元数据**
- `steps.mjs.debug.json` - **SDK 自动产出的构建元数据**

> **重要**:`workflows.mjs.debug.json` / `steps.mjs.debug.json` **不是 sourcemap**。`build-bundles.ts` 只显式写了 `manifest.json` 和 `runtime-build-evidence.json`(见 [build-bundles.ts:101](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L101) 与 [build-bundles.ts:150](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L150)),这两个 `.debug.json` 是 `BaseBuilder` 内部自动产出的 SDK 构建元数据。它们不映射回源码行号,因此 VS Code 无法据此把 bundle 里的断点绑回 TypeScript 源(详见第 6 节)。

### 2.3 用 C++ 链接类比:`externalizeNonSteps` 的含义

`externalizeNonSteps: true` 是这套打包最关键的开关。如果你熟悉 C/C++ 编译链接,这个概念非常直观:

| C/C++ 工具链概念 | 对应物 |
|---|---|
| `gcc -c foo.c -o foo.o` 编译单个文件 | SWC 转换 `foo.ts`,生成 AST 改写后的中间产物 |
| `ld foo.o bar.o -o prog` 把多个 `.o` 链接成可执行文件 | `createStepsBundle` / `createWorkflowsBundle` 把多个模块链接成单个 `steps.mjs` / `workflows.mjs` |
| `ld -lsomelib` 动态链接,符号留待运行时解析(对应 `.so` / `.dll`) | `externalizeNonSteps: true`:非 step 模块(如 `api-client.ts`、`runtime-context.ts`、`@chat/contracts`)**不打进 bundle**,以 `import` 形式保留,运行时由 Node.js 解析 |
| 程序启动时动态加载 `.so` / `dlopen` | external 模块由运行时进程经 `tsx` 解析到 TypeScript 源码执行 |

所以最终形态是:**bundle = 静态链接进去的耐久编排逻辑 + 一组指向外部模块的动态引用(像未解析的外部符号)**。`workflows.mjs` / `steps.mjs` 里的 `import { ... } from "./api-client.js"` 这类语句在运行时不会被 bundle 自己满足,而是回落到磁盘上的 TS 源码——这正是断点能命中的根因(第 6 节展开)。

`rewriteTsExtensions: true` 则把 `.js`/`.ts` 扩展名在 import 路径里规范化,保证 ESM 解析在 `tsx` 与纯 Node 下都能找到目标文件。

---

## 3. Checkpoint 持久化

### 3.1 机制概览

每个耐久 step 执行完毕后,SDK 在 step 边界把当前 Run 的执行状态落盘。最直观的理解就是**游戏存档点**:走到一个存档点就把"执行到哪、当前变量值多少"写成文件存下来;万一程序崩了,下次重启从最近的存档点继续。

### 3.2 落盘位置

Checkpoint 数据全部写在 `.data/workflow/` 下(路径由 [runtime-main.ts:20](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-main.ts#L20) 的 `workflowDataDir` 决定,默认 `${repoRoot}/.data/workflow`)。实际目录结构(从仓库真实文件归纳):

```
.data/workflow/
├── version.txt                              # World 版本(@workflow/world-local@4.2.4)
├── runs/
│   └── wrun_<id>.json                       # 每个 Workflow Run 的状态(checkpoint 主体)
├── events/
│   └── wrun_<id>-evnt_<id>.json             # 事件 journal,每条事件一个文件,append-only
├── steps/
│   └── wrun_<id>-step_<id>.json             # 每个 step 的 checkpoint(输入/输出/哈希)
└── .locks/
    ├── steps/
    │   └── wrun_<id>-step_<id>.terminal     # step 已到达终态的锁标记
    ├── hooks/
    │   └── hook_<id>.disposed               # Hook 已释放的耐久标记
    └── waits/
        └── wrun_<id>-wait_<id>.completed    # wait 已完成的耐久标记
```

各目录的职责:

- **`runs/wrun_*.json`** - Run 级状态机:当前执行到哪个 step、Run 状态(running/waiting/completed/failed/cancelled)、绑定身份。相当于这个任务"当前执行状态"的快照记录。
- **`events/wrun_*-evnt_*.json`** - 事件 journal,一条事件一个文件。这是 append-only 的事件日志,重放时按事件顺序重建 Run 历史。
- **`steps/wrun_*-step_*.json`** - Step 级 checkpoint:该 step 的输入参数哈希、输出值、执行位置。这是重放时"跳过已完成 step"的直接依据。
- **`.locks/`** - 用文件存在性表达状态机终态标记,避免重复执行或重复恢复。`.locks/steps/*.terminal` 表示 step 已不可重入;`.locks/hooks/*.disposed` 表示 Hook 已被消费;`.locks/waits/*.completed` 表示 wait 已完成。可以理解成用"文件在不在"来当锁,比内存里的锁更持久——进程重启了文件还在。

### 3.3 Checkpoint 存什么

从代码可观察的契约看,每个 step checkpoint 至少包含:

- **step 标识**:`wrun_<runId>-step_<stepId>` 文件名即唯一标识。
- **输入哈希**:step 的输入参数被规范化后计算 SHA256(例如 `cmdId()` 在 [workflow-step-support.ts:14-16](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-step-support.ts#L14) 用 `sha256Hex(parts.join(":"))` 生成幂等 commandId;执行 step 的 `inputManifestSha256` 见 [workflow-execution-steps.ts](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-execution-steps.ts))。重放时若输入哈希一致,即可安全复用缓存输出。
- **输出值**:step 返回值被序列化(必须是 Zod 可校验的可序列化结构,见 [workflow-input.ts:14-22](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-input.ts#L14) 对输入的 strict schema 约束)。
- **执行位置**:Run 在编排函数里的"指令指针",即下一个该执行的 step。SDK 基于此在重放时跳转。

Chat 的设计原则([planning-execution-workflow.ts:37-46](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L37) 注释)进一步约束:checkpoint 只保存**不可变引用**(如 `contextPackageRef`、`selectionRef`),不保存模型正文或外部服务返回的大块正文。这样存档文件小,而且重放时从权威源(Product Store)重读,避免缓存和权威事实对不上。

---

## 4. 重放(Replay)机制

重放是整个运行时的核心。它解决的问题是:**进程崩溃 → 重启 → 从最近 checkpoint 恢复,且不重复执行已完成的副作用**。最直观的类比就是**游戏读档继续**:存档点之前的部分直接跳过(不重新打),从存档点接着往下走。

### 4.1 启动恢复路径

Runtime 进程入口在 [runtime-main.ts](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-main.ts)。它读端口(`43112`,[runtime-main.ts:11](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-main.ts#L11))、加载凭据、调用 `createWorkflowRuntimeServer`([runtime-main.ts:16-26](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-main.ts#L16)),最后 `serve` 监听。

`createWorkflowRuntimeServer` 在 [runtime-server.ts:68-171](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L68) 完成恢复装配,关键三步:

1. **注入进程级上下文**([runtime-server.ts:93-105](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L93)):`setWorkflowRuntimeContext({ api, bindings, memoryBackends, trace, planner, executor, ... })`。这个上下文挂在 `globalThis[Symbol.for("chat.workflowRuntimeContext")]`([runtime-context.ts:37](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-context.ts#L37)),因为 step bundle 拥有独立模块实例,bundle 内外的 step 必须通过这个全局槽看到同一份注入(见 [runtime-context.ts:19-21](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-context.ts#L19) 注释)。
2. **装配 World**([runtime-server.ts:107-160](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L107)):`setupWorkflowWorld({ recoverActiveRuns: true, beforeStart: ... })`。`recoverActiveRuns: true` 表示进程重启后从存储恢复 pending/running 的 Run([workflow-world.ts:18-19](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L18))。
3. **`beforeStart` 安全门**([runtime-server.ts:111-158](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L111)):恢复队列前逐项验证——每个 binding 引用的 Workflow Run 必须存在、状态非终态、Runner family 受支持、版本与当前构建匹配(`assertRunVersionMatchesBuild`)。任一不一致就在 `world.start()` 前失败关闭,**绝不带着陈旧映射恢复执行**。这就像程序启动时先自检,发现环境不对直接报错退出,而不是带着错误状态勉强跑起来。

### 4.2 World 如何加载 bundle 与启动

[workflow-world.ts:133-174](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L133) 的 `setupWorkflowWorld` 是恢复的物理实现:

```typescript
const world = createLocalWorld({
  dataDir: options.dataDir,
  recoverActiveRuns: options.recoverActiveRuns,
  ...(options.tag !== undefined ? { tag: options.tag } : {}),
});
...
world.registerHandler("__wkf_workflow_", lazyBundleHandler(join(options.bundleDir, "workflows.mjs")));
world.registerHandler("__wkf_step_", lazyBundleHandler(join(options.bundleDir, "steps.mjs")));
setWorld(world);
...
await world.start?.();
```

要点:

- `createLocalWorld`([workflow-world.ts:137-141](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L137))创建本地 World 实例(单机调度器)。
- `registerHandler`([workflow-world.ts:146-150](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L146))把 `workflows.mjs` 与 `steps.mjs` 的 `POST` handler 注册到两个内部路由前缀 `__wkf_workflow_` / `__wkf_step_`。World 调度 step 时,会以 HTTP 风格的 `Request` 投递给对应 handler([workflow-world.ts:119-131](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L119) 的 `lazyBundleHandler` 懒加载 bundle 模块的 `POST` 导出)。
- `setWorld(world)`([workflow-world.ts:151](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L151))把 World 安装为 SDK 全局调度器。**Handler 必须先于 `start` 注册**,注释 [workflow-world.ts:145](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L145) 明确指出"避免恢复派发与 handler 安装竞争"。
- `world.start?.()`([workflow-world.ts:154](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L154))触发恢复:扫描 `runs/` 下所有未终态的 Run,把它们重新放回运行队列。相当于启动后把"还没干完的任务"重新捡起来继续。

### 4.3 重放时的语义

重放一个 Run 时,SDK 按编排函数的控制流重新走一遍,但对每个 step:

1. 读取该 step 的 checkpoint(`steps/wrun_*-step_*.json`);
2. 若已有终态结果(且 `.locks/steps/*.terminal` 存在),**不真正执行 step 函数体**,直接把缓存的输出值注入到编排函数的对应变量;
3. 跳到下一个未完成的 step 继续真正执行。

这就是**读档继续**:存档点之前的部分不重新执行(不重复副作用),只重放控制流走到存档点,然后从那里接着真正往下跑。

### 4.4 重放时断点的坑(重要)

重放已完成 step 时,**编排函数的控制流会再次经过该 step 的调用点**,因此:

- 你在该 step 函数体内部设的源码断点**会被命中**(控制流确实经过了),但 step 体的业务代码**并未真正执行**(SDK 直接返回缓存结果)。这极易让人误判"step 又跑了一遍"。
- 真正的副作用(写 Product Store、调 Provider)不会重复——因为 step 体没执行,`runStep` 里的 `fn()` 不会被调用,`ctx.api.*` 也不会被调用。

调试时若看到断点命中但变量值"凭空出现",先确认是不是重放在返回缓存——判断依据是该 step 是否已有 `.locks/steps/*.terminal` 标记或 `steps/wrun_*-step_*.json`。

---

## 5. Hook 耐久等待与恢复

### 5.1 机制定位

Hook 是 Workflow 的**耐久等待原语**:编排函数可以挂起在一个 Hook 上,等待外部事件唤醒,且挂起期间进程崩溃也不丢失等待状态。最直观的理解:工作流执行到"等用户审批"时,把"我在等这个决定"写成文件存到磁盘,然后暂停(不占 CPU);进程可以去做别的,甚至重启都不丢——只要外部把决定写进来,工作流就能从存档恢复继续跑。像游戏暂停在"按 A 确认 / 按 B 取消"的对话框,状态存了盘,随时能继续。

### 5.2 定义与创建

Hook 在 [planning-execution-workflow.ts:48](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L48) 定义:

```typescript
const planDecisionHook = defineHook({ schema: planDecisionHookPayloadSchema });
```

`defineHook` 声明一个带 payload schema 的 Hook 类型。payload schema 见 [workflow-input.ts:27-34](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-input.ts#L27),只携带 `productRunId`、`approvalRequestId`、`decisionId` 三个引用——不携带决定正文,恢复后再从 Product Store 重读。

Hook 在编排函数里创建并等待,见 [planning-execution-workflow.ts:200-225](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L200):

```typescript
using decisionHook = planDecisionHook.create({
  token: `pdh-${productRunId}-${String(review.planRevision)}`,
});
const conflict = await decisionHook.getConflict();
if (conflict !== null) { ... return failed; }

await claimDecisionHookStep({ productRunId, attemptId, planRevision, approvalRequestId });

const waitResult = await Promise.race([
  decisionHook.then((resumeSignal) => ({ kind: "decision" as const, resumeSignal })),
  sleep(new Date(review.approvalExpiresAt)).then(() => ({ kind: "expired" as const })),
]);
```

逐步对应:

| 代码 | 直观理解 |
|---|---|
| `planDecisionHook.create({ token })` | 创建一个等待点,登记"我在等这个 token 对应的决定";`token` 是确定性句柄 |
| `decisionHook.getConflict()` | 检查是不是已经有冲突的等待者在等同一个点(检测竞争) |
| `claimDecisionHookStep` 注册 binding | 把等待者登记到耐久存储,保证崩溃后仍可被唤醒 |
| `await decisionHook` | 暂停执行,让出 CPU,进入等待(状态已存盘) |
| 外部唤醒 | Runtime 收到 Resume Outbox 后恢复 Hook,等价于"有人按了确认键" |
| `Promise.race([... sleep(expiresAt)])` | 等待 + 定时器赛跑,超时保护 |

### 5.3 确定性 Token

Hook token 由 [workflow-input.ts:39-41](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-input.ts#L39) 生成:

```typescript
export function decisionHookToken(productRunId: string, planRevision: number): string {
  return `pdh-${productRunId}-${String(planRevision)}`;
}
```

这是**纯函数推导的确定性句柄**--同一 Product Run 的同一 Plan 修订永远得到同一 token。好处:崩溃重启后,Runtime 凭 `productRunId + planRevision` 即可重建 token 找回 Hook,无需持久化随机 ID。这就像用"会话 ID + 版本号"组合当唯一键,而不是生成一个随机 UUID 再存起来——少存一样东西,少一处出错。

### 5.4 耐久注册

`claimDecisionHookStep` 在 [workflow-decision-steps.ts:12-42](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-decision-steps.ts#L12) 通过 `ctx.bindings.claimHookBinding` 把 Hook 绑定写入 Runtime Binding Store([workflow-decision-steps.ts:22-28](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-decision-steps.ts#L22))。注释 [planning-execution-workflow.ts:214](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L214) 强调:"Hook 先由 Workflow World 耐久注册,之后才对 Runtime 暴露绑定;Resume 永远看不到未注册 Hook。"

耐久性体现在两层:

1. **Binding Store**(JSON 文件,`${repoRoot}/.data/runtime/runtime-bindings.v1.json`):记录 `productRunId ↔ workflowRunId ↔ hookToken` 映射。进程崩溃后这份映射仍在磁盘。
2. **World 的 Hook 状态**:`.data/workflow/.locks/hooks/hook_<id>.disposed` 标记 Hook 已被消费。恢复时 World 据此判断 Hook 是否仍 pending。

所以 Hook 等待是**真正耐久的**:`await decisionHook` 挂起后,即使 Runtime 进程被 `kill -9`,重启后 World 会恢复这个 pending Hook,只要外部 Resume 信号到达,就能唤醒继续执行。

### 5.5 超时保护

[planning-execution-workflow.ts:222-241](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L222) 用 `Promise.race` 让 Hook 等待与 `sleep(approvalExpiresAt)` 竞争:

- 若 `sleep` 先 resolve(超时),调 `expireApprovalStep`([workflow-decision-steps.ts:129-150](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-decision-steps.ts#L129))尝试把 Run 标记为失败。
- `expireApprovalStep` 返回 `"already_decided"` 时,说明决定已先提交但 Resume Outbox 仍在路上,此时**继续等待同一个 Hook**([planning-execution-workflow.ts:237-238](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L237)),不直接失败。
- 返回 `"expired"` 才真正失败([planning-execution-workflow.ts:234-236](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L234))。

这是 `approvalExpiresAt`(审批有效期,约 24 小时)的硬超时保护:等太久没人决定,就走超时失败路径。

### 5.6 唤醒后恢复

Hook 被 resume 后,`await decisionHook` 返回 `resumeSignal`(payload,含 `decisionId`)。编排函数随后调 `loadCommittedDecisionStep`([planning-execution-workflow.ts:244-261](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L244)、[workflow-decision-steps.ts:83-127](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-decision-steps.ts#L83))**从 Product Store 重读**已提交的决定事实,而非信任 Hook payload 里的内容。这呼应产品不变量"模型输出只是候选":Hook 只携带信号,权威事实永远从 Product Store 读。

---

## 6. 断点调试的原理和坑

### 6.1 Inspector 端口

Workflow Runtime 的调试端口 `43121` 由 [scripts/dev/app-runtime.mjs:144](file:///Users/xulater/Code/Chat/scripts/dev/app-runtime.mjs#L144) 通过 `--inspect=127.0.0.1:${workflowInspector}` 注入,`workflowInspector = 43121`(见 [scripts/debug/lib.mjs:32](file:///Users/xulater/Code/Chat/scripts/debug/lib.mjs#L32))。这是 Node.js 的 V8 Inspector,即 Chrome DevTools Protocol(CDP)服务端。VS Code 通过 CDP 附加到该端口,即可在 TypeScript/JavaScript 源码上设断点、单步、查看变量。

调试模式下,API 进程的 Inspector 在 `43120`,Workflow 在 `43121`,Memory 第三方进程不开放 Inspector([scripts/dev/app-runtime.test.mjs:64-68](file:///Users/xulater/Code/Chat/scripts/dev/app-runtime.test.mjs#L64) 验证)。

### 6.2 为什么 `"use workflow"` / `"use step"` 函数体的源码断点不命中

这是调试时最容易踩的坑。用 C++ 经验理解会非常清楚:你的 `.c` 源码经过 `gcc -c` 编译、`ld` 链接成可执行文件后,如果你在 `.c` 源码某行设断点但可执行文件里没有调试信息(没有 `-g`、没有 sourcemap),调试器找不到源码行和机器码地址的对应关系,断点就不会触发。你只能在反汇编上设断点,或者用 `printf` 观察副作用。

Chat 的情况完全对应:

1. 这些函数体被 SWC 转换 + 打包进了 `.workflow-bundle/workflows.mjs` 或 `steps.mjs`(见第 2 节)。运行时实际执行的是 bundle 里的转换后代码,不是 `packages/workflows/src/*.ts` 源码。
2. bundle 没有附带 sourcemap(`.debug.json` 不是 sourcemap,见第 2.2 节),VS Code 无法把 bundle 的执行位置映射回 TS 源行号。
3. 因此你在 `planning-execution-workflow.ts` 第 95 行、或 `beginPlanningContextStep` 第 223 行设的断点,**实际执行流根本不会停在那里**--因为执行的是 `workflows.mjs` / `steps.mjs` 里的对应代码,而那部分代码没有源码映射。

一句话:被打进 bundle 的代码 = 静态链接进可执行文件、且没带调试信息的代码,断点打不回源码。

### 6.3 为什么 `api-client.ts` 等外部模块断点能命中

对照之下,[api-client.ts](file:///Users/xulater/Code/Chat/packages/workflows/src/api-client.ts) 里的 `call()` 函数([api-client.ts:112-165](file:///Users/xulater/Code/Chat/packages/workflows/src/api-client.ts#L112))、`createRuntimeApiClient`([api-client.ts:167](file:///Users/xulater/Code/Chat/packages/workflows/src/api-client.ts#L167))断点可以命中。原因:

- `externalizeNonSteps: true` 让 `api-client.ts` **不打进 bundle**,以 `import` 引用保留(见第 2.3 节)--就像动态链接库,运行时才加载。
- 运行时进程([runtime-main.ts](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-main.ts))通过 `tsx` 启动,`tsx` 会把 TS 源码即时转译执行,保留了源码位置信息。
- 因此 VS Code 的断点直接绑定到 `packages/workflows/src/api-client.ts` 的 TS 源行,执行流经过时即命中。

同理可命中断点的外部模块:`runtime-context.ts`、`runtime-server.ts`、`workflow-world.ts`、`@chat/pi-runtime`、`@chat/memory-runtime`、`@chat/application` 等所有没被打进 bundle 的模块。

### 6.4 推荐调试策略

既然 bundle 内断点不命中,就把断点设在**外部模块**上,作为观察工作流执行的侧信道——就像你没法在静态链接进可执行文件的库源码上断点,但可以在它调用的、动态加载的别的模块上断点来间接观察:

| 想观察什么 | 在哪里设断点 |
|---|---|
| step 调用了哪些后端命令、参数是什么 | [api-client.ts](file:///Users/xulater/Code/Chat/packages/workflows/src/api-client.ts) 各 `call()` 调用处(如 [api-client.ts:372-378](file:///Users/xulater/Code/Chat/packages/workflows/src/api-client.ts#L372) `beginPlanningContext`) |
| step 的 Trace 事件 | [workflow-step-support.ts:51-72](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-step-support.ts#L51) `runStep` 内 `emitStepTrace` 调用 |
| Hook 注册与恢复 | [workflow-decision-steps.ts:12-42](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-decision-steps.ts#L12) `claimDecisionHookStep`、[workflow-decision-steps.ts:83-127](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-decision-steps.ts#L83) `loadCommittedDecisionStep` |
| Runtime 启动恢复 | [runtime-server.ts:111-158](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L111) `beforeStart` 安全门、[workflow-world.ts:154](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L154) `world.start?.()` |
| 进程级上下文注入 | [runtime-context.ts:43-53](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-context.ts#L43) `setWorkflowRuntimeContext` / `getWorkflowRuntimeContext` |
| Planner / Executor 模型调用 | `ctx.planner` / `ctx.executor` 注入点([runtime-server.ts:101-103](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L101))及 `@chat/pi-runtime` 实现 |

这种策略类似用日志或侧信道观察一个黑盒程序:不直接单步它内部,而是在它调用的、你能下断点的地方埋点。`ctx.api.*` 是 step 与外部世界唯一的副作用出口(见 [runtime-context.ts:23-35](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-context.ts#L23) 的 `WorkflowRuntimeContext` 接口),在这里断点能完整还原 step 的行为。

### 6.5 重放断点的额外坑

结合第 4.4 节:即使断点设在能命中的外部模块,重放时也要小心。重放已完成 step 时,SDK 直接返回缓存,**不会调用 `ctx.api.*`**,因此你在 `api-client.ts` 上的断点在重放阶段**不会命中**。若你期望命中却没命中,先确认该 step 是否正在被重放(检查 `.locks/steps/*.terminal` 是否存在)。

---

## 7. 概念映射总结表

下表汇总 Vercel Workflow 各概念到 C++ / 通用编程概念的映射,便于建立整体心智模型。所有源码位置保留,方便对照。

| Vercel Workflow 概念 | C++ / 通用编程类比 | 项目源码位置 |
|---|---|---|
| `"use workflow"` 指令 | 编译期注解(如 `__attribute__((section(...)))`),告诉构建器这是耐久编排函数入口 | [planning-execution-workflow.ts:95](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L95) |
| `"use step"` 指令 | 耐久边界注解,转换器在此插桩 checkpoint | [workflow-planning-steps.ts:223](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-planning-steps.ts#L223) 等处 |
| SWC 转换 + 打包 | `gcc -c` 编译 + `ld` 链接 | [build-bundles.ts:85-100](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L85) |
| `workflows.mjs` / `steps.mjs` bundle | 静态链接产物(可执行文件),把代码打进去了 | [build-bundles.ts:27-28](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L27) |
| `externalizeNonSteps: true` | 动态链接(`-l` / `.so` / `.dll`),符号运行时解析 | [build-bundles.ts:90](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L90) |
| `*.debug.json` | 构建元数据(非 sourcemap,非调试信息),不映射回源码 | `.workflow-bundle/workflows.mjs.debug.json`(SDK 自动产出) |
| Checkpoint(每个 step 后) | 游戏存档点:执行到哪、变量值多少,存成文件 | `.data/workflow/steps/wrun_*-step_*.json` |
| `runs/wrun_*.json` | 任务当前执行状态记录(像任务结构体) | `.data/workflow/runs/` |
| `events/wrun_*-evnt_*.json` | append-only 事件日志 | `.data/workflow/events/` |
| `.locks/*.terminal` / `.disposed` / `.completed` | 用文件存在性当锁(比内存锁更持久,进程重启还在) | `.data/workflow/.locks/` |
| Replay(重放) | 读档继续:存档点之前不重新执行,只重放控制流到存档点 | [workflow-world.ts:154](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L154) `world.start?.()` |
| `recoverActiveRuns: true` | 启动时捡起没干完的任务继续 | [runtime-server.ts:110](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L110) |
| `beforeStart` 安全门 | 启动自检,环境不对直接报错退出,不带病运行 | [runtime-server.ts:111-158](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L111) |
| LocalWorld | 单机调度器实例 | [workflow-world.ts:137-141](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L137) |
| `registerHandler` | 注册处理函数(像注册回调) | [workflow-world.ts:146-150](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L146) |
| `setWorld(world)` | 安装全局调度器 | [workflow-world.ts:151](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L151) |
| `defineHook` | 声明一个等待点类型 | [planning-execution-workflow.ts:48](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L48) |
| `planDecisionHook.create({ token })` | 创建等待点,登记"我在等这个 token" | [planning-execution-workflow.ts:200-202](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L200) |
| `await decisionHook` | 暂停执行,让出 CPU,进入等待(状态已存盘) | [planning-execution-workflow.ts:222-225](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L222) |
| 外部 Resume 唤醒 Hook | 有人按了确认键,工作流继续 | 经 Runtime HTTP 分发恢复 |
| `claimDecisionHookStep` 注册 binding | 把等待者登记到耐久存储,崩溃后仍可唤醒 | [workflow-decision-steps.ts:22-28](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-decision-steps.ts#L22) |
| 确定性 Hook token | 用"会话 ID + 版本号"推导唯一键,而非随机 UUID | [workflow-input.ts:39-41](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-input.ts#L39) |
| `Promise.race([hook, sleep(expiresAt)])` | 等待 + 定时器赛跑,超时保护 | [planning-execution-workflow.ts:222-241](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L222) |
| `step.run` / `runStep` | 发射 Trace 事件的包装;checkpoint 在外层 SDK 边界 | [workflow-step-support.ts:51-72](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-step-support.ts#L51) |
| `ctx.api.*` | step 调外部世界的唯一出口(HTTP 回后端) | [api-client.ts:112-165](file:///Users/xulater/Code/Chat/packages/workflows/src/api-client.ts#L112) `call()` |
| `ctx` 挂在 `globalThis[Symbol.for(...)]` | 全局共享变量,因 bundle 独立模块实例需跨模块共享 | [runtime-context.ts:37-53](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-context.ts#L37) |
| `--inspect=127.0.0.1:43121` | V8 Inspector / CDP 调试端口 | [scripts/dev/app-runtime.mjs:144](file:///Users/xulater/Code/Chat/scripts/dev/app-runtime.mjs#L144) |
| bundle 内断点不命中 | 静态链接进可执行文件、无 sourcemap,断点打不回源码 | 见第 6.2 节 |
| external 模块断点命中 | 动态链接库,`tsx` 解释执行,保留源码位置,可断点 | 见第 6.3 节 |

---

## 附:运行时端口与路径速查

| 用途 | 端口 / 路径 | 源码依据 |
|---|---|---|
| Workflow Runtime HTTP | `127.0.0.1:43112` | [runtime-main.ts:11](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-main.ts#L11) |
| Workflow Node Inspector | `127.0.0.1:43121` | [scripts/dev/app-runtime.mjs:144](file:///Users/xulater/Code/Chat/scripts/dev/app-runtime.mjs#L144) |
| 后端 API(公开) | `43110` | 项目背景信息 |
| 后端 API(内部) | `43111` | [runtime-main.ts:23](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-main.ts#L23) `apiBaseUrl` 默认 `127.0.0.1:43111` |
| Bundle 目录 | `packages/workflows/.workflow-bundle/` | [runtime-main.ts:18-19](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-main.ts#L18) |
| Workflow 数据目录 | `.data/workflow/` | [runtime-main.ts:20](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-main.ts#L20) |
| Runtime Binding | `.data/runtime/runtime-bindings.v1.json` | [runtime-main.ts:21-22](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-main.ts#L21) |
| Trace 数据 | `.data/traces/` | 项目背景信息 |
| Product Store | `.data/product/` | 项目背景信息 |
