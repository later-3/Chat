"""持续协作主Workflow的纯状态与确定性解析合同（服务S1-S3与S6的判定逻辑）。

本模块刻意不依赖MAF、数据库或HTTP：持久化Workflow快照可以在不构造运行时图的情况下
被解码和合同测试。39节点中所有“不调模型也能判断”的规则都收在这里——目录查询护栏、
意图规范化、场景路由求值、摘要写回边界、协议覆盖——Executor只负责编排，规则独立单测。
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from typing import Any, Mapping, Sequence

JSON_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class CollaborationState:
    """一次Run中在MAF Workflow节点之间传递的有界工作台，不是产品数据库。

    这里只携带下一个节点需要的引用和已选投影。ContextPackage、Intent Set等耐久产品对象
    存在Product Store；本状态保存其ID，使恢复后的Workflow能重新读取权威revision，而不是
    信任旧进程内存。
    """

    origin_prompt: str
    # 入口最多读取8条已持久化TurnDigest，确定性选择器再收窄为4条。这个tuple只是运行时投影；
    # 来源事实仍保存在turn_summaries表。
    recent_turn_summaries: tuple[dict[str, Any], ...] = ()
    project_candidates: tuple[str, ...] = ()
    project_matches: tuple[dict[str, Any], ...] = ()
    project_catalog_result: dict[str, Any] | None = None
    # 从当前持久ContextPackage投影出的已采用项。用户修改时不原地改这个tuple，而是先写新
    # ContextPackage revision，再由后续节点把新revision投影回来。
    context_items: tuple[dict[str, Any], ...] = ()
    # 目录Context和详情Context是两个产品对象；运行态只留ID，防止MAF Checkpoint变成第二Context事实源。
    directory_context_package_id: str | None = None
    detail_context_package_id: str | None = None
    selected_project_id: str | None = None
    intent: dict[str, Any] | None = None
    intents: tuple[dict[str, Any], ...] = ()
    intent_set_id: str | None = None
    intent_set_revision_id: str | None = None
    intent_set_revision_hash: str | None = None
    pending_clarification: dict[str, Any] | None = None
    answered_clarification: dict[str, Any] | None = None
    scenario: str = "clarify"
    protocol_selection: dict[str, Any] | None = None
    plan: str | None = None
    execution_draft_revision_id: str | None = None
    run_spec_id: str | None = None
    execution_route: dict[str, Any] | None = None
    execution_workspace: dict[str, Any] | None = None
    pi_result: dict[str, Any] | None = None
    result_claim: dict[str, Any] | None = None
    response: str | None = None
    turn_summary: dict[str, Any] | None = None
    last_model_call_revision_id: str | None = None
    harness_decision_record_ids: tuple[str, ...] = ()
    harness_commit_results: dict[str, Any] | None = None


def state_from_snapshot(value: Mapping[str, Any]) -> CollaborationState:
    """把Checkpoint中的JSON快照还原为带tuple字段的``CollaborationState``。

    MAF Checkpoint只保存JSON兼容结构；跨进程HITL恢复时必须在这里把list还原为tuple，
    否则下游``replace(state, ...)``与哈希比较会出现类型漂移。服务全部39节点的恢复路径。
    """

    restored = dict(value)
    for key in (
        "recent_turn_summaries",
        "project_candidates",
        "project_matches",
        "context_items",
        "intents",
        "harness_decision_record_ids",
    ):
        if isinstance(restored.get(key), list):
            restored[key] = tuple(restored[key])
    return CollaborationState(**restored)


def message_text(message: Mapping[str, Any]) -> str:
    """从AG-UI消息中提取纯文本；content为片段数组时拼接text片段，非文本内容返回空串。"""

    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(
        str(part.get("text") or "")
        for part in content
        if isinstance(part, Mapping) and isinstance(part.get("text"), str)
    )


def json_object(text: str) -> dict[str, Any] | None:
    """从模型可见输出中尽力解析一个JSON对象：整串、```json围栏、首尾花括号截取。

    只接受对象（dict）；全部候选解析失败返回None，由调用方决定降级或失败关闭。
    服务意图、规划、摘要等所有结构化模型输出节点（S2/S3/S6）。
    """

    candidates = [text.strip()]
    fenced = JSON_FENCE.search(text)
    if fenced:
        candidates.insert(0, fenced.group(1))
    first = text.find("{")
    last = text.rfind("}")
    if first >= 0 and last > first:
        candidates.append(text[first : last + 1])
    for candidate in candidates:
        try:
            value = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            return value
    return None


def context_keywords(text: str) -> set[str]:
    """为S1轻量召回构造有界关键词集合：拉丁词 + 2-6字CJK滑窗。

    只用于TurnSummary候选召回的相关性打分，不进入Provider请求正文。
    """

    lowered = text.lower()
    keywords = set(re.findall(r"[a-z0-9_][a-z0-9_.-]{1,}", lowered))
    for sequence in re.findall(r"[\u4e00-\u9fff]{2,}", lowered):
        for size in range(2, min(6, len(sequence)) + 1):
            keywords.update(sequence[index : index + size] for index in range(len(sequence) - size + 1))
    return keywords


def canonical_hash(value: Any) -> str:
    """对任意JSON兼容对象生成规范化SHA-256：键排序、紧凑分隔、保留中文。

    Decision Subject、协议覆盖等授权绑定都用它，防止“同义不同序”绕过Hash失效。
    """

    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def context_source_references(
    context_items: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """把已采用Context投影为稳定、无正文的来源引用（服务S6摘要节点）。

    响应Agent需要来源正文，回合摘要只需要引用“哪些不可变revision参与了本轮”。该投影
    放在合同层，保证Provider载荷与人工审核视图看到的是同一份摘要上下文描述，不会各自
    拼装而漂移。
    """

    references: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for item in context_items:
        if item.get("adopted", True) is not True:
            continue
        kind = str(item.get("source_kind") or "").strip()
        source_id = str(item.get("source_id") or "").strip()
        revision = item.get("source_revision")
        revision_key = "" if revision is None else str(revision)
        if not kind or not source_id:
            continue
        key = (kind, source_id, revision_key)
        if key in seen:
            continue
        seen.add(key)
        reference: dict[str, Any] = {
            "kind": kind,
            "id": source_id,
        }
        if revision is not None:
            reference["revision"] = revision
        for source_key, target_key in (
            ("title", "title"),
            ("reason", "adoption_reason"),
            ("selection_origin", "selection_origin"),
        ):
            value = item.get(source_key)
            if value not in (None, ""):
                reference[target_key] = value
        references.append(reference)
    return references


def summary_writeback_policy(origin_prompt: str) -> dict[str, Any]:
    """不调模型，直接从用户原话编译写回边界：“只读”“不要创建/修改/记录”等。

    按分句扫描否定写入意图，分别决定是否允许Work状态候选与Memory候选；S6/S7据此拦截
    模型提出的越界写回，防止一句“只读”请求仍产生长期状态修改。
    """

    lowered = origin_prompt.lower()
    read_only = "只读" in lowered or "read-only" in lowered or "read only" in lowered
    clauses = [value for value in re.split(r"[。！？!?\n;；]|但是|不过|然而", lowered) if value.strip()]
    negative_write = re.compile(
        r"(?:不要|不得|禁止|不允许|不能|勿|无需|不需要)"
        r".{0,16}?"
        r"(?:创建|修改|更新|写入|保存|提交|记录|维护|关联)"
    )
    work_targets = ("project", "work", "task", "项目", "任务", "事项", "工作状态")
    memory_targets = ("memory", "记忆", "长期信息", "长期状态", "偏好")
    blocked_work = read_only
    blocked_memory = read_only
    for clause in clauses:
        if negative_write.search(clause) is None:
            continue
        blocked_work = blocked_work or any(target in clause for target in work_targets)
        blocked_memory = blocked_memory or any(target in clause for target in memory_targets)
    return {
        "read_only": read_only,
        "allow_work_state_candidates": not blocked_work,
        "allow_memory_candidates": not blocked_memory,
        "source": "explicit_user_prompt",
    }


def apply_summary_writeback_policy(
    summary: Mapping[str, Any],
    *,
    origin_prompt: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """把``summary_writeback_policy``应用到模型回合摘要：丢弃越界候选并留痕。

    被压制的候选不静默消失，而是记入``discarded``，供Trace解释“模型提了但没有进入提交门”
    的原因。下游是S6决定节点与S7候选提交。
    """

    normalized = dict(summary)
    policy = summary_writeback_policy(origin_prompt)
    suppressions: list[dict[str, Any]] = []
    for field, allowed_key, category in (
        ("work_state_candidates", "allow_work_state_candidates", "suppressed_work_state_candidate"),
        ("memory_candidates", "allow_memory_candidates", "suppressed_memory_candidate"),
    ):
        candidates = normalized.get(field)
        if policy[allowed_key] or not isinstance(candidates, list) or not candidates:
            continue
        suppressions.append(
            {
                "category": category,
                "count": len(candidates),
                "reason": "用户明确要求只读或禁止该类Product写回",
            }
        )
        normalized[field] = []
    if suppressions:
        discarded = normalized.get("discarded")
        normalized["discarded"] = [
            *(discarded if isinstance(discarded, list) else []),
            *suppressions,
        ]
    return normalized, suppressions


def apply_intent_set_protocol_overlay(
    selection: Mapping[str, Any],
    intents: tuple[Mapping[str, Any], ...],
) -> dict[str, Any]:
    """把一份持久协议选择编译为本轮有效策略（服务S2协议解析节点）。

    基础协议的``definition_hash``/``selection_hash``保持不变；当一句话含多个Intent时，
    即使基础协议通常免规划，本轮也必须形成组合计划——覆盖层只记录这一运行时要求，不伪装
    成选择了新的持久协议revision。覆盖是刻意收窄的：只打开既有planner角色，不合并异构
    协议规则，不授予额外Tool、写回权限或副作用。``effective_selection_hash``由源Hash与
    覆盖内容重算，保证审批绑定的是本轮真实生效的策略。
    """

    effective = dict(selection)
    if len(intents) <= 1:
        return effective

    base_execution_policy = dict(effective.get("execution_policy") or {})
    allowed_roles = [
        str(role)
        for role in base_execution_policy.get("allowed_roles") or []
        if isinstance(role, str) and role
    ]
    if "planner" not in allowed_roles:
        allowed_roles.append("planner")
    effective_execution_policy = {
        **base_execution_policy,
        "planner": "required_for_intent_set",
        "allowed_roles": allowed_roles,
    }
    overlay = {
        "kind": "intent_set",
        "reason": "Intent Set含多个目标，必须先形成组合计划",
        "intent_count": len(intents),
        "branch_keys": [str(value.get("branch_key") or "") for value in intents],
        "scenario_kinds": [str(value.get("scenario") or "") for value in intents],
        "source_protocol_key": effective.get("protocol_key"),
        "source_definition_id": effective.get("definition_id"),
        "source_definition_hash": effective.get("definition_hash"),
    }
    effective["base_execution_policy"] = base_execution_policy
    effective["execution_policy"] = effective_execution_policy
    effective["composition_overlay"] = overlay
    effective["effective_selection_hash"] = canonical_hash(
        {
            "source_selection_hash": effective.get("selection_hash"),
            "execution_policy": effective_execution_policy,
            "composition_overlay": overlay,
        }
    )
    return effective


def project_hint(summary: Mapping[str, Any]) -> str | None:
    """从TurnSummary提取Project提示；兼容旧版嵌套结构，空白值统一归一为None。"""

    direct = summary.get("project_hint")
    nested = summary.get("summary")
    nested_hint = nested.get("project_hint") if isinstance(nested, Mapping) else None
    value = direct or nested_hint
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def is_pending_clarification(summary: Mapping[str, Any]) -> bool:
    """判断一条历史TurnSummary是否留有未回答澄清；S1据此把开放问题带回下一轮。"""

    nested = summary.get("summary")
    return bool(isinstance(nested, Mapping) and nested.get("awaiting_user_answer") is True)


def is_project_catalog_query(text: str) -> bool:
    """确定性护栏：判断用户原话是否为“明确的正式Project目录查询”（S2意图节点短路用）。

    设计取向是宁缺勿滥：只命中枚举句式与全匹配正则；漏网的同义表达交给模型意图合同的
    ``query_kind``兜底，两条路最终进入同一条0模型目录分支。匹配前先做否定消解——
    “只查看，不要创建任何事项”中的“创建”不能被误判成创建意图（有专项测试）。
    """

    # DEBUG-BREAKPOINT-NOTE: BP-21
    # DEBUG-BREAKPOINT-NOTE: 触发: 判断用户输入是否是项目目录查询时触发。
    # DEBUG-BREAKPOINT-NOTE: 触发: 由ScenarioRouterExecutor.route（BP-16）调用，作为路由判断的契约函数之一。
    # DEBUG-BREAKPOINT-NOTE: 频率: 每条用户消息触发1次（路由判断时）
    breakpoint()  # DEBUG-BREAKPOINT: BP-21
    compact = re.sub(r"[\s，,。.!！?？:：;；]", "", text).lower()
    if not compact or "项目" not in compact:
        return False
    # “只查看，不要创建任何事项”这类安全指令强化只读目录查询；不能只因句中出现
    # “创建”动词就误判成创建请求。
    creation_scan = re.sub(
        r"(?:不要|不需要|无需|不用|不能|不得|禁止|别|不)"
        r"(?:再|自动)?(?:新建|创建|新增|开始一个)"
        r"(?:任何|新的|新|一个)?(?:项目|任务|事项)?",
        "",
        compact,
    )
    if any(value in creation_scan for value in ("新建", "创建", "开始一个", "新增")):
        return False
    query_scan = creation_scan
    exact = {
        "我有哪些项目",
        "我有项目吗",
        "我有什么项目",
        "我有多少项目",
        "有哪些项目",
        "查看项目",
        "查看项目列表",
        "看看项目列表",
        "列出项目",
        "列出我的项目",
        "显示项目列表",
        "我的项目",
        "项目列表",
    }
    if query_scan in exact:
        return True
    if any(value in query_scan for value in ("有哪些项目", "有什么项目", "多少个项目")):
        return True
    if "项目列表" in query_scan and any(
        value in query_scan for value in ("查看", "看看", "列出", "显示", "想要", "想看")
    ):
        return True
    return bool(
        re.fullmatch(
            r"(?:请|请帮我|帮我)?(?:查看|看看|列出|显示)(?:一下)?"
            r"(?:我的|现有|当前|所有)?项目(?:列表)?",
            query_scan,
        )
        or re.fullmatch(
            r"(?:我)?(?:目前|现在|当前)?有(?:哪些|什么|多少个?)项目",
            query_scan,
        )
    )


def project_catalog_intent(prompt: str) -> dict[str, Any]:
    """为目录查询构造确定性Intent：confidence=1.0、无需计划、只读约束，供S2直接落库。"""

    return {
        "branch_key": "intent_1",
        "scenario": "simple_question",
        "query_kind": "project_catalog",
        "goal": "查看现有项目列表",
        "confidence": 1.0,
        "project_hint": None,
        "needs_plan": False,
        "needs_clarification": False,
        "clarification_question": None,
        "context_keywords": ["项目", "列表"],
        "reason_summary": f"用户已明确要求查询现有项目，不涉及新建或执行：{prompt}",
        "expected_outcome": "返回Product Harness中的正式项目目录",
        "dependency_branch_keys": [],
        "constraints": ["只读查询，不创建Project或Work"],
        "answers_clarification_id": None,
    }


def render_project_catalog_result(
    projects: Sequence[Mapping[str, Any]],
    candidates: Sequence[str],
) -> dict[str, Any]:
    """渲染一次权威Project目录查询结果，供模型与UI复用同一份描述（服务S3节点17）。

    三种情况诚实区分：有正式Project逐条列出；正式目录为空但对话中有候选时明确“这些只是
    候选，还不是正式Project”；两者皆空则直接说空。候选与事实的边界写进答复本身。
    """

    normalized_projects = [dict(value) for value in projects]
    if normalized_projects:
        rendered = "\n".join(
            f"- {value['title']}（{value['kind']} · {value['status']}）：{value['goal']}"
            for value in normalized_projects
        )
        response = f"当前共有 {len(normalized_projects)} 个正式 Project：\n{rendered}"
    elif candidates:
        rendered = "、".join(candidates)
        response = (
            "当前还没有已创建的正式 Project。"
            f"最近对话中识别到 {len(candidates)} 个 Project 候选：{rendered}。"
            "这些只是对话摘要中的候选，还没有成为正式 Project。"
        )
    else:
        response = "当前还没有已创建的正式 Project。最近对话中也没有识别到可供确认的 Project 候选。"
    return {
        "source_kind": "product_query",
        "source_id": "project_catalog",
        "query_status": "completed",
        "formal_project_count": len(normalized_projects),
        "formal_projects": normalized_projects,
        "conversation_project_candidates": list(candidates),
        "assistant_response": response,
    }


def normalize_intent_candidates(
    parsed: Mapping[str, Any] | None,
    *,
    origin_prompt: str,
) -> tuple[dict[str, Any], ...]:
    """规范化模型意图输出：兼容多Intent新合同与单Intent旧合同，失败关闭为1条澄清候选。

    该纯边界不发明Project绑定、不静默丢弃非法分支；任何结构、置信度或依赖非法都返回
    confidence=0的澄清候选，由S3澄清分支向用户索取新信息。服务S2意图投影节点。
    """

    raw_values: list[Mapping[str, Any]]
    if parsed is None:
        raw_values = []
    elif isinstance(parsed.get("intents"), list):
        raw_values = [value for value in parsed["intents"] if isinstance(value, Mapping)]
        if len(raw_values) != len(parsed["intents"]):
            raw_values = []
    else:
        raw_values = [parsed]
    if not raw_values or len(raw_values) > 4:
        return (_invalid_intent(origin_prompt, "意图输出为空或超过单轮4个分支上限"),)

    allowed = {
        "simple_question",
        "continue_project",
        "new_task",
        "plan_request",
        "learning",
        "clarify",
    }
    result: list[dict[str, Any]] = []
    branch_keys: set[str] = set()
    for ordinal, raw in enumerate(raw_values):
        scenario = str(raw.get("scenario") or "")
        confidence = raw.get("confidence")
        if (
            scenario not in allowed
            or not isinstance(confidence, (int, float))
            or not 0 <= float(confidence) <= 1
        ):
            return (_invalid_intent(origin_prompt, "意图场景或置信度无效"),)
        goal = str(raw.get("goal") or "").strip()
        if not goal:
            return (_invalid_intent(origin_prompt, "意图目标为空"),)
        branch_key = str(raw.get("branch_key") or f"intent_{ordinal + 1}").strip()
        if not branch_key or branch_key in branch_keys:
            return (_invalid_intent(origin_prompt, "Intent branch_key为空或重复"),)
        branch_keys.add(branch_key)
        dependencies = raw.get("dependency_branch_keys") or []
        if not isinstance(dependencies, list) or not all(isinstance(value, str) for value in dependencies):
            return (_invalid_intent(origin_prompt, "Intent依赖结构无效"),)
        known_dependencies = branch_keys - {branch_key}
        if any(value not in known_dependencies for value in dependencies):
            return (_invalid_intent(origin_prompt, "Intent依赖必须指向更早分支"),)
        needs_clarification = bool(raw.get("needs_clarification") or scenario == "clarify")
        question = str(raw.get("clarification_question") or "").strip() if needs_clarification else ""
        result.append(
            {
                **dict(raw),
                "branch_key": branch_key,
                "scenario": scenario,
                "goal": goal,
                "expected_outcome": str(raw.get("expected_outcome") or goal).strip(),
                "confidence": float(confidence),
                "needs_plan": bool(raw.get("needs_plan")),
                "needs_clarification": needs_clarification,
                "clarification_question": (
                    question or "你希望我接下来具体推进哪件事？" if needs_clarification else None
                ),
                "context_keywords": _string_values(raw.get("context_keywords")),
                "dependency_branch_keys": list(dependencies),
                "constraints": _string_values(raw.get("constraints")),
                "reason_summary": str(raw.get("reason_summary") or "模型未提供判断摘要").strip(),
                "answers_clarification_id": (
                    str(raw.get("answers_clarification_id")).strip()
                    if raw.get("answers_clarification_id")
                    else None
                ),
            }
        )
    return tuple(result)


def _invalid_intent(origin_prompt: str, reason: str) -> dict[str, Any]:
    """构造“失败关闭”的澄清候选：模型输出不可用时不猜意图，把问题交回用户。"""

    return {
        "branch_key": "intent_1",
        "scenario": "clarify",
        "query_kind": None,
        "goal": origin_prompt,
        "expected_outcome": "补充足够信息后再继续",
        "confidence": 0.0,
        "project_hint": None,
        "needs_plan": False,
        "needs_clarification": True,
        "clarification_question": "我还不能可靠判断你希望继续哪件事，可以补充目标或相关项目吗？",
        "context_keywords": [],
        "dependency_branch_keys": [],
        "constraints": [],
        "reason_summary": f"{reason}，关闭失败为澄清。",
        "answers_clarification_id": None,
    }


def _string_values(value: Any) -> list[str]:
    """把任意输入收敛为非空字符串列表；非法项丢弃，用于keywords/constraints字段。"""

    if not isinstance(value, list):
        return []
    return [str(item).strip() for item in value if isinstance(item, str) and item.strip()]


def needs_plan(state: CollaborationState) -> bool:
    """MAF SwitchCase共用的规划判定谓词（S3 scenario_router第3条候选边）。

    多Intent、new_task/plan_request/continue_project场景，或单Intent自报needs_plan时
    为True。谓词只在这里定义一次，图工厂直接引用，避免路由条件两处漂移。
    """

    if len(state.intents) > 1:
        return True
    if state.scenario in {"new_task", "plan_request", "continue_project"}:
        return True
    return bool((state.intent or {}).get("needs_plan"))


def is_project_catalog_state(state: CollaborationState) -> bool:
    """判断目录分支是否必须胜出（S3 scenario_router第1条候选边的安全条件）。

    目录Executor会0模型调用地完成整个Run；只有Intent Set至多1个目标且query_kind为
    project_catalog时才是合法终态分支，否则会在规划/响应组合之前静默丢弃其余目标。
    """

    return len(state.intents) <= 1 and (state.intent or {}).get("query_kind") == "project_catalog"


def evaluate_scenario_route(state: CollaborationState) -> dict[str, Any]:
    """计算4条候选边的公开求值事实（服务S3 scenario_router的Trace与人读报告）。

    MAF按声明顺序只派发首个命中分支；把各边条件、实际值、选中目标与未走原因随Trace
    持久化，设计者界面才能同时解释选中边和备选边，而不是从节点状态倒推或编造隐藏推理。
    """

    intent = state.intent or {}
    query_kind = intent.get("query_kind")
    intent_count = max(1, len(state.intents))
    plan_required = needs_plan(state)
    matches = (
        is_project_catalog_state(state),
        state.scenario == "clarify",
        plan_required,
    )
    selected_index = next((index for index, matched in enumerate(matches) if matched), 3)
    branch_specs = (
        (
            "project_catalog",
            "查询正式Project目录",
            "project_catalog_query",
            "Intent Set仅1项目标 且 intent.query_kind = project_catalog",
            (
                query_kind
                if intent_count == 1
                else f"{query_kind or '未设置'}；Intent Set包含{intent_count}项目标"
            ),
        ),
        (
            "clarification",
            "请求用户澄清",
            "clarification",
            "state.scenario = clarify",
            state.scenario,
        ),
        (
            "planning",
            "先形成任务计划",
            "planning_agent",
            "needs_plan(state) = true",
            plan_required,
        ),
        (
            "direct_response",
            "直接进入执行草稿",
            "execution_draft_compiler",
            "Default（前三条Case均未命中）",
            selected_index == 3,
        ),
    )
    options: list[dict[str, Any]] = []
    for index, (branch_id, label, target, condition, actual) in enumerate(branch_specs):
        matched = matches[index] if index < len(matches) else selected_index == 3
        selected = index == selected_index
        if selected and index == 3:
            reason = "前三条Case均未命中，MAF执行Default分支。"
        elif selected:
            reason = f"第{index + 1}条Case条件为真，因此按声明顺序首先命中。"
        elif matched:
            reason = f"条件也为真，但第{selected_index + 1}条Case已经先命中。"
        elif selected_index < index:
            reason = f"前面的第{selected_index + 1}条Case已经命中，本条不再参与派发。"
        else:
            reason = "本轮公开事实不满足该条件。"
        options.append(
            {
                "branch_id": branch_id,
                "label": label,
                "target": target,
                "condition": condition,
                "actual": actual,
                "matched": matched,
                "selected": selected,
                "reason": reason,
            }
        )
    selected = options[selected_index]
    return {
        "decision_kind": "maf_switch_case",
        "selection_mode": "first_match",
        "selected_branch": selected["branch_id"],
        "selected_target": selected["target"],
        "selection_reason": selected["reason"],
        "facts": {
            "intent.query_kind": query_kind if query_kind is not None else "未设置",
            "intent_count": intent_count,
            "state.scenario": state.scenario,
            "needs_plan(state)": plan_required,
        },
        "options": options,
    }
