# Vercel Workflow 机制详解(面向 C/C++ 与 Linux 内核开发者)

本文以 Chat 项目真实代码为唯一依据,解释 Vercel Workflow 本地运行时(`@workflow/world-local@4.2.4`)的内部机制。读者假定熟悉 C/C++ 与 Linux 内核开发;所有 Web/TS 概念都用内核概念类比。

一句话定位:Vercel Workflow 是一个**进程内的耐久编排运行时**,其角色类似一个用户态、协作式、基于显式检查点的微内核调度器。它在 Chat 里以独立进程运行(HTTP 端口 `43112`,Inspector 端口 `43121`),用预编译的 bundle 执行 workflow 函数,在每个耐久 step 边界落盘 checkpoint,进程崩溃后重启可从最近 checkpoint 重放并恢复执行。

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

### 1.2 内核类比

这对内核开发者最贴切的类比是 **eBPF 程序的 `SEC("bpf/program")` 段标记**,或内核函数的 `__init` / `__sched` 注解:

| 内核世界 | Vercel Workflow 世界 |
|---|---|
| `SEC("tp/syscalls/...")` 告诉 libbpf/verifier 这是一个 BPF 程序入口,需重写为 BPF 字节码 | `"use workflow"` 告诉 SDK 转换器这是一个耐久编排函数,需在 step 边界插桩 checkpoint 逻辑 |
| `__init` 把函数放进 `.init.text` 段,boot 后释放 | `"use step"` 把函数标记为耐久边界,转换器在该函数调用前后注入落盘/重放桩 |
| verifier 在加载时静态校验并重写指令 | SWC 转换器在构建时识别指令、改写 AST、生成带 checkpoint 调度的 bundle |

### 1.3 为什么 SDK 需要这个指令

耐久编排的核心需求是:**函数执行到任意 step 边界都可能被挂起,之后必须能从磁盘恢复并跳过已完成 step**。要做到这点,转换器必须知道**哪些函数是耐久边界**,才能在那里插桩:

1. 在 step 进入前,记录"即将执行 step N,输入哈希为 X";
2. 在 step 返回后,把输出值序列化落盘;
3. 在重放时,若发现 step N 已有落盘结果,直接返回缓存值而**不真正执行**函数体。

这套插桩不能由开发者手写(容易遗漏且不可校验),必须由转换器基于 `"use step"` 指令自动注入——正如 BPF verifier 不信任开发者手写的字节码,而要在加载时统一重写与校验。从可观察行为看,每个带 `"use step"` 的函数执行后,`.data/workflow/steps/` 下都会生成一份对应的 step checkpoint 文件(见第 3 节),这就是插桩后的落盘产物。

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

- `workflows.mjs` — workflow 编排入口(含主函数与调度桩)
- `steps.mjs` — step 入口(含各 `"use step"` 函数转换后的代码)
- `manifest.json` — workflowId 解析表
- `runtime-build-evidence.json` — 构建证据(gitSha、源码/产物 SHA256、版本号)
- `workflows.mjs.debug.json` — **SDK 自动产出的构建元数据**
- `steps.mjs.debug.json` — **SDK 自动产出的构建元数据**

> **重要**:`workflows.mjs.debug.json` / `steps.mjs.debug.json` **不是 sourcemap**。`build-bundles.ts` 只显式写了 `manifest.json` 和 `runtime-build-evidence.json`(见 [build-bundles.ts:101](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L101) 与 [build-bundles.ts:150](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L150)),这两个 `.debug.json` 是 `BaseBuilder` 内部自动产出的 SDK 构建元数据。它们不映射回源码行号,因此 VS Code 无法据此把 bundle 里的断点绑回 TypeScript 源(详见第 6 节)。

### 2.3 内核类比:`externalizeNonSteps` 的含义

`externalizeNonSteps: true` 是这套打包最关键的开关。用编译链接类比:

| 工具链概念 | 对应物 |
|---|---|
| `gcc -c foo.c -o foo.o` | SWC 转换 `foo.ts`,生成 AST 改写后的中间产物 |
| `ld foo.o bar.o -o prog` | `createStepsBundle` / `createWorkflowsBundle` 把多个 `.o` 链接成单个 `steps.mjs` / `workflows.mjs` |
| `ld -lsomelib`(动态链接,符号留待运行时解析) | `externalizeNonSteps: true`:非 step 模块(如 `api-client.ts`、`runtime-context.ts`、`@chat/contracts`)**不打进 bundle**,以 `import` 形式保留,运行时由 Node.js 解析 |
| `.so` 共享库,进程启动时 dlopen | external 模块由运行时进程经 `tsx` 解析到 TypeScript 源码执行 |

