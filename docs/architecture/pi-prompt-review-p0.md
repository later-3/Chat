# Pi Prompt Review P0能力证明

> 日期：2026-08-19
> 状态：P0能力证据，不是生产实现
> 付费Provider：未调用

## 1. 用户结果

本P0回答一个问题：Chat能否在真实Pi `AgentSession`每次即将调用模型时取得最终Provider Payload、暂停，
并在批准后只发送一次；等待期间运行时丢失后，能否从磁盘事实重建同一个未完成Turn。

P0不增加Product Run、Workflow Definition、Prompt Review API或DSH界面，也不改变现有执行流程。

## 2. 采用结论

结论是“底层机械可行，但固定Pi工件缺少生产级一体化接缝”。

可直接复用：

1. `Agent.onPayload`可以位于Extension链外形成Chat自有、fail-closed的Provider Gate。
2. Provider Adapter完成组装后的Payload可以规范化、计算Hash并在网络请求前暂停。
3. `SessionManager.open()`可以打开显式JSONL；`createAgentSession()`可以恢复历史；低层
   `Agent.continue()`可以从尾部User或Tool Result继续真实Tool loop。

不能直接当作生产完成：

1. Pi `0.84.2`的Extension Runner会吞掉`before_provider_request` handler异常，所以现有
   Journal hook不是不可绕过的请求栅栏。
2. `SessionManager.create()`在首个Assistant消息出现前不会创建JSONL；首轮审核如果只停在内存，进程退出后无Session可恢复。
3. 直接调用`session.agent.continue()`会绕过`AgentSession`私有的active/idle、retry、compaction、queue和
   `agent_settled`生命周期，P0因此关闭重试，只证明未完成Turn的底层恢复。
4. JSONL当前使用同步写入但没有显式`fsync`，本P0证明进程级恢复，不宣称掉电级耐久。

## 3. 确定性证明

测试文件：[确定性能力探针](../../packages/pi-runtime/src/prompt-review-continuation.poc.test.ts)。

它使用：

- 固定安装的真实Pi `AgentSession`；
- 真实OpenAI-compatible Payload组装与SSE解析；
- 仅监听`127.0.0.1`的计数Provider，不访问外网；
- Chat canonical Hash；
- 0600临时Review事实与Pi Session JSONL。

4个场景：

1. 首次Provider请求在网络前暂停；重复批准同一Review，服务器只收到1次请求。
2. 拒绝首次Review，服务器收到0次请求。
3. 第一次批准后模型返回Tool Call；真实Tool Result进入上下文，第二次Provider请求再次暂停，未批准前请求数保持1。
4. 首次Review等待期间保存磁盘快照、丢弃进程内Promise；新建Gate与AgentSession，从同一User尾部继续，
   重建Payload必须与已存Hash完全一致，批准后服务器总共只收到1次请求。

## 4. P0实现选择

P0在创建新Pi Session前先创建空JSONL，再用公开`SessionManager.open()`写入Header并把Session置为可追加状态。
这样首个User Message在Provider Review发生前已经进入JSONL。这个做法没有修改或复制Pi源码，但只是能力证明；
生产实现应优先获得明确的`checkpointBeforeProvider`或等价公开接缝，而不是长期依赖空文件初始化技巧。

Provider Gate安装在原Pi `onPayload`之后：先让Pi Extension完成合法Payload变换，再由Chat冻结最终Payload、计算Hash和等待决定。
Gate拒绝直接阻止Provider Adapter越过fetch边界，不依赖会吞错的Extension handler。

## 5. 进入P1前的硬门

1. 决定是否为Pi补一个通用、公开的`AgentSession.resumePendingTurn()`，复用完整Session生命周期。
2. 决定是否为Pi补一个显式Provider前Session checkpoint/flush API；若要求掉电耐久，还需定义fsync合同。
3. 在Chat Executor生产路径安装Extension链外的fail-closed Provider Gate，并修复当前Provider限额与Journal失败可被吞掉的问题。
4. 新增`waiting_prompt_review` Operation状态；等待态重启可恢复，`dispatching`后失联仍必须进入`outcome_unknown`。
5. Product Store只保存Review正文一次；Trace、Journal、Workflow Checkpoint与日志只保存引用、版本和Hash。

在以上5项完成前，本P0不得被描述为已经交付Prompt Review工作流或生产耐久暂停。
