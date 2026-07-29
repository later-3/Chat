"""把权威Product Trace确定性物化为机器版和人读版Run报告。

边界说明：

1. 输入只来自已经持久化的Product Run、Run Attempt、Trace和ToolExecution。
2. 生成过程不调用模型，不补写隐藏推理，也不根据自然语言猜测旧Run发生过什么。
3. ``diagnostic``保留可编程分析所需的结构化事件；``human``把相同事实重排为流程路径。
4. 两份报告都是可重建投影，权威事实仍是各领域表和``trace_events``。
"""

from __future__ import annotations

import hashlib
import json
from collections import defaultdict
from collections.abc import Mapping, Sequence
from datetime import datetime, timezone
from typing import Any

from .database import RunAttemptRecord, RunRecord, ToolExecutionRecord, TraceRecord

REPORT_SCHEMA_VERSION = 1
TERMINAL_RUN_STATUSES = {
    "succeeded",
    "failed",
    "abandoned",
    "cancelled",
    "interrupted",
    "outcome_unknown",
}

# 这组阶段只负责“教学投影”，节点本身及边仍以同版本Workflow Definition为准。
# 集合必须覆盖continuous-collaboration v1.8.0的39个节点，测试会阻止静默漂移。
CONTINUOUS_NODE_PHASES: dict[str, str] = {
    **dict.fromkeys(
        (
            "input_acceptance",
            "context_candidates",
            "harness_directory_context",
            "context_adoption",
            "directory_context_revision",
        ),
        "阶段1：输入与目录上下文",
    ),
    **dict.fromkeys(
        (
            "intent_agent",
            "intent_set_projection",
            "intent_binding",
            "intent_set_acceptance",
            "harness_project_resolver",
            "project_work_binding",
            "harness_detail_context",
            "detail_context_adoption",
            "detail_context_revision",
            "collaboration_protocol_resolver",
        ),
        "阶段2：意图、Project与协作协议",
    ),
    **dict.fromkeys(
        (
            "scenario_router",
            "project_catalog_query",
            "clarification",
            "planning_agent",
            "plan_acceptance",
        ),
        "阶段3：场景路由与计划",
    ),
    **dict.fromkeys(
        (
            "execution_draft_compiler",
            "execution_authorization",
            "run_spec_compiler",
            "execution_route",
        ),
        "阶段4：执行合同与运行路由",
    ),
    **dict.fromkeys(
        (
            "execution_workspace_prepare",
            "pi_workspace_dispatch",
            "pi_workspace_result_assembly",
            "result_claim_prepare",
            "result_claim_decision",
            "pi_readonly_dispatch",
            "pi_readonly_result_assembly",
        ),
        "阶段5：pi执行、工作区与证据",
    ),
    **dict.fromkeys(
        (
            "response_agent",
            "turn_summary_agent",
            "result_commit",
            "work_state_commit",
            "memory_commit",
        ),
        "阶段6：答复与提交决定",
    ),
    **dict.fromkeys(
        (
            "harness_candidate_commit",
            "turn_summary_persist",
            "result_finalization",
        ),
        "阶段7：产品事实提交与本轮收口",
    ),
}

EMPTY_REASON_LABELS = {
    "not_applicable": "本轮不适用",
    "not_selected": "所在分支未被选择",
    "not_produced": "节点执行了，但没有产出该字段",
    "redacted": "因安全或隐私规则被脱敏",
    "failed_before_production": "Run在产出该字段前失败或中止",
    "historical_not_recorded": "当时的结构化Trace没有记录更细原因",
}


def _iso(value: datetime | None) -> str | None:
    if value is None:
        return None
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.isoformat()


