# Workflow 尾阶段：记忆节点的分流、收尾与失败记录

## 现象、原因与边界

2026-09-26，给每个交互 Workflow 加上「会话记忆写入」尾节点后，`scripts/built-server.test.mjs` 的审核多轮场景与 `scripts/dev-server.test.mjs` 的取消子调用场景同时失败：Run 一直 `status=running`（一个还伴随 `phase=completed`），并且出现 `TypeError: Cannot read properties of undefined (reading 'match')` 与永远不结束的 HTTP 响应。

最初把原因归到「审核恢复或取消之后再 await Step 会让 SDK 不结算」。这个结论**不成立**。真正原因是两个假模型夹具都按**历史**分流：

1. `scripts/planner-conversation-fixture.mjs` 用「全部历史里是否出现 `PLANNER_CONVERSATION_`」判断是否接管请求，然后只从 `user` 消息取标记。writer 的上下文是**本轮投影**，标记可能只出现在 assistant 的工作产物里，`JSON.stringify(user?.content).match(...)` 于是对 `undefined` 调用 `match`；异常发生在异步处理函数里，HTTP 既没开始也没结束。
2. `scripts/dev-server.test.mjs` 的 `DIRECT_CALL_UI_CANCEL` 闸门只看「历史里出现标记 + 有工具结果」。工作 Agent 被放行后，writer 带着同一段历史再次进入闸门并等待一次性放行信号，而该信号只 resolve 一次，writer 永久等待。

两处都不是 Workflow/Step 合同缺陷：writer 的请求与他人共享历史，是设计使然；假模型必须按**当前阶段**分流。

## 修复

- 新增 `scripts/fake-model-stages.mjs`：以 system prompt 判定「这是不是会话记忆写入阶段」，并提供有限的文本响应与**会结束请求**的错误响应。
- 两个夹具改为阶段优先：writer 请求先被当作 writer 处理（一次写入工具调用 + 收尾文本，或普通文本），不进入工作/规划断言，也不进入取消闸门；投影/断言失败时返回 500，绝不留下悬空响应。
- 尾节点自身收紧：`tail.ts` 只做「开关判断 + 调用 Step」，不引入 Node 模块（Workflow body 禁止 Node 内置模块，Builder 门禁会拦）；事件流归属明确为「工作阶段退让、记忆阶段关闭」，由 `memoryTailFollows` / `stageFinishClosesStream` 单点决定；writer 记录的工作流身份改为**调用方 Workflow**（共享实现，不共享身份）；记忆失败时把可恢复的记录写进会话（`chat.session_memory_notice`），再抛出错误，绝不静默成功或把取消改写成成功。

## 为什么现有验证没有发现

夹具此前只面对「一个工作阶段」的请求序列，按历史分流看不出问题；而把新阶段接入同一个 Run 后，历史分流立刻把新阶段吸进旧闸门。失败表现为超时/悬空，而不是断言失败，定位成本很高。

## 正确实现与验证姿势

- 假模型按当前 Workflow/Stage/Agent 分流；每个阶段都有有限响应；一把一次性闸门只服务目标工作请求。
- 处理函数里的异常必须结束请求，否则测试会在远处超时失败。
- 尾阶段必须真实运行并被断言：`scripts/dev-server.test.mjs` 断言 writer 阶段确实发出请求、会话记忆文件真的写出内容、Run 随后 `completed`。
- 不要用 `void step`、提前完成 Run、删除 remember、吞掉断言来换取绿色。

## 自动回归

`test/workflows/session-memory-tail.test.mjs` 覆盖：尾节点记录**调用方**工作流身份、记忆失败留下 `chat.session_memory_notice` 且工作答案保留、开关关闭跳过写入、事件流关闭责任的一致性；`test/workflows/workflow-builder-compatibility.test.mjs` 守住「Workflow body 不引 Node 模块」；`scripts/dev-server.test.mjs` 与 `scripts/built-server.test.mjs` 在真实 Runtime 上覆盖审核多轮、格式修正、取消子调用与 writer 实际运行。

