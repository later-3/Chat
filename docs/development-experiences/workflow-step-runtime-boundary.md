# Workflow Step复用与Registry依赖必须保持运行时边界

## 现象与影响

2026-09-03实现Workflow调用Workflow时，源码、定向单元测试和TypeScript检查均通过，但Nitro `LocalBuilder(dev=true)`先后暴露三类真实链路故障：

1. Workflow bundle错误追踪到Pi、Mem0、文件系统和原生ONNX依赖，产生257个Node模块/可选依赖构建错误。
2. 拆开Step依赖后，Nitro开发Worker在初始化阶段报`init_chat_config is not a function`和`init_registry is not a function`。
3. Worker启动后，Coordinator Step找不到`workflow-delegation/SKILL.md`；Run在人工批准后进入`failed`。

这些错误都发生在Planner成功和用户批准之后。如果只测普通Workflow、类型检查或生产Build，用户会在最关键的委托阶段才看到失败。

## 已验证的直接根因

### 1. Step文件混入普通导出

为复用计划审核，把通用规划函数作为普通`export`放在已有`steps.ts`中。Workflow Builder只会把`"use step"`函数替换成Workflow沙箱中的代理；为了保留普通导出，它必须保留同文件的函数体和静态依赖，于是`agent-definition.ts → Pi → Mem0/Node`整条后端图进入Workflow bundle。

正确边界是：被Workflow编排文件导入的Step模块只导出`"use step"`入口和类型；通用Node实现放到独立Runtime模块，只由Step入口在Node环境中调用。

### 2. 可执行Registry形成模块初始化环

中央Workflow Registry会导入每个Workflow定义和`prepareAgentSession`。Rule Tool同时静态导入Registry与Chat Config，而Chat Config又用Registry校验Workflow配置。新增Coordinator依赖改变Nitro/Rolldown的模块排序后，原有隐式环变成未初始化函数调用。

正确边界是：Registry可达的Agent装配与Tool定义不能反向静态导入Registry或Chat Config。需要目标校验、持久默认等宿主事实时，由真正执行的Step显式解析并作为窄依赖注入Tool。检查模式使用不可执行依赖，不假装能执行管理动作。

### 3. Workflow私有Skill在Step阶段才物化

开发Step bundle直接由Node加载，其中`nitro/storage`没有宿主资源能力。Coordinator第一次执行时才尝试从Server Asset读取Skill，因而失败。Workflow私有构建资源必须由Backend初始化在接受Run前物化；Step只消费已经准备好的文件路径。

## 为什么相邻验证没有发现

1. 单元测试直接调用TypeScript函数，没有经过Workflow Builder的沙箱转换。
2. `pnpm typecheck`不验证模块图属于Workflow环境还是Node Step环境。
3. 生产Nitro还会重新分块和复制Server Assets，不能替代开发Worker初始化和开发Step执行。
4. 普通Planning Workflow没有Coordinator私有Skill，也不会产生5个并行子Workflow，因此不能覆盖新拓扑。

## 正确实现与验证姿势

1. Workflow编排模块只导入纯Workflow代码、Hook和`"use step"`代理；文件系统、Pi SDK、Chat Config、Registry执行服务留在Step或Backend。
2. 可复用Step逻辑进入独立Node Runtime模块；不要从含普通运行时代码的模块同时导出Step入口。
3. Registry可达模块使用依赖注入获得反向服务，禁止形成`Registry → Agent Runtime/Tool → Config/Registry`静态环。
4. Workflow私有Skill由Backend初始化统一物化，执行与Resolve共用同一Agent装配函数。
5. 子Workflow测试必须走人工审核和真实Pi Tool Calling，不能直接调用`callChatWorkflow()`冒充模型行为。
6. 每次调用使用独立Subsession；断言批准前为0、批准后数量精确、父子关系和每个Run/Invocation ID均唯一。

## 自动化门禁

- `workflow-builder-compatibility.test.mjs`构建真实Nitro开发Workflow/Step bundle，并由Node加载Step产物。
- `runtime-initialization.test.mjs`断言`memory`、`rule-library`和`workflow-delegation`三个Workflow私有Skill在Step前已准备。
- `built-server.test.mjs`验证生产Registry投影和Coordinator Resolve只暴露`workflow-delegation + workflow_call`。
- `pnpm test:dev`使用本地假模型：Planner生成5个独立包，批准前0个子Session，Coordinator同轮发出5个Tool Call，5个完整子Workflow进入独立Session并全部完成。
- `workflow-call-state.test.mjs`断言关系状态只保存ID和终态，不复制任务或结果正文。