def _canonical(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def content_hash(value: Any) -> str:
    """计算不受字典插入顺序影响的报告内容Hash。"""

    return hashlib.sha256(_canonical(value).encode("utf-8")).hexdigest()


def _mapping(value: Any) -> dict[str, Any]:
    return dict(value) if isinstance(value, Mapping) else {}


def _compact(value: Any, *, limit: int = 280) -> str:
    """给人读Markdown生成有界摘要；完整值仍保留在人读JSON和机器报告中。"""

    if value in (None, "", [], {}):
        return "（空）"
    if isinstance(value, str):
        rendered = " ".join(value.split())
    else:
        rendered = _canonical(value)
    return rendered if len(rendered) <= limit else f"{rendered[: limit - 1]}…"


def _event_view(value: TraceRecord) -> dict[str, Any]:
    return {
        "id": value.id,
        "sequence": value.sequence,
        "event_type": value.event_type,
        "payload": value.payload,
        "created_at": _iso(value.created_at),
    }


def _attempt_view(value: RunAttemptRecord) -> dict[str, Any]:
    return {
        "id": value.id,
        "attempt_number": value.attempt_number,
        "runtime_kind": value.runtime_kind,
        "status": value.status,
        "failure_code": value.failure_code,
        "failure_message": value.failure_message,
        "started_at": _iso(value.started_at),
        "finished_at": _iso(value.finished_at),
    }


def _tool_view(value: ToolExecutionRecord) -> dict[str, Any]:
    return {
        "id": value.id,
        "tool_id": value.tool_id,
        "mode": value.mode,
        "status": value.status,
        "process_dispatch_state": value.process_dispatch_state,
        "model_call_count": value.model_call_count,
        "internal_tool_call_count": value.internal_tool_call_count,
        "input_tokens": value.input_tokens,
        "output_tokens": value.output_tokens,
        "duration_ms": value.duration_ms,
        "failure_code": value.failure_code,
        "terminal_reason_code": value.terminal_reason_code,
        "result_hash": value.result_hash,
        "started_at": _iso(value.started_at),
        "finished_at": _iso(value.finished_at),
    }


def _workflow_identity(events: Sequence[TraceRecord]) -> tuple[str | None, str | None]:
    workflow_id: str | None = None
    workflow_version: str | None = None
    for event in events:
        payload = _mapping(event.payload)
        candidate_id = payload.get("workflow_id") or payload.get("workflow_definition_id")
        candidate_version = payload.get("version") or payload.get("workflow_version")
        if candidate_id:
            workflow_id = str(candidate_id)
        if candidate_version:
            workflow_version = str(candidate_version)
        if workflow_id and workflow_version:
            break
    return workflow_id, workflow_version


def _node_id(event: TraceRecord) -> str | None:
    if event.event_type not in {"workflow.node", "workflow.node.content", "workflow.stage"}:
        return None
    payload = _mapping(event.payload)
    value = payload.get("executor_id") or payload.get("node_id") or payload.get("stage")
    return str(value) if value else None


def _route_decisions(events: Sequence[TraceRecord]) -> list[dict[str, Any]]:
    decisions: list[dict[str, Any]] = []
    for event in events:
        payload = _mapping(event.payload)
        candidates = (
            _mapping(payload.get("public_output")).get("route_decision"),
            _mapping(payload.get("details")).get("route_decision"),
            payload.get("route_decision"),
        )
        for candidate in candidates:
            if not isinstance(candidate, Mapping):
                continue
            decisions.append(
                {
                    "trace_sequence": event.sequence,
                    "executor_id": _node_id(event),
                    **dict(candidate),
                }
            )
            break
    return decisions


def _product_decisions(events: Sequence[TraceRecord]) -> list[dict[str, Any]]:
    decisions: list[dict[str, Any]] = []
    for event in events:
        payload = _mapping(event.payload)
        if payload.get("content_type") != "product_decision":
            continue
        decisions.append(
            {
                "trace_sequence": event.sequence,
                "executor_id": _node_id(event),
                **_mapping(payload.get("public_output")),
            }
        )
    return decisions


def _explicit_reason(output: Mapping[str, Any], lifecycle: Sequence[TraceRecord]) -> str | None:
    route = _mapping(output.get("route_decision"))
    for value in (
        route.get("selection_reason"),
        output.get("reason"),
        output.get("reason_summary"),
        output.get("disposition_reason"),
        output.get("terminal_reason_code"),
    ):
        if value not in (None, ""):
            return str(value)
    for event in reversed(lifecycle):
        details = _mapping(_mapping(event.payload).get("details"))
        if details.get("message"):
            return str(details["message"])
    return None


def _empty_paths(value: Any, *, prefix: str, limit: int = 48) -> list[str]:
    """只列显式存在但为空的字段；字段完全不存在不等同于“空值”。"""

    result: list[str] = []

    def visit(current: Any, path: str) -> None:
        if len(result) >= limit:
            return
        if current in (None, "", [], {}):
            result.append(path)
            return
        if isinstance(current, Mapping):
            for key, nested in current.items():
                if key == "empty_reasons":
                    # 这是解释元数据，不是业务字段；即使映射为空也不应反过来
                    # 生成“为什么empty_reasons为空”的递归噪声。
                    continue
                visit(nested, f"{path}.{key}" if path else str(key))
        elif isinstance(current, list):
            for index, nested in enumerate(current):
                visit(nested, f"{path}[{index}]")

    visit(value, prefix)
    return result


def _empty_explanations(
    *,
    node_id: str,
    public_input: Any,
    public_output: Any,
    run_status: str,
    node_status: str,
    explicit_reason: str | None,
) -> list[dict[str, str]]:
    output = _mapping(public_output)
    field_reasons = _mapping(output.get("empty_reasons"))
    decision_status = str(output.get("status") or "")
    if decision_status == "not_applicable":
        code = "not_applicable"
    elif run_status in {"failed", "abandoned", "cancelled", "interrupted", "outcome_unknown"} and (
        node_status in {"failed", "abandoned"}
    ):
        code = "failed_before_production"
    elif explicit_reason:
        code = "not_produced"
    else:
        code = "historical_not_recorded"
    explanations: list[dict[str, str]] = []
    for path in _empty_paths(public_input, prefix="public_input") + _empty_paths(
        public_output, prefix="public_output"
    ):
        short_path = path.removeprefix("public_input.").removeprefix("public_output.")
        field_reason = field_reasons.get(path, field_reasons.get(short_path))
        if isinstance(field_reason, Mapping):
            field_code = str(field_reason.get("code") or code)
            field_text = str(field_reason.get("reason") or EMPTY_REASON_LABELS.get(field_code, "未记录原因"))
        elif isinstance(field_reason, str) and field_reason:
            field_code = "not_produced"
            field_text = field_reason
        else:
            field_code = code
            field_text = explicit_reason or EMPTY_REASON_LABELS[code]
        explanations.append(
            {
                "node_id": node_id,
                "field": path,
                "code": field_code,
                "reason": field_text,
            }
        )
    return explanations


def _definition_nodes(definition: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    if definition is None:
        return []
    nodes = definition.get("nodes")
    return (
        [dict(value) for value in nodes if isinstance(value, Mapping)]
        if isinstance(nodes, Sequence) and not isinstance(nodes, (str, bytes))
        else []
    )


def _definition_edges(definition: Mapping[str, Any] | None) -> list[dict[str, Any]]:
    if definition is None:
        return []
    edges = definition.get("edges")
    return (
        [dict(value) for value in edges if isinstance(value, Mapping)]
        if isinstance(edges, Sequence) and not isinstance(edges, (str, bytes))
        else []
    )


def _actual_path(
    *,
    events: Sequence[TraceRecord],
    run_status: str,
    definition: Mapping[str, Any] | None,
    route_decisions: Sequence[Mapping[str, Any]],
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    grouped: dict[str, list[TraceRecord]] = defaultdict(list)
    for event in events:
        executor_id = _node_id(event)
        if executor_id:
            grouped[executor_id].append(event)

    node_definitions = {str(value["id"]): value for value in _definition_nodes(definition) if value.get("id")}
    selected_reasons = {
        str(value.get("selected_target")): str(value.get("selection_reason") or "已由持久化路由决定选中")
        for value in route_decisions
        if value.get("selected_target")
    }
    fixed_edges = {
        (str(value.get("source")), str(value.get("target")))
        for value in _definition_edges(definition)
        if value.get("source") and value.get("target") and not value.get("condition")
    }
    ordered = sorted(grouped, key=lambda key: min(value.sequence for value in grouped[key]))
    path: list[dict[str, Any]] = []
    empty_fields: list[dict[str, str]] = []
    previous_node: str | None = None
    for ordinal, executor_id in enumerate(ordered, start=1):
        node_events = sorted(grouped[executor_id], key=lambda value: value.sequence)
        content_events = [value for value in node_events if value.event_type == "workflow.node.content"]
        latest_content = content_events[-1] if content_events else None
        content_payload = _mapping(latest_content.payload) if latest_content is not None else {}
        lifecycle = [value for value in node_events if value.event_type == "workflow.node"]
        lifecycle_statuses = [
            str(_mapping(value.payload).get("status"))
            for value in lifecycle
            if _mapping(value.payload).get("status")
        ]
        node_status = lifecycle_statuses[-1] if lifecycle_statuses else "observed"
        public_input = content_payload.get("public_input")
        public_output = content_payload.get("public_output")
        explicit_reason = _explicit_reason(_mapping(public_output), lifecycle)
        if executor_id in selected_reasons:
            path_reason = selected_reasons[executor_id]
            path_reason_source = "product_trace.route_decision"
        elif ordinal == 1:
            path_reason = "这是本轮Workflow记录到的第一个节点。"
            path_reason_source = "product_trace.order"
        elif previous_node is not None and (previous_node, executor_id) in fixed_edges:
            path_reason = f"{previous_node}完成后按同版本Workflow Definition的固定边进入。"
            path_reason_source = "workflow_definition"
        elif explicit_reason:
            path_reason = explicit_reason
            path_reason_source = "product_trace.node_output"
        else:
            path_reason = "本轮结构化Trace记录了经过该节点，但没有保存更细的进入原因。"
            path_reason_source = "historical_not_recorded"
        node_definition = node_definitions.get(executor_id, {})
        node_empty = _empty_explanations(
            node_id=executor_id,
            public_input=public_input,
            public_output=public_output,
            run_status=run_status,
            node_status=node_status,
            explicit_reason=explicit_reason,
        )
        empty_fields.extend(node_empty)
        path.append(
            {
                "ordinal": ordinal,
                "node_id": executor_id,
                "label": node_definition.get("label") or executor_id,
                "phase": CONTINUOUS_NODE_PHASES.get(executor_id, "通用Workflow阶段"),
                "purpose": node_definition.get("description") or "当前Definition未提供节点说明。",
                "status": node_status,
                "first_sequence": node_events[0].sequence,
                "last_sequence": node_events[-1].sequence,
                "path_reason": path_reason,
                "path_reason_source": path_reason_source,
                "actor": content_payload.get("actor"),
                "content_type": content_payload.get("content_type"),
                "public_input": public_input,
                "public_output": public_output,
                "input_summary": _compact(public_input),
                "output_summary": _compact(public_output),
                "empty_fields": node_empty,
            }
        )
        previous_node = executor_id
    return path, empty_fields


def _unvisited_nodes(
    *,
    definition: Mapping[str, Any] | None,
    visited: set[str],
    route_decisions: Sequence[Mapping[str, Any]],
    run_status: str,
) -> list[dict[str, Any]]:
    adjacency: dict[str, set[str]] = defaultdict(set)
    for edge in _definition_edges(definition):
        source = str(edge.get("source") or "")
        target = str(edge.get("target") or "")
        if source and target:
            adjacency[source].add(target)

    def descendants(start: str) -> set[str]:
        """返回含起点的可达节点；只用于同版本Definition的分支排除解释。"""

        reached: set[str] = set()
        pending = [start]
        while pending:
            current = pending.pop()
            if current in reached:
                continue
            reached.add(current)
            pending.extend(adjacency.get(current, ()))
        return reached

    unselected: dict[str, str] = {}
    for decision in route_decisions:
        options = decision.get("options")
        if not isinstance(options, list):
            continue
        selected_target = str(decision.get("selected_target") or "")
        selected_descendants = descendants(selected_target) if selected_target else set()
        for option in options:
            if not isinstance(option, Mapping) or option.get("selected") is True:
                continue
            target = option.get("target")
            if target:
                target_id = str(target)
                reason = str(option.get("reason") or "该分支未被选择")
                branch_id = str(option.get("branch_id") or target_id)
                # 一个未选分支可能包含多个连续节点。用图可达性减去选中分支也会
                # 到达的汇合尾部，得到“只因该分支未选而不可能经过”的节点集合。
                exclusive_nodes = descendants(target_id) - selected_descendants
                for node_id in exclusive_nodes or {target_id}:
                    unselected[node_id] = f"分支{branch_id}未选：{reason}"

    result: list[dict[str, Any]] = []
    for node in _definition_nodes(definition):
        node_id = str(node.get("id") or "")
        if not node_id or node_id in visited:
            continue
        if node_id in unselected:
            code = "not_selected"
            reason = unselected[node_id]
        elif run_status in {"failed", "abandoned", "cancelled", "interrupted", "outcome_unknown"}:
            code = "failed_before_production"
            reason = "Run在到达该节点前已经进入非成功终态；没有该节点的Trace事件。"
        else:
            code = "historical_not_recorded"
            reason = "本轮没有该节点事件，现有持久化事实不足以进一步断言原因。"
        result.append(
            {
                "node_id": node_id,
                "label": node.get("label") or node_id,
                "phase": CONTINUOUS_NODE_PHASES.get(node_id, "通用Workflow阶段"),
                "code": code,
                "reason": reason,
            }
        )
    return result


def _human_markdown(report: Mapping[str, Any]) -> str:
    run = _mapping(report.get("run"))
    workflow = _mapping(report.get("workflow"))
    source = _mapping(report.get("source"))
    title = "本轮持续协作流程报告" if workflow.get("id") == "continuous-collaboration" else "本轮协作流程报告"
    lines = [
        f"# {title}",
        "",
        f"- Product Run：`{run.get('id')}`",
        f"- 终态：`{run.get('status')}`",
        f"- Workflow：`{workflow.get('id') or '未记录'}` / `v{workflow.get('version') or '未记录'}`",
        f"- Trace范围：Sequence {source.get('first_sequence')}–{source.get('last_sequence')}，共 {source.get('event_count')} 条",
        "- 生成方式：后端按结构化事实确定性生成；未调用Agent/LLM，不包含隐藏推理。",
        "",
        "## 实际经过的节点",
        "",
        "| # | 阶段 | 节点 | 终态 | 为什么经过 |",
        "|---:|---|---|---|---|",
    ]
    for node in report.get("actual_path", []):
        if not isinstance(node, Mapping):
            continue
        reason = str(node.get("path_reason") or "").replace("|", "\\|").replace("\n", " ")
        lines.append(
            f"| {node.get('ordinal')} | {node.get('phase')} | "
            f"`{node.get('node_id')}` {node.get('label')} | {node.get('status')} | {reason} |"
        )

    lines.extend(["", "## 路由与决定", ""])
    route_decisions = report.get("route_decisions")
    product_decisions = report.get("product_decisions")
    if not route_decisions and not product_decisions:
        lines.append("本轮没有记录结构化路由或产品决定。")
    for decision in route_decisions if isinstance(route_decisions, list) else []:
        if not isinstance(decision, Mapping):
            continue
        lines.append(
            f"- 路由 `{decision.get('executor_id')}` 选择 `{decision.get('selected_branch')}`："
            f"{decision.get('selection_reason') or '旧Trace未记录选择原因'}"
        )
        options = decision.get("options")
        for option in options if isinstance(options, list) else []:
            if isinstance(option, Mapping) and option.get("selected") is not True:
                lines.append(f"  - 未选 `{option.get('branch_id')}`：{option.get('reason') or '未记录原因'}")
    for decision in product_decisions if isinstance(product_decisions, list) else []:
        if isinstance(decision, Mapping):
            lines.append(
                f"- 决策点 `{decision.get('decision_point_key')}` → `{decision.get('status')}`："
                f"{decision.get('reason') or '未记录原因'}"
            )

    lines.extend(["", "## 空值与未经过节点", ""])
    empty_fields = report.get("empty_fields")
    unvisited = report.get("unvisited_nodes")
    if not empty_fields and not unvisited:
        lines.append("没有需要解释的显式空值或未经过节点。")
    for item in empty_fields if isinstance(empty_fields, list) else []:
        if isinstance(item, Mapping):
            lines.append(
                f"- `{item.get('node_id')}.{item.get('field')}` = 空："
                f"[{item.get('code')}] {item.get('reason')}"
            )
    for item in unvisited if isinstance(unvisited, list) else []:
        if isinstance(item, Mapping):
            lines.append(f"- 未经过 `{item.get('node_id')}`：[{item.get('code')}] {item.get('reason')}")

    lines.extend(
        [
            "",
            "## 如何继续定位",
            "",
            f"- 产品Trace：`GET /api/sessions/{run.get('session_id')}/runs/{run.get('id')}/trace`",
            f"- 双报告：`GET /api/sessions/{run.get('session_id')}/runs/{run.get('id')}/trace-reports`",
            f"- 运维时间线：`GET /api/diagnostics/runs/{run.get('id')}/timeline`",
            "- 进程JSONL：由 `observability.log_file` 配置，默认 `backend/.data/logs/chat.jsonl`；按 `product_run_id` 检索。",
        ]
    )
    return "\n".join(lines) + "\n"


def build_run_trace_reports(
    *,
    run: RunRecord,
    attempts: Sequence[RunAttemptRecord],
    events: Sequence[TraceRecord],
    tools: Sequence[ToolExecutionRecord],
    workflow_definition: Mapping[str, Any] | None,
) -> dict[str, tuple[dict[str, Any], str | None]]:
    """从同一事实快照生成两份报告；返回值可以直接物化或测试。"""

    ordered_events = sorted(events, key=lambda value: value.sequence)
    workflow_id, workflow_version = _workflow_identity(ordered_events)
    definition_matches = bool(
        workflow_definition
        and workflow_definition.get("id") == workflow_id
        and workflow_definition.get("version") == workflow_version
    )
    exact_definition = workflow_definition if definition_matches else None
    routes = _route_decisions(ordered_events)
    product_decisions = _product_decisions(ordered_events)
    actual_path, empty_fields = _actual_path(
        events=ordered_events,
        run_status=run.status,
        definition=exact_definition,
        route_decisions=routes,
    )
    unvisited = _unvisited_nodes(
        definition=exact_definition,
        visited={str(value["node_id"]) for value in actual_path},
        route_decisions=routes,
        run_status=run.status,
    )
    first_sequence = ordered_events[0].sequence if ordered_events else 0
    last_sequence = ordered_events[-1].sequence if ordered_events else 0
    terminal_event = ordered_events[-1].event_type if ordered_events else None
    source = {
        "first_sequence": first_sequence,
        "last_sequence": last_sequence,
        "event_count": len(ordered_events),
        "terminal_event": terminal_event,
        "complete": terminal_event == f"run.{run.status}",
        "completeness_reason": (
            "最后一条Product Trace与Run终态一致。"
            if terminal_event == f"run.{run.status}"
            else "最后一条Product Trace与Run终态不一致，报告保留现状并标记不完整。"
        ),
    }
    run_view = {
        "id": run.id,
        "session_id": run.session_id,
        "interaction_id": run.interaction_id,
        "initial_agui_run_id": run.initial_agui_run_id,
        "status": run.status,
        "failure_code": run.failure_code,
        "failure_message": run.failure_message,
        "retry_of_run_id": run.retry_of_run_id,
        "retry_mode": run.retry_mode,
        "started_at": _iso(run.started_at),
        "finished_at": _iso(run.finished_at),
    }
    workflow_view = {
        "id": workflow_id,
        "version": workflow_version,
        "definition_match": definition_matches,
        "definition_status": (
            "exact_version_projection" if definition_matches else "historical_definition_unavailable"
        ),
        "node_count": len(_definition_nodes(exact_definition)),
    }
    diagnostic = {
        "schema_version": REPORT_SCHEMA_VERSION,
        "report_kind": "diagnostic",
        "generation": {
            "mode": "deterministic_projection",
            "model_called": False,
            "hidden_reasoning_included": False,
            "authoritative_source": "product_store",
        },
        "run": run_view,
        "workflow": workflow_view,
        "source": source,
        "attempts": [_attempt_view(value) for value in attempts],
        "tool_executions": [_tool_view(value) for value in tools],
        "route_decisions": routes,
        "product_decisions": product_decisions,
        "events": [_event_view(value) for value in ordered_events],
        "analysis": {
            "actual_node_ids": [str(value["node_id"]) for value in actual_path],
            "unvisited_node_ids": [str(value["node_id"]) for value in unvisited],
            "empty_field_count": len(empty_fields),
            "diagnostics_timeline_path": f"/api/diagnostics/runs/{run.id}/timeline",
            "process_log_query_field": "product_run_id",
        },
    }
    human = {
        "schema_version": REPORT_SCHEMA_VERSION,
        "report_kind": "human",
        "generation": diagnostic["generation"],
        "run": run_view,
        "workflow": workflow_view,
        "source": source,
        "summary": {
            "result": (
                "本轮已成功提交Product Message。"
                if run.status == "succeeded"
                else f"本轮以{run.status}结束；失败码：{run.failure_code or '未记录'}。"
            ),
            "visited_node_count": len(actual_path),
            # 这里只有ToolExecution中由pi记录的模型调用；主MAF Agent的完整Attempt
            # 数量由diagnostics timeline查询，不能把两种口径混成一个数字。
            "pi_model_call_count": sum(value.model_call_count for value in tools),
            "tool_execution_count": len(tools),
            "empty_field_count": len(empty_fields),
        },
        "actual_path": actual_path,
        "route_decisions": routes,
        "product_decisions": product_decisions,
        "empty_fields": empty_fields,
        "unvisited_nodes": unvisited,
        "empty_reason_codes": EMPTY_REASON_LABELS,
        "limits": [
            "只解释持久化公开事实，不展示或补写模型隐藏推理。",
            "旧Trace没有记录的原因标为historical_not_recorded，不用当前代码倒推历史。",
            "进程崩溃前未提交到Product Store的瞬时细节只能到JSONL/运行时事件中另查。",
        ],
    }
    return {
        "diagnostic": (diagnostic, None),
        "human": (human, _human_markdown(human)),
    }