## 追加：同一阶段的三个接缝

尾节点落地后又暴露三个真实接缝，均与「谁拥有这份事实」有关：

1. **失败通知的可见性**：通知先只在 Workflow 的 `remember` Step 里记录，Friend 会话由 Long Agent 队列直接调用同一个 writer 普通函数，因此那条路径失败时用户什么都看不到。共享的是 writer 实现，失败记录也必须共享；且同一个会话读取会过滤 `display === false` 的消息，通知必须以可显示形态写入，并在会话尾部独立渲染（不能被回合折叠吞掉）。
2. **配置冻结**：尾阶段用调用方 Workflow id 但只把自己的 Agent 交给配置准备函数，会把工作 Agent 的配置当作不兼容而清空并追加第二份快照。后阶段只能**复用本轮已冻结的配置**。
3. **重复读取**：同一次打开可以由默认落点、点击、旧链接等多个触发者发起；每次触发都会读一遍会话，而"单次消费"的交接只能满足第一个消费者，第二个消费者于是重新下载整份会话。正确做法是让同一次导航的所有读取者共享同一份结果（按会话身份、短时失效），并在重复触发同一已打开会话时直接复用当前状态。

## 收口补证：同页连续发送与导航复用

2026-09-26 独立复核发现原浏览器用例只检查发送参数和 writer 调用次数，每个场景另开页面，并以旧答案/停止按钮消失判断完成。这掩盖了 `POST /turns` 没接 `sessionMemory` 导致关闭后的发送返回 400。现已在公共接受路由和耐久轮次解析器严格接入开关，浏览器逐轮检查 HTTP 接受结果、耐久终态、对应答案和 writer 调用，所有连续发送共用同一页面与会话。

同时，导航交接不能供轮次结束后的同步使用，否则快于缓存期限的回答会被打开时的历史覆盖；重复打开已有会话也不能跳过视图切换。公共聊天读取现在区分导航加载与最新历史重读，复用已有会话仍执行共享视图选择。`scripts/session-memory-switch-browser.test.mjs` 覆盖快速完成后的 GET 与答案保留、离开主题页后返回同一会话、关闭/开启/刷新和失败通知。

## Experience Prompt 资源

以下资源供显式导入，不自动注入 Agent。

```json
{
  "schemaVersion": 1,
  "id": "workflow-tail-stage-routing",
  "revisions": [
    {
      "schemaVersion": 1,
      "id": "workflow-tail-stage-routing",
      "revision": 1,
      "kind": "experience",
      "title": "Workflow尾阶段必须按当前阶段分流，不能按历史标记",
      "purpose": "修复多阶段Workflow的假模型误分流、悬空HTTP与Run不结算。",
      "content": "一个Workflow的最后一个节点可能是会话记忆写入，它的请求带着和上一阶段相同的对话历史。假模型若按历史标记分流，会把该阶段当成工作请求，让它在只服务工作Agent的一次性闸门上永久等待，表现为HTTP悬空、Run长期running，失败点离原因很远。正确做法是按当前Workflow/Stage/Agent（如system prompt所属Agent）分流，每个阶段给出有限且正确的响应，一次性闸门只作用于目标工作请求，处理异常必须结束请求并让测试明确失败。尾节点只做开关判断和调用Step，不在Workflow body引入Node模块；事件流由一个阶段关闭，记忆失败写入会话可恢复记录后再抛错，取消不得改写成成功，开关关闭时正常跳过。",
      "tags": [
        "workflow",
        "session-memory",
        "testing"
      ],
      "status": "active",
      "sources": [
        {
          "type": "manual",
          "entryIds": [],
          "context": "docs/development/experiences/workflow-tail-stage-routing.md",
          "capturedAt": "2026-09-26T00:00:00.000Z"
        }
      ],
      "author": {
        "type": "agent"
      },
      "createdAt": "2026-09-26T00:00:00.000Z"
    }
  ]
}
```