所以最终形态是:**bundle = 静态链接的耐久编排逻辑(.text)+ 一组指向外部模块的动态符号引用**。`workflows.mjs` / `steps.mjs` 里的 `import { ... } from "./api-client.js"` 这类语句在运行时不会被 bundle 自己满足,而是回落到磁盘上的 TS 源码——这正是断点能命中的根因(第 6 节展开)。

`rewriteTsExtensions: true` 则把 `.js`/`.ts` 扩展名在 import 路径里规范化,保证 ESM 解析在 `tsx` 与纯 Node 下都能找到目标文件。

---

## 3. Checkpoint 持久化

### 3.1 机制概览

每个耐久 step 执行完毕后,SDK 在 step 边界把当前 Run 的执行状态落盘。内核开发者最贴切的类比是 **suspend-to-disk(ACPI S4 / swsusp)** 或 **kdump crash dump**:把进程的执行位置与变量状态序列化到非易失存储,后续可据此恢复。

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

- **`runs/wrun_*.json`** — Run 级状态机:当前执行到哪个 step、Run 状态(running/waiting/completed/failed/cancelled)、绑定身份。相当于一个 task 的 `struct task_struct` 快照。
- **`events/wrun_*-evnt_*.json`** — 事件 journal,一条事件一个文件。这是 append-only 的事件日志,类似内核的 audit log 或 `printk` ring buffer 的持久化版本。重放时按事件顺序重建 Run 历史。
- **`steps/wrun_*-step_*.json`** — Step 级 checkpoint:该 step 的输入参数哈希、输出值、执行位置。这是重放时"跳过已完成 step"的直接依据。
- **`.locks/`** — 用文件存在性表达状态机终态标记,避免重复执行或重复恢复。`.locks/steps/*.terminal` 表示 step 已不可重入(类似 flock 的持久化版本);`.locks/hooks/*.disposed` 表示 Hook 已被消费;`.locks/waits/*.completed` 表示 wait 已完成。

### 3.3 Checkpoint 存什么

从代码可观察的契约看,每个 step checkpoint 至少包含:

- **step 标识**:`wrun_<runId>-step_<stepId>` 文件名即唯一标识。
- **输入哈希**:step 的输入参数被规范化后计算 SHA256(例如 `cmdId()` 在 [workflow-step-support.ts:14-16](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-step-support.ts#L14) 用 `sha256Hex(parts.join(":"))` 生成幂等 commandId;执行 step 的 `inputManifestSha256` 见 [workflow-execution-steps.ts](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-execution-steps.ts))。重放时若输入哈希一致,即可安全复用缓存输出。
- **输出值**:step 返回值被序列化(必须是 Zod 可校验的可序列化结构,见 [workflow-input.ts:14-22](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-input.ts#L14) 对输入的 strict schema 约束)。
- **执行位置**:Run 在编排函数里的"指令指针",即下一个该执行的 step。SDK 基于此在重放时跳转。

Chat 的设计原则([planning-execution-workflow.ts:37-46](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L37) 注释)进一步约束:checkpoint 只保存**不可变引用**(如 `contextPackageRef`、`selectionRef`),不保存模型正文或外部服务返回的大块正文。这类似内核里把大页换出、只在 task struct 里保留 swap 引用——既省空间,又保证重放时从权威源(Product Store)重读,避免缓存与权威事实漂移。

---

## 4. 重放(Replay)机制

重放是整个运行时的核心。它解决的问题是:**进程崩溃 → 重启 → 从最近 checkpoint 恢复,且不重复执行已完成的副作用**。

### 4.1 启动恢复路径

Runtime 进程入口在 [runtime-main.ts](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-main.ts)。它读端口(`43112`,[runtime-main.ts:11](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-main.ts#L11))、加载凭据、调用 `createWorkflowRuntimeServer`([runtime-main.ts:16-26](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-main.ts#L16)),最后 `serve` 监听。

`createWorkflowRuntimeServer` 在 [runtime-server.ts:68-171](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L68) 完成恢复装配,关键三步:

1. **注入进程级上下文**([runtime-server.ts:93-105](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L93)):`setWorkflowRuntimeContext({ api, bindings, memoryBackends, trace, planner, executor, ... })`。这个上下文挂在 `globalThis[Symbol.for("chat.workflowRuntimeContext")]`([runtime-context.ts:37](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-context.ts#L37)),因为 step bundle 拥有独立模块实例,bundle 内外的 step 必须通过这个全局槽看到同一份注入(见 [runtime-context.ts:19-21](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-context.ts#L19) 注释)。
2. **装配 World**([runtime-server.ts:107-160](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L107)):`setupWorkflowWorld({ recoverActiveRuns: true, beforeStart: ... })`。`recoverActiveRuns: true` 表示进程重启后从存储恢复 pending/running 的 Run([workflow-world.ts:18-19](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L18))。
3. **`beforeStart` 安全门**([runtime-server.ts:111-158](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L111)):恢复队列前逐项验证——每个 binding 引用的 Workflow Run 必须存在、状态非终态、Runner family 受支持、版本与当前构建匹配(`assertRunVersionMatchesBuild`)。任一不一致就在 `world.start()` 前失败关闭,**绝不带着陈旧映射恢复执行**。这类似内核 boot 时的硬件/版本检测,失败即 panic 而非带病启动。

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
- `world.start?.()`([workflow-world.ts:154](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L154))触发恢复:扫描 `runs/` 下所有未终态的 Run,把它们重新放回运行队列。这相当于 boot 后重新调度 task。

### 4.3 重放时的语义

重放一个 Run 时,SDK 按编排函数的控制流重新走一遍,但对每个 step:

1. 读取该 step 的 checkpoint(`steps/wrun_*-step_*.json`);
2. 若已有终态结果(且 `.locks/steps/*.terminal` 存在),**不真正执行 step 函数体**,直接把缓存的输出值注入到编排函数的对应变量;
3. 跳到下一个未完成的 step 继续真正执行。

这类似 **CRIU(checkpoint/restore in userspace)的恢复**,或 BPF verifier 在加载时对已验证路径的 replay——不重新执行真实副作用,只重放控制流以到达断点。

### 4.4 重放时断点的坑(重要)

重放已完成 step 时,**编排函数的控制流会再次经过该 step 的调用点**,因此:

- 你在该 step 函数体内部设的源码断点**会被命中**(控制流确实经过了),但 step 体的业务代码**并未真正执行**(SDK 直接返回缓存结果)。这极易让人误判"step 又跑了一遍"。
- 真正的副作用(写 Product Store、调 Provider)不会重复——因为 step 体没执行,`runStep` 里的 `fn()` 不会被调用,`ctx.api.*` 也不会被调用。

调试时若看到断点命中但变量值"凭空出现",先确认是不是重放在返回缓存——判断依据是该 step 是否已有 `.locks/steps/*.terminal` 标记或 `steps/wrun_*-step_*.json`。

---

## 5. Hook 耐久等待与恢复

### 5.1 机制定位

Hook 是 Workflow 的**耐久等待原语**:编排函数可以挂起在一个 Hook 上,等待外部事件唤醒,且挂起期间进程崩溃也不丢失等待状态。内核开发者最贴切的类比是 **`wait_event_interruptible()` + `complete()`** 组合,或 futex 的内核侧等待队列。

### 5.2 定义与创建

Hook 在 [planning-execution-workflow.ts:48](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L48) 定义:

```typescript
const planDecisionHook = defineHook({ schema: planDecisionHookPayloadSchema });
```

`defineHook` 类似 `DECLARE_WAIT_QUEUE_HEAD`,声明一个带 payload schema 的 Hook 类型。payload schema 见 [workflow-input.ts:27-34](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-input.ts#L27),只携带 `productRunId`、`approvalRequestId`、`decisionId` 三个引用——不携带决定正文,恢复后再从 Product Store 重读。

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

逐步对应内核概念:

| 代码 | 内核类比 |
|---|---|
| `planDecisionHook.create({ token })` | 初始化一个 waitqueue entry 并入队;`token` 是确定性句柄 |
| `decisionHook.getConflict()` | 检查 waitqueue 是否已有冲突等待者(类似检测竞争条件) |
| `claimDecisionHookStep` 注册 binding | 把等待者登记到耐久存储,保证崩溃后仍可被唤醒 |
| `await decisionHook` | `wait_event_interruptible(wq, condition)`——挂起当前 task,让出调度 |
| 外部 `complete()` 唤醒 | Runtime 收到 Resume Outbox 后恢复 Hook,等价于 `wake_up` / `complete()` |
| `Promise.race([... sleep(expiresAt)])` | `schedule_timeout_interruptible()` + 定时器,超时保护 |

### 5.3 确定性 Token

Hook token 由 [workflow-input.ts:39-41](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-input.ts#L39) 生成:

```typescript
export function decisionHookToken(productRunId: string, planRevision: number): string {
  return `pdh-${productRunId}-${String(planRevision)}`;
}
```

这是**纯函数推导的确定性句柄**——同一 Product Run 的同一 Plan 修订永远得到同一 token。好处:崩溃重启后,Runtime 凭 `productRunId + planRevision` 即可重建 token 找回 Hook,无需持久化随机 ID。这类似内核里用 `(dev_t, ino_t)` 推导确定性句柄,而非生成 UUID。

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

这是 `approvalExpiresAt`(审批有效期,约 24 小时)的硬超时保护,内核里对应 `schedule_timeout` 到期后由定时器唤醒并执行清理路径。

### 5.6 唤醒后恢复

Hook 被 resume 后,`await decisionHook` 返回 `resumeSignal`(payload,含 `decisionId`)。编排函数随后调 `loadCommittedDecisionStep`([planning-execution-workflow.ts:244-261](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L244)、[workflow-decision-steps.ts:83-127](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-decision-steps.ts#L83))**从 Product Store 重读**已提交的决定事实,而非信任 Hook payload 里的内容。这呼应产品不变量"模型输出只是候选":Hook 只携带信号,权威事实永远从 Product Store 读。

---

## 6. 断点调试的原理和坑

### 6.1 Inspector 端口

Workflow Runtime 的调试端口 `43121` 由 [scripts/dev/app-runtime.mjs:144](file:///Users/xulater/Code/Chat/scripts/dev/app-runtime.mjs#L144) 通过 `--inspect=127.0.0.1:${workflowInspector}` 注入,`workflowInspector = 43121`(见 [scripts/debug/lib.mjs:32](file:///Users/xulater/Code/Chat/scripts/debug/lib.mjs#L32))。这是 Node.js 的 V8 Inspector,即 Chrome DevTools Protocol(CDP)服务端。VS Code 通过 CDP 附加到该端口,即可在 TypeScript/JavaScript 源码上设断点、单步、查看变量。

调试模式下,API 进程的 Inspector 在 `43120`,Workflow 在 `43121`,Memory 第三方进程不开放 Inspector([scripts/dev/app-runtime.test.mjs:64-68](file:///Users/xulater/Code/Chat/scripts/dev/app-runtime.test.mjs#L64) 验证)。

### 6.2 为什么 `"use workflow"` / `"use step"` 函数体的源码断点不命中

这是调试时最容易踩的坑。根本原因:

1. 这些函数体被 SWC 转换 + 打包进了 `.workflow-bundle/workflows.mjs` 或 `steps.mjs`(见第 2 节)。运行时实际执行的是 bundle 里的转换后代码,不是 `packages/workflows/src/*.ts` 源码。
2. bundle 没有附带 sourcemap(`.debug.json` 不是 sourcemap,见第 2.2 节),VS Code 无法把 bundle 的执行位置映射回 TS 源行号。
3. 因此你在 `planning-execution-workflow.ts` 第 95 行、或 `beginPlanningContextStep` 第 223 行设的断点,**实际执行流根本不会停在那里**——因为执行的是 `workflows.mjs` / `steps.mjs` 里的对应代码,而那部分代码没有源码映射。

内核类比:**eBPF 程序经 JIT 编译为本机码后,无法在 C 源码上设断点**——因为执行的是 JIT 后的机器指令,与源码行号已无映射。要调试 eBPF,只能用 `bpf_trace_printk` 或 map 观察副作用;同理,要调试 bundle 内的 workflow,只能观察其副作用。

### 6.3 为什么 `api-client.ts` 等外部模块断点能命中

对照之下,[api-client.ts](file:///Users/xulater/Code/Chat/packages/workflows/src/api-client.ts) 里的 `call()` 函数([api-client.ts:112-165](file:///Users/xulater/Code/Chat/packages/workflows/src/api-client.ts#L112))、`createRuntimeApiClient`([api-client.ts:167](file:///Users/xulater/Code/Chat/packages/workflows/src/api-client.ts#L167))断点可以命中。原因:

- `externalizeNonSteps: true` 让 `api-client.ts` **不打进 bundle**,以 `import` 引用保留(见第 2.3 节)。
- 运行时进程([runtime-main.ts](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-main.ts))通过 `tsx` 启动,`tsx` 会把 TS 源码即时转译执行,保留了源码位置信息。
- 因此 VS Code 的断点直接绑定到 `packages/workflows/src/api-client.ts` 的 TS 源行,执行流经过时即命中。

同理可命中断点的外部模块:`runtime-context.ts`、`runtime-server.ts`、`workflow-world.ts`、`@chat/pi-runtime`、`@chat/memory-runtime`、`@chat/application` 等所有没被打进 bundle 的模块。

### 6.4 推荐调试策略

既然 bundle 内断点不命中,就把断点设在**外部模块**上,作为观察工作流执行的侧信道:

| 想观察什么 | 在哪里设断点 |
|---|---|
| step 调用了哪些后端命令、参数是什么 | [api-client.ts](file:///Users/xulater/Code/Chat/packages/workflows/src/api-client.ts) 各 `call()` 调用处(如 [api-client.ts:372-378](file:///Users/xulater/Code/Chat/packages/workflows/src/api-client.ts#L372) `beginPlanningContext`) |
| step 的 Trace 事件 | [workflow-step-support.ts:51-72](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-step-support.ts#L51) `runStep` 内 `emitStepTrace` 调用 |
| Hook 注册与恢复 | [workflow-decision-steps.ts:12-42](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-decision-steps.ts#L12) `claimDecisionHookStep`、[workflow-decision-steps.ts:83-127](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-decision-steps.ts#L83) `loadCommittedDecisionStep` |
| Runtime 启动恢复 | [runtime-server.ts:111-158](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L111) `beforeStart` 安全门、[workflow-world.ts:154](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L154) `world.start?.()` |
| 进程级上下文注入 | [runtime-context.ts:43-53](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-context.ts#L43) `setWorkflowRuntimeContext` / `getWorkflowRuntimeContext` |
| Planner / Executor 模型调用 | `ctx.planner` / `ctx.executor` 注入点([runtime-server.ts:101-103](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L101))及 `@chat/pi-runtime` 实现 |

这种策略类似用 **ftrace / bpftrace 观察 eBPF 程序的副作用**:不直接单步 JIT 代码,而是在它调用的内核函数上埋点。`ctx.api.*` 是 step 与外部世界唯一的副作用出口(见 [runtime-context.ts:23-35](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-context.ts#L23) 的 `WorkflowRuntimeContext` 接口),在这里断点能完整还原 step 的行为。

### 6.5 重放断点的额外坑

结合第 4.4 节:即使断点设在能命中的外部模块,重放时也要小心。重放已完成 step 时,SDK 直接返回缓存,**不会调用 `ctx.api.*`**,因此你在 `api-client.ts` 上的断点在重放阶段**不会命中**。若你期望命中却没命中,先确认该 step 是否正在被重放(检查 `.locks/steps/*.terminal` 是否存在)。

---

## 7. 内核概念映射总结表

下表汇总 Vercel Workflow 各概念到内核/系统编程概念的映射,便于内核开发者建立整体心智模型。

| Vercel Workflow 概念 | 内核 / 系统编程类比 | 项目源码位置 |
|---|---|---|
| `"use workflow"` 指令 | `SEC("bpf/...")` 段标记 / `__init` 注解,标识耐久编排函数入口 | [planning-execution-workflow.ts:95](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L95) |
| `"use step"` 指令 | 耐久边界注解,转换器在此插桩 checkpoint(类似 verifier 重写) | [workflow-planning-steps.ts:223](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-planning-steps.ts#L223) 等处 |
| SWC 转换 + 打包 | `gcc -c` 编译 + `ld` 链接;转换器重写 AST 如 verifier 重写 BPF 字节码 | [build-bundles.ts:85-100](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L85) |
| `workflows.mjs` / `steps.mjs` bundle | 静态链接的 `.ko` 内核模块 / ELF 可执行体 | [build-bundles.ts:27-28](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L27) |
| `externalizeNonSteps: true` | `ld -lsomelib` 动态链接,符号运行时解析;external 模块 = `.so` | [build-bundles.ts:90](file:///Users/xulater/Code/Chat/packages/workflows/scripts/build-bundles.ts#L90) |
| `*.debug.json` | 构建元数据(非 sourcemap),不映射回源码 | `.workflow-bundle/workflows.mjs.debug.json`(SDK 自动产出) |
| Checkpoint(每个 step 后) | suspend-to-disk(ACPI S4 / swsusp)/ kdump crash dump | `.data/workflow/steps/wrun_*-step_*.json` |
| `runs/wrun_*.json` | task 的 `struct task_struct` 快照(Run 状态机) | `.data/workflow/runs/` |
| `events/wrun_*-evnt_*.json` | append-only audit log / `printk` ring buffer 持久化 | `.data/workflow/events/` |
| `.locks/*.terminal` / `.disposed` / `.completed` | flock / futex 的持久化终态标记 | `.data/workflow/.locks/` |
| Replay(重放) | CRIU restore / BPF verifier replay / kexec 恢复;不重放副作用,只重放控制流 | [workflow-world.ts:154](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L154) `world.start?.()` |
| `recoverActiveRuns: true` | boot 时恢复(pmdisk / swsusp resume) | [runtime-server.ts:110](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L110) |
| `beforeStart` 安全门 | boot 时硬件/版本检测,失败即 panic 不带病启动 | [runtime-server.ts:111-158](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-server.ts#L111) |
| LocalWorld | 单机调度器实例(单 CPU runqueue) | [workflow-world.ts:137-141](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L137) |
| `registerHandler` | 注册中断/系统调用 handler | [workflow-world.ts:146-150](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L146) |
| `setWorld(world)` | 安装全局调度器(类似 `swapper` 启动) | [workflow-world.ts:151](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-world.ts#L151) |
| `defineHook` | `DECLARE_WAIT_QUEUE_HEAD` | [planning-execution-workflow.ts:48](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L48) |
| `planDecisionHook.create({ token })` | 初始化 waitqueue entry 入队 | [planning-execution-workflow.ts:200-202](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L200) |
| `await decisionHook` | `wait_event_interruptible(wq, cond)` 让出调度 | [planning-execution-workflow.ts:222-225](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L222) |
| 外部 Resume 唤醒 Hook | `complete()` / `wake_up()` | 经 Runtime HTTP 分发恢复 |
| `claimDecisionHookStep` 注册 binding | 把等待者登记到耐久存储,崩溃后仍可唤醒 | [workflow-decision-steps.ts:22-28](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-decision-steps.ts#L22) |
| 确定性 Hook token | 用 `(dev_t, ino_t)` 推导确定性句柄,而非 UUID | [workflow-input.ts:39-41](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-input.ts#L39) |
| `Promise.race([hook, sleep(expiresAt)])` | `schedule_timeout_interruptible()` + 定时器超时保护 | [planning-execution-workflow.ts:222-241](file:///Users/xulater/Code/Chat/packages/workflows/src/planning-execution-workflow.ts#L222) |
| `step.run` / `runStep` | tracepoint 包装,发射 Trace;checkpoint 在外层 SDK 边界 | [workflow-step-support.ts:51-72](file:///Users/xulater/Code/Chat/packages/workflows/src/workflow-step-support.ts#L51) |
| `ctx.api.*` | `call_usermodehelper` —— 内核态调用用户态服务;step 与外部世界唯一副作用出口 | [api-client.ts:112-165](file:///Users/xulater/Code/Chat/packages/workflows/src/api-client.ts#L112) `call()` |
| `ctx` 挂在 `globalThis[Symbol.for(...)]` | 全局共享变量,因 bundle 独立模块实例需跨模块共享 | [runtime-context.ts:37-53](file:///Users/xulater/Code/Chat/packages/workflows/src/runtime-context.ts#L37) |
| `--inspect=127.0.0.1:43121` | V8 Inspector / CDP(类似 ftrace 可单步版) | [scripts/dev/app-runtime.mjs:144](file:///Users/xulater/Code/Chat/scripts/dev/app-runtime.mjs#L144) |
| bundle 内断点不命中 | eBPF JIT 后本机码无法用源码断点(无 sourcemap) | 见第 6.2 节 |
| external 模块断点命中 | 解释执行(`tsx`),保留源码位置,可断点 | 见第 6.3 节 |

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
