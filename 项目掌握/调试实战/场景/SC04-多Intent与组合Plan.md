# SC04：多Intent与组合Plan

<!-- debug-scenario: id=SC04; status=current; oracle=semantic -->

**归档日期**：2026-07-30  
**输入族**：一句话包含2–4个可区分目标，至少一个目标需要规划  
**自动证据**：`test_continuous_workflow_preserves_multi_intent_set_through_plan_and_execution_draft`、`test_multi_intent_plan_and_response_receive_the_completed_project_catalog_fact`

**教材成熟度**：L1+；已有完整受控数据和精确Store断言，尚无同版本真实多Intent Run，不能标L2。

## 0. 本场景在公共主干哪里分叉

节点6开始形成多个Intent候选，节点7投影为带顺序/依赖的Intent Set；节点16的默认路径因组合目标强制进入
节点19–20的Plan。MAF只负责按图送达消息，Intent revision、组合规划规则、权威Project查询结果和候选提交边界
都是Chat实现。先在公共断点看同一Product Run，再从`intent_agent -> intent_set_projection -> planning_agent`
连3个场景断点，不要把一句Prompt误当一个Intent对象。

## 1. 可自由替换的输入

例如：`先列出正式项目，再用一句话解释斐波那契；不要创建新项目。`

可以替换两个目标的正文，但要保持“多个目标、顺序明确、无写副作用”这个输入族。超过4个目标、目标互相
冲突或依赖不清时，正确预期是澄清/收窄，而不是无限扩张Intent Set。

## 2. 运行前预言机

| 项 | 预期 |
|---|---|
| Intent Set | 2–4个不可变Intent revisions，保留顺序、依赖和来源 |
| 权威查询 | Project目录目标由确定性查询完成，结果作为只读事实交给Planner |
| Plan | 即使基础协议通常不规划，多Intent组合覆盖也必须进入`planning_agent` |
| 执行 | 本例为`answer_only`；不得因为出现“项目”就创建Project/Work |
| 结果 | 两个目标分别可判定；允许部分结果文本不同，来源不能混淆 |
| 模型调用 | 测试场景为Intent/Planner/Response/Summary 4次；真实Prompt改变场景后次数可变 |

## 3. 节点路径

```text
S1节点1–5
-> S2节点6–15（Intent Set、Project/Work绑定、详情Context、协议）
-> 节点16 scenario_router
-> 节点19 planning_agent
-> 节点20 plan_acceptance
-> 节点21–24 ExecutionDraft/授权/RunSpec/answer_only
-> 节点32–39 响应、摘要、候选决定、提交与终态
```

节点17不会作为根图的终结分支被单独走完，但“列项目”子目标的权威结果必须先由Product查询形成，再装入
Planner/Response的`authoritative_product_facts.project_catalog`。节点18、25–31不走。

## 4. 关键数据结构

Intent Set示意：

```json
{
  "combination_policy": "ordered",
  "intents": [
    {"branch_key": "view_catalog", "query_kind": "project_catalog", "needs_plan": false},
    {"branch_key": "explain_fibonacci", "query_kind": null, "needs_plan": false,
     "dependency_branch_keys": ["view_catalog"]}
  ]
}
```

组合Plan必须显式引用两个`branch_key`，不能把两个目标压成一段无法分别判定的Prompt。ExecutionDraft中的
权威Project目录事实来自产品查询，模型只能消费，不能改写。

## 5. 为什么需要组合Plan

看似更简单的方案是逐句调用两个Agent再拼接文本。它无法表达目标依赖、部分成功、来源隔离和后续Evidence；
也可能让第2个Agent把第1个模型文字误当权威事实。组合Plan用稳定Intent revision和依赖组织一次Run，代价是
多一次Planner调用与Plan治理。

## 6. 亲手验证

断点：`IntentProjectionExecutor`、`ScenarioRouterExecutor.route`、`planning_agent`的
`GovernedSemanticAgentExecutor._deliver`、`ExecutionDraftCompilerExecutor`。

重点观察：

```text
Intent Set中的branch_key顺序
Plan是否覆盖全部branch_key
authoritative_product_facts.project_catalog.source_id
ExecutionDraft/RunSpec的revision/hash
最终是否创建Project/Work/Memory
```

自动复验：

```bash
.venv/bin/python -m pytest -q \
  backend/tests/test_continuous_chat.py::test_continuous_workflow_preserves_multi_intent_set_through_plan_and_execution_draft \
  backend/tests/test_continuous_chat.py::test_multi_intent_plan_and_response_receive_the_completed_project_catalog_fact
```

## 7. 判定

- 通过：目标保持独立、Plan有依赖、权威目录不由模型编造、无未授权长期写入。
- 失败：只保留一个Intent；把Project查询结果变成模型自由文本；一个目标失败导致另一个目标被伪装完成。

## 7. 受控运行里的实打实数据

自动用例固定输入：`先学习Outbox，再把它应用到Chat项目，但先不要改代码。`

```json
{
  "combination_policy": "sequential",
  "execution_order": ["learn_outbox", "apply_chat"],
  "intent_1": {
    "goal": "学习Outbox恢复语义",
    "dependency_branch_keys": [],
    "constraints": ["先学习，不改代码"]
  },
  "intent_2": {
    "goal": "把恢复语义应用到Chat",
    "dependency_branch_keys": ["learn_outbox"],
    "constraints": ["没有授权前不修改代码"]
  },
  "protocol": {
    "base_planner": "enabled",
    "effective_planner": "required_for_intent_set"
  },
  "model_calls": 4
}
```

4次调用按顺序是Intent、Planner、Response、Summary。ExecutionDraft里的`intent_goal.intents`长度精确为2，
`plan.text`等于获接受的Plan；Project目录若是子目标，确定性查询结果放进
`authoritative_product_facts.project_catalog`，而不是让Planner重猜。

```mermaid
flowchart LR
  U["一句输入"] --> S["Intent Set: 2 branches"]
  S --> O["依赖顺序 learn→apply"]
  O --> P["Protocol强制Planner"]
  P --> PL["Plan revision"]
  PL --> D["ExecutionDraft保留2个目标"]
```

## 8. 断点导航与安全修改

| 断点 | 进入前事实 | 观察变量 | 正常下一跳 |
|---|---|---|---|
| `IntentSetProjectionExecutor` | 模型候选已解码 | intents、branch keys、dependencies | Intent Set Store |
| `IntentSetAcceptanceExecutor` | candidate revision存在 | execution_order、Decision | Project Resolver |
| `CollaborationProtocolResolverExecutor` | Intent Set已接受 | base/effective policy、overlay | Scenario Router |
| `ScenarioRouterExecutor` | `intent_count=2` | planning Case为何命中 | Planning Agent |
| `ExecutionDraftCompilerExecutor` | Plan已接受 | payload内2个Intent/Plan/事实 | Execution Authorization |

源码入口：[`continuous_chat.py`](../../../backend/app/workflows/continuous_chat.py)、
[`collaboration_intents/service.py`](../../../backend/app/collaboration_intents/service.py)、
[`collaboration_protocols/service.py`](../../../backend/app/collaboration_protocols/service.py)。

增加`parallel`组合策略时必须补：依赖环检测、可并发判定、部分失败语义、ExecutionDraft表达和恢复测试。仅让模型返回
`parallel`字符串不算实现。

## 掌握验收

1. 多Intent为何不能只用一个更长Prompt代替？
2. Product目录子目标的事实由谁拥有？
3. 基础协议不需要Plan时，为什么本轮仍可强制组合Plan？
