"""The selectable Chat Workflow: intent, routing, planning, response and turn focus."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from dataclasses import asdict, dataclass, replace
from typing import Any, Callable, Mapping

from agent_framework import (
    Case,
    CheckpointStorage,
    Default,
    Executor,
    WorkflowBuilder,
    WorkflowContext,
    handler,
    response_handler,
)
from agent_framework._workflows._request_info_mixin import RequestInfoMixin

from ..agent_profiles import AgentProfileSnapshot
from ..governance.service import ExecutionGovernanceService, GovernanceConflict
from ..harness import HarnessService
from ..model_call_review import (
    InMemoryModelCallReviewStore,
    ModelCallDraft,
    ModelCallDraftConflict,
    PreparedProviderRequest,
    ProviderDispatchError,
)
from ..model_call_workflow import ProviderTransport, normalize_agui_messages_for_provider
from ..product_sessions.service import ProductSessionService


WORKFLOW_ID = "continuous-collaboration"
WORKFLOW_VERSION = "1.2.0"
JSON_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL | re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class CollaborationState:
    origin_prompt: str
    recent_turn_summaries: tuple[dict[str, Any], ...] = ()
    project_candidates: tuple[str, ...] = ()
    project_matches: tuple[dict[str, Any], ...] = ()
    context_items: tuple[dict[str, Any], ...] = ()
    directory_context_package_id: str | None = None
    detail_context_package_id: str | None = None
    selected_project_id: str | None = None
    intent: dict[str, Any] | None = None
    scenario: str = "clarify"
    plan: str | None = None
    execution_draft_revision_id: str | None = None
    run_spec_id: str | None = None
    response: str | None = None
    turn_summary: dict[str, Any] | None = None
    last_model_call_revision_id: str | None = None
    harness_decision_record_ids: tuple[str, ...] = ()
    harness_commit_results: dict[str, Any] | None = None


def _state_from_snapshot(value: Mapping[str, Any]) -> CollaborationState:
    restored = dict(value)
    for key in (
        "recent_turn_summaries",
        "project_candidates",
        "project_matches",
        "context_items",
        "harness_decision_record_ids",
    ):
        if isinstance(restored.get(key), list):
            restored[key] = tuple(restored[key])
    return CollaborationState(**restored)


def _message_text(message: Mapping[str, Any]) -> str:
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


def _json_object(text: str) -> dict[str, Any] | None:
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


def _context_keywords(text: str) -> set[str]:
    """Build small deterministic terms for both Latin words and CJK text.

    A whitespace tokenizer turns a Chinese sentence into one giant token and
    therefore misses obvious overlaps such as ``贪吃蛇``.  Character n-grams
    are deliberately bounded: this is only the lightweight first-stage recall,
    not a semantic retriever or the final context adoption decision.
    """

    lowered = text.lower()
    keywords = set(re.findall(r"[a-z0-9_][a-z0-9_.-]{1,}", lowered))
    for sequence in re.findall(r"[\u4e00-\u9fff]{2,}", lowered):
        for size in range(2, min(6, len(sequence)) + 1):
            keywords.update(sequence[index : index + size] for index in range(len(sequence) - size + 1))
    return keywords


def _hash(value: Any) -> str:
    body = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(body).hexdigest()


def _project_hint(summary: Mapping[str, Any]) -> str | None:
    direct = summary.get("project_hint")
    nested = summary.get("summary")
    nested_hint = nested.get("project_hint") if isinstance(nested, Mapping) else None
    value = direct or nested_hint
    if not isinstance(value, str) or not value.strip():
        return None
    return value.strip()


def _is_pending_clarification(summary: Mapping[str, Any]) -> bool:
    nested = summary.get("summary")
    return bool(isinstance(nested, Mapping) and nested.get("awaiting_user_answer") is True)


def _is_project_catalog_query(text: str) -> bool:
    compact = re.sub(r"[\s，,。.!！?？:：;；]", "", text).lower()
    if not compact or "项目" not in compact:
        return False
    if any(value in compact for value in ("新建", "创建", "开始一个", "新增")):
        return False
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
    if compact in exact:
        return True
    if any(value in compact for value in ("有哪些项目", "有什么项目", "多少个项目")):
        return True
    if "项目列表" in compact and any(
        value in compact for value in ("查看", "看看", "列出", "显示", "想要", "想看")
    ):
        return True
    return bool(
        re.fullmatch(
            r"(?:请|请帮我|帮我)?(?:查看|看看|列出|显示)(?:一下)?"
            r"(?:我的|现有|当前|所有)?项目(?:列表)?",
            compact,
        )
        or re.fullmatch(r"(?:我)?(?:目前|现在|当前)?有(?:哪些|什么|多少个?)项目", compact)
    )


def _project_catalog_intent(prompt: str) -> dict[str, Any]:
    return {
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
    }


class TraceMixin:
    def _trace_init(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        self._thread_id = thread_id
        self._sessions = sessions

    async def _trace_content(
        self,
        *,
        executor_id: str,
        public_input: Any,
        public_output: Any,
        actor: str,
        content_type: str,
    ) -> None:
        active = await self._sessions.active_run(self._thread_id)
        if active is None:
            return
        await self._sessions.record_trace(
            self._thread_id,
            str(active["id"]),
            "workflow.node.content",
            {
                "workflow_id": WORKFLOW_ID,
                "executor_id": executor_id,
                "actor": actor,
                "content_type": content_type,
                "public_input": public_input,
                "public_output": public_output,
            },
        )


class IntakeExecutor(Executor, TraceMixin):
    def __init__(
        self,
        *,
        thread_id: str,
        sessions: ProductSessionService,
        governance: ExecutionGovernanceService,
    ) -> None:
        super().__init__(id="input_acceptance")
        self._trace_init(thread_id=thread_id, sessions=sessions)
        self._governance = governance

    @handler(input=list)
    async def accept(self, messages: list[Any], ctx: WorkflowContext[CollaborationState]) -> None:
        normalized = normalize_agui_messages_for_provider(messages)
        user_messages = [value for value in normalized if value.get("role") == "user"]
        if not user_messages:
            raise ValueError("主Workflow没有收到用户输入")
        prompt = _message_text(user_messages[-1]).strip()
        if not prompt:
            raise ValueError("用户输入不能为空")
        summaries = await self._governance.recent_turn_summaries(self._thread_id, limit=8)
        project_candidates = tuple(
            dict.fromkeys(
                hint for value in summaries if (hint := _project_hint(value)) is not None
            )
        )
        state = CollaborationState(
            origin_prompt=prompt,
            recent_turn_summaries=tuple(summaries),
            project_candidates=project_candidates,
        )
        await self._trace_content(
            executor_id=self.id,
            actor="user",
            content_type="workflow_input",
            public_input=prompt,
            public_output={
                "accepted": True,
                "candidate_summary_count": len(summaries),
                "note": "完整历史保留为证据；这里只把主题提取结果作为候选，不会无脑叠加历史。",
            },
        )
        await ctx.send_message(state)


class CandidateContextExecutor(Executor, TraceMixin):
    def __init__(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        super().__init__(id="context_candidates")
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def select_candidates(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        keywords = _context_keywords(state.origin_prompt)
        scored: list[tuple[int, dict[str, Any]]] = []
        pending = [value for value in state.recent_turn_summaries if _is_pending_clarification(value)]
        for summary in state.recent_turn_summaries:
            if summary in pending:
                continue
            searchable = json.dumps(summary, ensure_ascii=False).lower()
            score = sum(1 for keyword in keywords if keyword in searchable)
            if score > 0:
                scored.append((score, summary))
        selected_values = pending[:1]
        selected_values.extend(
            value
            for _, value in sorted(scored, key=lambda item: item[0], reverse=True)
            if value not in selected_values
        )
        selected = tuple(selected_values[:4])
        next_state = replace(state, recent_turn_summaries=selected)
        await self._trace_content(
            executor_id=self.id,
            actor="deterministic_context_selector",
            content_type="context_candidates",
            public_input={"prompt": state.origin_prompt, "available_summaries": len(state.recent_turn_summaries)},
            public_output={
                "selected": list(selected),
                "selection_rule": (
                    "最近一条未回答澄清会优先带回；其余按关键词命中后最多采用4条候选。"
                    "最终采用仍由后续意图与HITL判断。"
                ),
            },
        )
        await ctx.send_message(next_state)


class HarnessDirectoryContextExecutor(Executor, TraceMixin):
    """Stage A: query the authoritative lightweight resource directory."""

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        harness: HarnessService,
    ) -> None:
        super().__init__(id="harness_directory_context")
        self._run_id = run_id
        self._harness = harness
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def assemble(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        items, projects = await self._harness.directory_context_items(
            prompt=state.origin_prompt,
            summaries=state.recent_turn_summaries,
        )
        package = await self._harness.create_context_package(
            session_id=self._thread_id,
            run_id=self._run_id(),
            stage="directory",
            items=items,
            token_budget=1800,
            status="candidate",
        )
        next_state = replace(
            state,
            project_matches=tuple(projects),
            context_items=tuple(item for item in package["items"] if item["adopted"]),
            directory_context_package_id=package["id"],
        )
        await self._trace_content(
            executor_id=self.id,
            actor="product_harness_query",
            content_type="context_directory",
            public_input={"prompt": state.origin_prompt, "summary_count": len(state.recent_turn_summaries)},
            public_output={
                "context_package_id": package["id"],
                "project_candidates": projects,
                "adopted_items": [item for item in package["items"] if item["adopted"]],
                "excluded_items": [item for item in package["items"] if not item["adopted"]],
            },
        )
        await ctx.send_message(next_state)


class HarnessProjectResolverExecutor(Executor, TraceMixin):
    """Resolve a model hint only against authoritative Project IDs."""

    def __init__(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        super().__init__(id="harness_project_resolver")
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def resolve(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        hint = str((state.intent or {}).get("project_hint") or "").strip().lower()
        matches = [
            value for value in state.project_matches
            if hint and (hint in str(value.get("title") or "").lower()
                         or str(value.get("title") or "").lower() in hint)
        ]
        selected = matches[0]["id"] if len(matches) == 1 else state.selected_project_id
        next_state = replace(state, selected_project_id=selected)
        await self._trace_content(
            executor_id=self.id,
            actor="product_harness_resolver",
            content_type="project_resolution",
            public_input={"project_hint": hint, "directory_candidates": list(state.project_matches)},
            public_output={
                "selected_project_id": selected,
                "match_count": len(matches),
                "requires_human_choice": state.scenario == "continue_project" and selected is None,
            },
        )
        await ctx.send_message(next_state)


class HarnessDetailContextExecutor(Executor, TraceMixin):
    """Stage B: load the selected Project's bounded working set."""

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        harness: HarnessService,
    ) -> None:
        super().__init__(id="harness_detail_context")
        self._run_id = run_id
        self._harness = harness
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def assemble(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        if state.selected_project_id is None:
            await self._trace_content(
                executor_id=self.id,
                actor="product_harness_query",
                content_type="context_detail",
                public_input={"selected_project_id": None},
                public_output={"status": "not_applicable", "reason": "本轮未绑定正式Project"},
            )
            await ctx.send_message(state)
            return
        items = await self._harness.detailed_context_items(state.selected_project_id)
        package = await self._harness.create_context_package(
            session_id=self._thread_id,
            run_id=self._run_id(),
            stage="detail",
            items=items,
            selected_project_id=state.selected_project_id,
            token_budget=6000,
            status="adopted",
        )
        adopted = tuple(item for item in package["items"] if item["adopted"])
        next_state = replace(
            state,
            context_items=adopted,
            detail_context_package_id=package["id"],
        )
        await self._trace_content(
            executor_id=self.id,
            actor="product_harness_query",
            content_type="context_detail",
            public_input={"selected_project_id": state.selected_project_id},
            public_output={
                "context_package_id": package["id"],
                "estimated_tokens": package["estimated_tokens"],
                "token_budget": package["token_budget"],
                "adopted_items": list(adopted),
                "excluded_items": [item for item in package["items"] if not item["adopted"]],
            },
        )
        await ctx.send_message(next_state)


@dataclass(frozen=True, slots=True)
class ProductDecisionSpec:
    key: str
    subject_kind: str
    title: str
    description: str
    accept_action: str
    applicable: Callable[[CollaborationState], bool]
    subject: Callable[[CollaborationState], Any]
    facts: Callable[[CollaborationState], Mapping[str, Any]]
    editable_fields: Callable[[CollaborationState], list[dict[str, Any]]]
    revise: Callable[[CollaborationState, Mapping[str, Any]], CollaborationState]
    allow_skip: bool = False
    grant_kind: str | None = None


class ProductDecisionExecutor(Executor, RequestInfoMixin, TraceMixin):
    """Persist and, when policy requires it, interrupt at one product decision point."""

    def __init__(
        self,
        *,
        node_id: str,
        spec: ProductDecisionSpec,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        governance: ExecutionGovernanceService,
    ) -> None:
        super().__init__(id=node_id)
        self.spec = spec
        self._run_id = run_id
        self._governance = governance
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def decide(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState, str],
    ) -> None:
        await self._advance(state, ctx)

    async def _advance(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState, str],
    ) -> None:
        content = self.spec.subject(state)
        facts = dict(self.spec.facts(state))
        run_context = await self._governance.run_context(self._run_id())
        subject_hash = _hash(content)
        if self.spec.key == "execution_authorization" and state.execution_draft_revision_id:
            subject = await self._governance.execution_draft_subject(
                state.execution_draft_revision_id
            )
        else:
            subject = await self._governance.register_subject(
                subject_kind=self.spec.subject_kind,
                resource_id=f"{self._run_id()}:{self.id}",
                resource_revision=subject_hash[:16],
                subject_content=content,
                session_id=str(run_context["session_id"]),
                interaction_id=run_context["interaction_id"],
                run_id=str(run_context["run_id"]),
                run_attempt_id=run_context["run_attempt_id"],
                workflow_definition_id=WORKFLOW_ID,
                workflow_version=WORKFLOW_VERSION,
                node_id=self.id,
                decision_view={
                    "title": self.spec.title,
                    "description": self.spec.description,
                    "content": content,
                    "editable_fields": self.spec.editable_fields(state),
                },
            )
        if not self.spec.applicable(state):
            clarification_pending = self.spec.key == "intent_binding" and state.scenario == "clarify"
            await self._governance.record_not_applicable(
                subject=subject,
                decision_point_key=self.spec.key,
                facts=facts,
                reason_code=(
                    "clarification_requires_new_user_input"
                    if clarification_pending
                    else "no_candidate_subject_this_turn"
                ),
            )
            await self._trace_decision(
                state,
                content,
                "not_applicable",
                "需要先取得用户回答，当前意图候选不能绑定"
                if clarification_pending
                else "本轮没有需要决定的对象",
            )
            await ctx.send_message(state)
            return
        scopes = [
            {"kind": "product_default", "ref_id": "*"},
            {"kind": "principal", "ref_id": self._governance.principal_id},
            {"kind": "product_session", "ref_id": self._thread_id},
            {"kind": "interaction", "ref_id": str(run_context["interaction_id"] or "")},
            {"kind": "run", "ref_id": self._run_id()},
            {"kind": "workflow_version", "ref_id": WORKFLOW_ID},
            {"kind": "workflow_node", "ref_id": self.id},
            {"kind": "scenario", "ref_id": state.scenario},
        ]
        evaluation, preview = await self._governance.evaluate_subject(
            subject=subject,
            decision_point_key=self.spec.key,
            scopes=scopes,
            facts=facts,
        )
        final_action = str(preview["final_action"])
        if final_action == "deny":
            await self._governance.record_automatic_decision(
                evaluation=evaluation,
                subject=subject,
                decision_code="deny",
                grant_kind=None,
                binding_hash=subject.subject_hash,
            )
            await self._trace_decision(state, content, "denied", "HITL策略阻止继续")
            raise PermissionError(f"HITL策略阻止决策点: {self.spec.key}")
        if final_action == "auto_continue":
            record, grant = await self._governance.record_automatic_decision(
                evaluation=evaluation,
                subject=subject,
                decision_code=self.spec.accept_action,
                grant_kind=self.spec.grant_kind,
                binding_hash=subject.subject_hash,
            )
            if grant is not None:
                await self._consume_grant(grant.id, subject.subject_hash)
            if self.spec.key in {"work_state_commit", "memory_commit"}:
                state = replace(
                    state,
                    harness_decision_record_ids=state.harness_decision_record_ids + (record.id,),
                )
            await self._trace_decision(state, content, "auto_continue", "按有效策略自动通过")
            await ctx.send_message(state)
            return
        allowed_actions = [self.spec.accept_action]
        if self.spec.editable_fields(state):
            allowed_actions.append("revise")
        if self.spec.allow_skip:
            allowed_actions.append("skip")
        allowed_actions.append("cancel")
        request = await self._governance.create_human_request(
            evaluation=evaluation,
            subject=subject,
            decision_point_key=self.spec.key,
            title=self.spec.title,
            reason="当前有效HITL策略要求用户确认后继续。",
            evidence={
                "workflow_node_id": self.id,
                "content": content,
                "facts": facts,
                "policy": preview,
            },
            consequence={
                self.spec.accept_action: "接受当前版本并继续Workflow。",
                "revise": "修改后形成新Subject Hash并重新评估。",
                "skip": "本轮跳过该候选，不写长期事实。",
                "cancel": "停止当前Run，不继续后续模型或工具调用。",
            },
            allowed_actions=allowed_actions,
        )
        card = {
            "review_kind": "product_decision",
            "message": self.spec.description,
            "approval_id": request.id,
            "decision_request_id": request.id,
            "decision_item_key": subject.id,
            "decision_point_key": self.spec.key,
            "title": self.spec.title,
            "reason_summary": request.reason_summary,
            "request_hash": request.request_hash,
            "row_version": request.row_version,
            "subject_hash": subject.subject_hash,
            "subject_resource_id": subject.resource_id,
            "subject": content,
            "facts": facts,
            "policy": preview,
            "allowed_actions": allowed_actions,
            "editable_fields": self.spec.editable_fields(state),
            "execution_context": {
                "workflow_id": WORKFLOW_ID,
                "workflow_version": WORKFLOW_VERSION,
                "executor_id": self.id,
                "workflow_state": asdict(state),
                "wait_reason": "product_decision",
            },
        }
        await self._sessions.mark_waiting_approval(self._thread_id, approval_id=request.id)
        await self._trace_decision(state, content, "waiting_human", "等待用户决定")
        await ctx.request_info(card, dict, request_id=request.id)

    async def _consume_grant(self, grant_id: str, binding_hash: str) -> None:
        consumption = await self._governance.claim_grant(
            grant_id=grant_id,
            binding_hash=binding_hash,
            consumer_kind="workflow_decision",
            consumer_id=f"{self._run_id()}:{self.id}",
            idempotency_key=f"workflow-decision:{self._run_id()}:{self.id}:{binding_hash}",
            claimed_by=f"api-pid-{os.getpid()}:{self.id}",
        )
        if self.spec.key == "execution_authorization":
            await self._governance.bind_execution_authorization(
                run_id=self._run_id(),
                consumption_id=consumption.id,
            )

    async def _trace_decision(
        self,
        state: CollaborationState,
        content: Any,
        status: str,
        reason: str,
    ) -> None:
        await self._trace_content(
            executor_id=self.id,
            actor="execution_governance",
            content_type="product_decision",
            public_input=content,
            public_output={
                "decision_point_key": self.spec.key,
                "status": status,
                "reason": reason,
                "scenario": state.scenario,
            },
        )

    @response_handler(request=dict, response=dict, workflow_output=str)
    async def resolve(self, original_request, decision, ctx) -> None:
        state_value = original_request.get("execution_context", {}).get("workflow_state")
        if not isinstance(state_value, dict):
            raise RuntimeError("产品决定请求缺少Workflow状态")
        state = _state_from_snapshot(state_value)
        action = str(decision.get("decision") or "")
        if decision.get("decision_recorded") is True:
            [resolved] = await self._governance.resolved_human_request(
                str(original_request["decision_request_id"])
            )
            if resolved["decision"] != action:
                raise GovernanceConflict("Outbox决定与MAF Resume payload不一致")
        else:
            resolved = await self._governance.resolve_single_human_request(
                request_id=str(original_request["decision_request_id"]),
                expected_request_hash=str(original_request["request_hash"]),
                expected_row_version=int(original_request["row_version"]),
                decision=action,
            )
        if action == "revise":
            changes = decision.get("changes")
            if not isinstance(changes, Mapping):
                raise ValueError("修改决定必须提供结构化changes")
            await self._advance(self.spec.revise(state, changes), ctx)
            return
        if action == "skip":
            changes: Mapping[str, Any] = {"skip": True}
            await self._trace_decision(state, self.spec.subject(state), "skipped", "用户本轮跳过")
            await ctx.send_message(self.spec.revise(state, changes))
            return
        if action == "cancel":
            await self._sessions.abandon_active_run(self._thread_id)
            await ctx.yield_output("当前Run已按用户决定停止，后续模型请求没有发送。")
            return
        if action != self.spec.accept_action:
            raise ValueError(f"不支持的产品决定: {action}")
        grant_id = resolved.get("authorization_grant_id")
        if grant_id:
            await self._consume_grant(str(grant_id), str(resolved["binding_hash"]))
        if self.spec.key in {"work_state_commit", "memory_commit"} and resolved.get("decision_record_id"):
            state = replace(
                state,
                harness_decision_record_ids=(
                    state.harness_decision_record_ids + (str(resolved["decision_record_id"]),)
                ),
            )
        await self._trace_decision(state, self.spec.subject(state), "accepted", "用户接受当前版本")
        await ctx.send_message(state)


class GovernedSemanticAgentExecutor(Executor, RequestInfoMixin, TraceMixin):
    """Agent-shaped semantic step with durable ModelCall governance before dispatch."""

    def __init__(
        self,
        *,
        profile: AgentProfileSnapshot,
        node_id: str,
        call_ordinal: int,
        thread_id: str,
        run_id: Callable[[], str],
        store: InMemoryModelCallReviewStore,
        transport: ProviderTransport,
        sessions: ProductSessionService,
        governance: ExecutionGovernanceService,
        task_builder: Callable[[CollaborationState], str],
        result_kind: str,
    ) -> None:
        super().__init__(id=node_id)
        self.profile = profile
        self.call_ordinal = call_ordinal
        self._run_id = run_id
        self._store = store
        self._transport = transport
        self._governance = governance
        self._task_builder = task_builder
        self._result_kind = result_kind
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @property
    def description(self) -> str:
        return self.profile.description

    def _begin(self, state: CollaborationState) -> ModelCallDraft:
        task = self._task_builder(state)
        return self._store.begin(
            thread_id=self._thread_id,
            run_id=self._run_id(),
            messages=[{"role": "user", "content": task}],
            model=self.profile.model,
            provider_id=self.profile.provider_id,
            instructions=self.profile.instructions,
            origin_prompt=state.origin_prompt,
            execution_context={
                "workflow_id": WORKFLOW_ID,
                "workflow_version": WORKFLOW_VERSION,
                "executor_id": self.id,
                "agent_id": self.profile.id,
                "agent_name": self.profile.name,
                "agent_revision": self.profile.revision,
                "call_ordinal": self.call_ordinal,
                "scenario": state.scenario,
                "prompt_assembly": "selective-context-v1",
            },
        )

    @handler(input=CollaborationState)
    async def prepare(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState, str],
    ) -> None:
        await self._advance(self._begin(state), state, ctx)

    async def _advance(
        self,
        draft: ModelCallDraft,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState, str],
    ) -> None:
        card = draft.review_card()
        slot, revision, evaluation, preview, request = await self._governance.register_model_call(
            review_card=card
        )
        governance_view = {
            "model_call_slot_id": slot.id,
            "model_call_revision_id": revision.id,
            "policy_evaluation_id": evaluation.id,
            "final_action": preview["final_action"],
            "reason_codes": preview["reason_codes"],
            "matched_rules": preview["matched_rules"],
            "decision_request_id": request.id if request else None,
            "decision_request_hash": request.request_hash if request else None,
            "decision_request_row_version": request.row_version if request else None,
            "decision_item_key": revision.subject_id if request else None,
        }
        execution_context = card.setdefault("execution_context", {})
        if isinstance(execution_context, dict):
            execution_context["governance"] = governance_view
        await self._trace_content(
            executor_id=self.id,
            actor=self.profile.name,
            content_type="model_call_draft",
            public_input={
                "task": self._task_builder(state),
                "selected_turn_summaries": list(state.recent_turn_summaries),
            },
            public_output={
                "model_call_revision_id": revision.id,
                "policy_action": preview["final_action"],
                "status": "等待用户确认" if request else "按策略处理",
            },
        )
        if preview["final_action"] == "deny":
            await self._governance.record_automatic_decision(
                evaluation=evaluation,
                subject=await self._subject(revision.subject_id),
                decision_code="deny",
                grant_kind=None,
                binding_hash=revision.binding_hash,
            )
            raise PermissionError("当前HITL策略禁止本次模型调用")
        if preview["final_action"] == "auto_continue":
            subject = await self._subject(revision.subject_id)
            _, grant = await self._governance.record_automatic_decision(
                evaluation=evaluation,
                subject=subject,
                decision_code="approve",
                grant_kind="send_model_call",
                binding_hash=revision.binding_hash,
            )
            if grant is None:
                raise RuntimeError("自动模型调用决定没有签发授权")
            consumption = await self._governance.claim_grant(
                grant_id=grant.id,
                binding_hash=revision.binding_hash,
                consumer_kind="model_call_attempt",
                consumer_id=revision.id,
                idempotency_key=f"model-call:{revision.id}",
                claimed_by=f"api-pid-{os.getpid()}:{self.id}",
            )
            text = await self._dispatch(draft, revision, consumption)
            await self._deliver(text, state, revision.id, ctx)
            return
        if request is None:
            raise RuntimeError("人工模式没有创建Human Decision Request")
        await self._sessions.mark_waiting_approval(
            self._thread_id,
            draft_id=draft.draft_id,
            approval_id=draft.approval_id,
        )
        await self._request_review_with_state(card, state, ctx)

    async def _subject(self, subject_id: str):
        from ..governance.models import DecisionSubjectRecord

        async with self._governance.database.sessions() as transaction:
            value = await transaction.get(DecisionSubjectRecord, subject_id)
            if value is None:
                raise RuntimeError("ModelCall DecisionSubject不存在")
            return value

    async def _dispatch(self, draft, revision, consumption) -> str:
        try:
            await self._sessions.mark_running(self._thread_id)
            claimed = self._store.claim(
                approval_id=draft.approval_id,
                expected_hash=draft.binding_hash,
                owner=f"api-pid-{os.getpid()}:{self.id}",
            )
        except ModelCallDraftConflict:
            return ""
        attempt = await self._governance.start_model_call_attempt(
            revision=revision,
            consumption=consumption,
        )
        chunks: list[str] = []
        try:
            async for text in self._transport.stream(PreparedProviderRequest.from_draft(claimed)):
                chunks.append(text)
        except ProviderDispatchError as error:
            self._store.mark_attempt(draft.approval_id, error.outcome_status, error_code=error.error_code)
            await self._governance.finish_model_call_attempt(
                attempt_id=attempt.id,
                status=error.outcome_status,
                failure_code=error.error_code,
            )
            await self._sessions.fail_active_run(
                self._thread_id,
                status=error.outcome_status,
                error_code=error.error_code,
                message=str(error),
            )
            raise
        except asyncio.CancelledError:
            self._store.mark_attempt(draft.approval_id, "outcome_unknown", error_code="provider_dispatch_cancelled")
            await self._governance.finish_model_call_attempt(
                attempt_id=attempt.id,
                status="outcome_unknown",
                failure_code="provider_dispatch_cancelled",
            )
            await self._sessions.fail_active_run(
                self._thread_id,
                status="outcome_unknown",
                error_code="provider_dispatch_cancelled",
                message="Provider发送期间被取消，结果未知。",
            )
            raise
        self._store.mark_attempt(draft.approval_id, "completed")
        await self._governance.finish_model_call_attempt(attempt_id=attempt.id, status="completed")
        return "".join(chunks) or "模型调用已完成，但没有返回可显示的文本。"

    @response_handler(request=dict, response=dict, workflow_output=str)
    async def resolve(self, original_request, decision, ctx) -> None:
        # A restored MAF Checkpoint contains the exact review card, while the
        # transport claim registry is intentionally process-local. Rehydrate
        # it from the hash-verified card before applying the durable decision.
        restored_draft = self._store.restore_review_card(original_request)
        state_value = original_request.get("execution_context", {}).get("workflow_state")
        if not isinstance(state_value, dict):
            raise RuntimeError("审批请求缺少Workflow状态快照")
        state = _state_from_snapshot(state_value)
        governance_view = original_request.get("execution_context", {}).get("governance")
        if not isinstance(governance_view, dict):
            raise RuntimeError("审批请求缺少持久治理引用")
        request_id = str(governance_view.get("decision_request_id") or "")
        request_hash = str(governance_view.get("decision_request_hash") or "")
        row_version = int(governance_view.get("decision_request_row_version") or 0)
        action = decision.get("decision")
        pre_recorded: dict[str, Any] | None = None
        if decision.get("decision_recorded") is True:
            [pre_recorded] = await self._governance.resolved_human_request(request_id)
            if pre_recorded["decision"] != action:
                raise GovernanceConflict("Outbox决定与MAF Resume payload不一致")
        if action == "revise":
            if pre_recorded is None:
                await self._governance.resolve_single_human_request(
                    request_id=request_id,
                    expected_request_hash=request_hash,
                    expected_row_version=row_version,
                    decision="revise",
                )
            revised = self._store.successor(
                str(original_request["draft_id"]),
                str(decision["revision_draft_id"]),
            )
            await self._advance(revised, state, ctx)
            return
        if action == "abandon":
            if pre_recorded is None:
                await self._governance.resolve_single_human_request(
                    request_id=request_id,
                    expected_request_hash=request_hash,
                    expected_row_version=row_version,
                    decision="abandon",
                )
            self._store.abandon(str(original_request["approval_id"]))
            await self._sessions.abandon_active_run(self._thread_id)
            await ctx.yield_output("本次主Workflow已放弃，当前模型请求没有发送。")
            return
        if action != "approve":
            raise ValueError(f"不支持的模型调用决定: {action}")
        resolved = pre_recorded or await self._governance.resolve_single_human_request(
            request_id=request_id,
            expected_request_hash=request_hash,
            expected_row_version=row_version,
            decision="approve",
        )
        grant_id = str(resolved.get("authorization_grant_id") or "")
        revision_id = str(governance_view.get("model_call_revision_id") or "")
        from ..governance.models import ModelCallDraftRevisionRecord

        async with self._governance.database.sessions() as transaction:
            revision = await transaction.get(ModelCallDraftRevisionRecord, revision_id)
            if revision is None:
                raise RuntimeError("持久ModelCall revision不存在")
        consumption = await self._governance.claim_grant(
            grant_id=grant_id,
            binding_hash=str(resolved["binding_hash"]),
            consumer_kind="model_call_attempt",
            consumer_id=revision.id,
            idempotency_key=f"model-call:{revision.id}",
            claimed_by=f"api-pid-{os.getpid()}:{self.id}",
        )
        draft = restored_draft
        text = await self._dispatch(draft, revision, consumption)
        if not text:
            await ctx.yield_output("该授权已失效或已消费，没有重复发送模型请求。")
            return
        await self._deliver(text, state, revision.id, ctx)

    async def _deliver(self, text, state, revision_id, ctx) -> None:
        if self._result_kind == "intent":
            parsed = _json_object(text)
            allowed = {"simple_question", "continue_project", "new_task", "plan_request", "learning", "clarify"}
            if _is_project_catalog_query(state.origin_prompt):
                parsed = _project_catalog_intent(state.origin_prompt)
            elif parsed is None or parsed.get("scenario") not in allowed:
                parsed = {
                    "scenario": "clarify",
                    "goal": state.origin_prompt,
                    "confidence": 0,
                    "project_hint": None,
                    "needs_plan": False,
                    "needs_clarification": True,
                    "clarification_question": "我还不能可靠判断你希望继续哪件事，可以补充目标或相关项目吗？",
                    "context_keywords": [],
                    "reason_summary": "意图结构化输出无效，关闭失败为澄清。",
                }
            confidence = parsed.get("confidence")
            if not isinstance(confidence, (int, float)) or not 0 <= float(confidence) <= 1:
                parsed["confidence"] = 0
                parsed["scenario"] = "clarify"
                parsed["needs_clarification"] = True
            if parsed["scenario"] == "clarify":
                parsed["needs_clarification"] = True
                if not parsed.get("clarification_question"):
                    parsed["clarification_question"] = "你希望我接下来具体推进哪件事？"
            else:
                parsed["needs_clarification"] = False
                parsed["clarification_question"] = None
            next_state = replace(
                state,
                intent=parsed,
                scenario=str(parsed["scenario"]),
                last_model_call_revision_id=revision_id,
            )
            public_output: Any = parsed
        elif self._result_kind == "plan":
            next_state = replace(state, plan=text, last_model_call_revision_id=revision_id)
            public_output = text
        elif self._result_kind == "response":
            next_state = replace(state, response=text, last_model_call_revision_id=revision_id)
            public_output = text
        elif self._result_kind == "summary":
            summary = _json_object(text) or {
                "topic": state.intent.get("goal") if state.intent else state.origin_prompt[:80],
                "confirmed_facts": [],
                "decisions": [],
                "open_questions": [],
                "project_hint": state.intent.get("project_hint") if state.intent else None,
                "work_state_candidates": [],
                "memory_candidates": [],
                "extraction_warning": "模型未返回有效JSON，仅保存最小主题候选。",
            }
            next_state = replace(
                state,
                turn_summary=summary,
                last_model_call_revision_id=revision_id,
            )
            public_output = {
                "topic": summary.get("topic"),
                "confirmed_facts": summary.get("confirmed_facts"),
                "open_questions": summary.get("open_questions"),
                "work_state_candidates": summary.get("work_state_candidates"),
                "memory_candidates": summary.get("memory_candidates"),
                "note": "Work/Memory仍是候选，不会自动成为长期事实。",
            }
        else:
            raise RuntimeError(f"未知语义结果类型: {self._result_kind}")
        await self._trace_content(
            executor_id=self.id,
            actor=self.profile.name,
            content_type=self._result_kind,
            public_input={"origin_prompt": state.origin_prompt, "scenario": state.scenario},
            public_output=public_output,
        )
        await ctx.send_message(next_state)

    async def _request_review_with_state(self, card, state, ctx) -> None:
        execution_context = card.setdefault("execution_context", {})
        if isinstance(execution_context, dict):
            execution_context["workflow_state"] = asdict(state)
        await ctx.request_info(card, dict, request_id=str(card["approval_id"]))


class ScenarioRouterExecutor(Executor, TraceMixin):
    def __init__(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        super().__init__(id="scenario_router")
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def route(self, state: CollaborationState, ctx: WorkflowContext[CollaborationState]) -> None:
        await self._trace_content(
            executor_id=self.id,
            actor="deterministic_scenario_router",
            content_type="scenario_route",
            public_input=state.intent,
            public_output={
                "scenario": state.scenario,
                "branch": (
                    "project_catalog"
                    if _is_project_catalog_state(state)
                    else "clarification"
                    if state.scenario == "clarify"
                    else "planning"
                    if _needs_plan(state)
                    else "direct_response"
                ),
            },
        )
        await ctx.send_message(state)


class ProjectCatalogExecutor(Executor, TraceMixin):
    """Answer the current product-catalog query from product facts, never model guesses."""

    def __init__(
        self,
        *,
        thread_id: str,
        sessions: ProductSessionService,
        harness: HarnessService,
    ) -> None:
        super().__init__(id="project_catalog_query")
        self._harness = harness
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def answer(self, state: CollaborationState, ctx: WorkflowContext[CollaborationState]) -> None:
        projects = await self._harness.list_projects(
            statuses=("proposed", "active", "paused", "completed"),
        )
        candidates = list(state.project_candidates)
        if projects:
            rendered = "\n".join(
                f"- {value['title']}（{value['kind']} · {value['status']}）：{value['goal']}"
                for value in projects
            )
            response = f"当前共有 {len(projects)} 个正式 Project：\n{rendered}"
        elif candidates:
            rendered = "、".join(candidates)
            response = (
                "当前还没有已创建的正式 Project。"
                f"最近对话中识别到 {len(candidates)} 个 Project 候选：{rendered}。"
                "这些只是对话摘要中的候选，还没有成为正式 Project。"
            )
        else:
            response = (
                "当前还没有已创建的正式 Project。"
                "最近对话中也没有识别到可供确认的 Project 候选。"
            )
        summary = {
            "topic": "查看现有项目列表",
            "confirmed_facts": [f"当前正式Project数量为{len(projects)}"],
            "decisions": [],
            "open_questions": [],
            "project_hint": None,
            "work_state_candidates": [],
            "memory_candidates": [],
            "query_kind": "project_catalog",
        }
        next_state = replace(state, response=response, turn_summary=summary)
        await self._trace_content(
            executor_id=self.id,
            actor="product_project_catalog",
            content_type="project_catalog_query",
            public_input={"query": state.origin_prompt},
            public_output={
                "formal_projects": projects,
                "conversation_project_candidates": candidates,
                "assistant_response": response,
            },
        )
        await ctx.send_message(next_state)


class ExecutionDraftCompilerExecutor(Executor, TraceMixin):
    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        governance: ExecutionGovernanceService,
    ) -> None:
        super().__init__(id="execution_draft_compiler")
        self._run_id = run_id
        self._governance = governance
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def compile(self, state: CollaborationState, ctx: WorkflowContext[CollaborationState]) -> None:
        intent = state.intent or {}
        context_manifest = [
            {
                "source_kind": value.get("source_kind"),
                "source_id": value.get("source_id"),
                "source_revision": value.get("source_revision"),
                "title": value.get("title"),
                "adoption_reason": value.get("reason"),
                "token_estimate": value.get("token_estimate"),
            }
            for value in state.context_items
        ]
        context_hash = _hash(context_manifest)
        brief = (
            f"目标：{intent.get('goal') or state.origin_prompt}\n"
            f"场景：{state.scenario}\n"
            f"项目提示：{intent.get('project_hint') or '未关联'}\n"
            f"计划：{state.plan or '本轮不需要独立计划'}\n"
            "完成门：只提交可由当前回答支持的结论；任务、项目、Memory变化保持候选，等待相应决策点。"
        )
        payload = {
            "identity_lineage": {"session_id": self._thread_id, "run_id": self._run_id(), "workflow_id": WORKFLOW_ID, "workflow_version": WORKFLOW_VERSION},
            "intent_goal": intent,
            "project_work_binding": {
                "project_id": state.selected_project_id,
                "project_hint": intent.get("project_hint"),
                "status": "accepted" if state.selected_project_id else "not_applicable",
            },
            "background": context_manifest,
            "accepted_decisions": [],
            "scope": {"included": ["answer current user request"], "excluded": ["unapproved long-term state mutation"]},
            "plan": {"text": state.plan, "mode": "explicit" if state.plan else "direct"},
            "context_binding": {
                "manifest": context_manifest,
                "context_hash": context_hash,
                "context_package_id": state.detail_context_package_id or state.directory_context_package_id,
                "excluded": "raw full history by default",
            },
            "resource_manifest": [],
            "runtime_target": {"runtime": "maf-workflow", "isolation": "in_process", "working_directory": None},
            "capability_grant": {"tools": [], "side_effects": "none", "network": "model-provider-only"},
            "model_envelope": {"store": False, "continuation": False, "provider_and_model": "profile-bound"},
            "prompt_assembly_plan": {
                "blocks": ["agent_instructions", "user_request", "intent", "accepted_context", "project_work", "plan", "constraints", "output_contract"],
                "history_policy": "selective summaries, never implicit full history",
            },
            "hitl_plan": {"decision_points": ["model_call_authorization", "result_commit", "memory_commit", "work_state_commit"]},
            "validation_plan": {"checks": ["structured intent", "scenario branch", "no false completion"], "evidence": "workflow trace and provider attempts"},
            "output_commit_contract": {"chat_result": "candidate until finalization", "work": "candidate", "memory": "candidate"},
            "stop_escalation": {"provider_failure": "stop", "outcome_unknown": "require human", "capability_expansion": "new decision"},
        }
        draft, revision = await self._governance.create_execution_draft(
            session_id=self._thread_id,
            run_id=self._run_id(),
            workflow_definition_id=WORKFLOW_ID,
            workflow_version=WORKFLOW_VERSION,
            payload=payload,
            execution_brief=brief,
        )
        next_state = replace(state, execution_draft_revision_id=revision.id)
        await self._trace_content(
            executor_id=self.id,
            actor="execution_governance_compiler",
            content_type="execution_draft",
            public_input={"intent": intent, "plan": state.plan, "context_manifest": context_manifest},
            public_output={
                "execution_brief": brief,
                "draft_revision_id": revision.id,
                "draft_hash": revision.draft_hash,
                "status": revision.status,
            },
        )
        await ctx.send_message(next_state)


class RunSpecCompilerExecutor(Executor, TraceMixin):
    """Compile the immutable RunSpec only after the Draft revision is accepted."""

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        governance: ExecutionGovernanceService,
    ) -> None:
        super().__init__(id="run_spec_compiler")
        self._run_id = run_id
        self._governance = governance
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def compile(self, state: CollaborationState, ctx: WorkflowContext[CollaborationState]) -> None:
        if not state.execution_draft_revision_id:
            raise GovernanceConflict("缺少已授权的ExecutionDraft revision")
        accepted = await self._governance.accepted_execution_draft(
            state.execution_draft_revision_id
        )
        payload = accepted["payload"]
        context_binding = dict(payload["context_binding"])
        spec_payload = {
            "identity": {"schema_version": "run-spec-v1", "compiler_version": "run-spec-compiler-v1"},
            "source_binding": {
                "draft_id": accepted["draft_id"],
                "draft_revision_id": accepted["revision_id"],
                "draft_hash": accepted["draft_hash"],
            },
            "principal_scope": {"principal_id": "local-user", "channel": "web"},
            "workflow_binding": {"definition_id": WORKFLOW_ID, "version": WORKFLOW_VERSION, "entry": "input_acceptance"},
            "execution_brief": {"text": accepted["execution_brief"], "draft_hash": accepted["draft_hash"]},
            "context_manifest": {
                "items": list(context_binding.get("manifest") or []),
                "context_hash": context_binding.get("context_hash"),
            },
            "plan": {"text": payload["plan"].get("text"), "scenario": state.scenario},
            "prompt_assembly_contract": payload["prompt_assembly_plan"],
            "runtime_agent": {"runtime": "maf-workflow", "agent_profiles": ["intent_router", "task_planner", "response_agent", "turn_summarizer"]},
            "capability_envelope": payload["capability_grant"],
            "model_envelope": payload["model_envelope"],
            "hitl_policy_snapshot": {"resolver": "hitl-resolver-v1", "binding": "compiled after Draft authorization"},
            "validation_evidence": payload["validation_plan"],
            "output_commit": payload["output_commit_contract"],
            "control": {"cancel": True, "retry": "new authorization", "outcome_unknown": "human reconciliation"},
            "correlation_idempotency": {"product_run_id": self._run_id(), "agui_thread_id": self._thread_id},
        }
        spec = await self._governance.compile_run_spec(
            draft_revision_id=state.execution_draft_revision_id,
            scopes=[
                {"kind": "product_default", "ref_id": "*"},
                {"kind": "principal", "ref_id": "local-user"},
                {"kind": "product_session", "ref_id": self._thread_id},
                {"kind": "run", "ref_id": self._run_id()},
                {"kind": "workflow_version", "ref_id": WORKFLOW_ID},
                {"kind": "scenario", "ref_id": state.scenario},
            ],
            spec_payload=spec_payload,
            run_id=self._run_id(),
        )
        next_state = replace(state, run_spec_id=spec.id)
        await self._trace_content(
            executor_id=self.id,
            actor="run_spec_compiler",
            content_type="run_spec",
            public_input={
                "accepted_draft_revision_id": accepted["revision_id"],
                "draft_hash": accepted["draft_hash"],
            },
            public_output={
                "run_spec_id": spec.id,
                "run_spec_hash": spec.run_spec_hash,
                "status": spec.status,
            },
        )
        await ctx.send_message(next_state)


class ClarificationExecutor(Executor, TraceMixin):
    def __init__(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        super().__init__(id="clarification")
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def clarify(self, state: CollaborationState, ctx: WorkflowContext[CollaborationState]) -> None:
        intent = state.intent or {}
        question = str(intent.get("clarification_question") or "你希望我接下来具体推进哪件事？")
        response = f"{question}\n\n请直接在下方输入框回答。"
        next_state = replace(
            state,
            response=response,
            turn_summary={
                "topic": intent.get("goal") or state.origin_prompt[:80],
                "confirmed_facts": [],
                "decisions": [],
                "open_questions": [question],
                "project_hint": intent.get("project_hint"),
                "work_state_candidates": [],
                "memory_candidates": [],
                "awaiting_user_answer": True,
                "clarification_context": {
                    "original_user_request": state.origin_prompt,
                    "question": question,
                },
            },
        )
        await self._trace_content(
            executor_id=self.id,
            actor="deterministic_clarification",
            content_type="clarification",
            public_input=intent,
            public_output={
                "question": question,
                "answer_surface": "next_chat_input",
                "note": "澄清是新用户输入，不使用接受/修改审批动作。",
            },
        )
        await ctx.send_message(next_state)


class HarnessCandidateCommitExecutor(Executor, TraceMixin):
    """Commit only Work/Memory candidates that survived their decision points."""

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        harness: HarnessService,
    ) -> None:
        super().__init__(id="harness_candidate_commit")
        self._run_id = run_id
        self._harness = harness
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def commit(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        summary = state.turn_summary or {}
        work_candidates = list(summary.get("work_state_candidates") or [])
        memory_candidates = list(summary.get("memory_candidates") or [])
        if not work_candidates and not memory_candidates:
            await self._trace_content(
                executor_id=self.id,
                actor="product_harness_repository",
                content_type="harness_candidate_commit",
                public_input={"work_count": 0, "memory_count": 0},
                public_output={"status": "not_applicable"},
            )
            await ctx.send_message(state)
            return
        result = await self._harness.commit_turn_candidates(
            command_id=f"turn-candidates:{self._run_id()}",
            session_id=self._thread_id,
            run_id=self._run_id(),
            project_id=state.selected_project_id,
            work_candidates=work_candidates,
            memory_candidates=memory_candidates,
            decision_record_ids=state.harness_decision_record_ids,
        )
        next_state = replace(state, harness_commit_results=result)
        await self._trace_content(
            executor_id=self.id,
            actor="product_harness_repository",
            content_type="harness_candidate_commit",
            public_input={
                "work_candidates": work_candidates,
                "memory_candidates": memory_candidates,
                "decision_record_ids": list(state.harness_decision_record_ids),
            },
            public_output=result,
        )
        await ctx.send_message(next_state)


class TurnSummaryPersistExecutor(Executor, TraceMixin):
    """Persist the final turn focus after Work/Memory candidate decisions."""

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        governance: ExecutionGovernanceService,
    ) -> None:
        super().__init__(id="turn_summary_persist")
        self._run_id = run_id
        self._governance = governance
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def persist(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        summary = dict(state.turn_summary or {
            "topic": (state.intent or {}).get("goal") or state.origin_prompt[:80],
            "confirmed_facts": [],
            "decisions": [],
            "open_questions": [],
            "project_hint": (state.intent or {}).get("project_hint"),
            "work_state_candidates": [],
            "memory_candidates": [],
            "extraction_warning": "本轮未形成模型摘要，保存确定性的最小主题候选。",
        })
        persisted = await self._governance.save_turn_summary(
            session_id=self._thread_id,
            run_id=self._run_id(),
            summary=summary,
            source_model_call_revision_id=state.last_model_call_revision_id,
        )
        next_state = replace(state, turn_summary=summary)
        await self._trace_content(
            executor_id=self.id,
            actor="turn_summary_repository",
            content_type="turn_summary_commit",
            public_input={
                "topic": summary.get("topic"),
                "work_state_candidates": summary.get("work_state_candidates") or [],
                "memory_candidates": summary.get("memory_candidates") or [],
            },
            public_output={
                "turn_summary_id": persisted["id"],
                "summary_hash": persisted["summary_hash"],
                "status": persisted["status"],
                "note": "摘要是可追溯的回合派生候选；不替代原始Message，也不自动成为Work或Accepted Memory。",
            },
        )
        await ctx.send_message(next_state)


class FinalizeExecutor(Executor, TraceMixin):
    def __init__(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        super().__init__(id="result_finalization")
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler
    async def finalize(self, state: CollaborationState, ctx: WorkflowContext[None, str]) -> None:
        response = state.response or "本轮没有形成可提交的答复。"
        await self._trace_content(
            executor_id=self.id,
            actor="product_finalization_gate",
            content_type="result_candidate",
            public_input={
                "execution_draft_revision_id": state.execution_draft_revision_id,
                "run_spec_id": state.run_spec_id,
                "turn_summary": state.turn_summary,
            },
            public_output={"assistant_response": response, "commit": "Product Message"},
        )
        await ctx.yield_output(response)


def _needs_plan(state: CollaborationState) -> bool:
    if state.scenario in {"new_task", "plan_request", "continue_project"}:
        return True
    return bool((state.intent or {}).get("needs_plan"))


def _is_project_catalog_state(state: CollaborationState) -> bool:
    return (state.intent or {}).get("query_kind") == "project_catalog"


def _revise_context(
    state: CollaborationState,
    changes: Mapping[str, Any],
) -> CollaborationState:
    if changes.get("skip"):
        return replace(state, recent_turn_summaries=())
    selected = changes.get("selected_summary_ids")
    if not isinstance(selected, list) or not all(isinstance(value, str) for value in selected):
        raise ValueError("Context修改必须提供selected_summary_ids")
    selected_ids = set(selected)
    return replace(
        state,
        recent_turn_summaries=tuple(
            value for value in state.recent_turn_summaries if str(value.get("id")) in selected_ids
        ),
    )


def _revise_intent(
    state: CollaborationState,
    changes: Mapping[str, Any],
) -> CollaborationState:
    current = dict(state.intent or {})
    for key in ("scenario", "goal", "project_hint", "needs_plan", "clarification_question"):
        if key in changes:
            current[key] = changes[key]
    scenario = str(current.get("scenario") or "clarify")
    if scenario not in {
        "simple_question", "continue_project", "new_task", "plan_request", "learning", "clarify"
    }:
        raise ValueError("意图场景无效")
    current["confidence"] = 1.0
    current["needs_clarification"] = scenario == "clarify"
    return replace(state, intent=current, scenario=scenario)


def _revise_project(
    state: CollaborationState,
    changes: Mapping[str, Any],
) -> CollaborationState:
    current = dict(state.intent or {})
    project_id = changes.get("project_id")
    if project_id in {None, ""}:
        current["project_hint"] = None
        return replace(state, intent=current, selected_project_id=None)
    if not isinstance(project_id, str):
        raise ValueError("Project修改必须选择正式Project ID或不关联")
    match = next((value for value in state.project_matches if value.get("id") == project_id), None)
    if match is None:
        raise ValueError("选择的Project不在本轮权威候选目录中")
    current["project_hint"] = match.get("title")
    return replace(state, intent=current, selected_project_id=project_id)


def _revise_plan(
    state: CollaborationState,
    changes: Mapping[str, Any],
) -> CollaborationState:
    if changes.get("skip"):
        return replace(state, plan=None)
    value = changes.get("plan_text")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Plan修改后不能为空")
    return replace(state, plan=value.strip())


def _revise_result(
    state: CollaborationState,
    changes: Mapping[str, Any],
) -> CollaborationState:
    value = changes.get("response_text")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("Result修改后不能为空")
    return replace(state, response=value.strip())


def _revise_execution_draft(
    state: CollaborationState,
    changes: Mapping[str, Any],
) -> CollaborationState:
    revision_id = changes.get("execution_draft_revision_id")
    if not isinstance(revision_id, str) or not revision_id:
        raise ValueError("ExecutionDraft修改必须绑定新的revision")
    return replace(state, execution_draft_revision_id=revision_id)


def _revise_summary_candidates(
    state: CollaborationState,
    changes: Mapping[str, Any],
    key: str,
) -> CollaborationState:
    summary = dict(state.turn_summary or {})
    if changes.get("skip"):
        summary[key] = []
    else:
        value = changes.get(key)
        if not isinstance(value, list):
            raise ValueError(f"{key}修改必须是候选列表")
        summary[key] = value
    return replace(state, turn_summary=summary)


def _decision_specs() -> dict[str, ProductDecisionSpec]:
    return {
        "context_adoption": ProductDecisionSpec(
            key="context_adoption",
            subject_kind="context_package",
            title="确认本轮采用的上下文",
            description="这些主题摘要将进入后续意图识别；完整历史仍只作为证据保留。",
            accept_action="accept",
            applicable=lambda state: bool(state.recent_turn_summaries or state.project_matches),
            subject=lambda state: {
                "selected_summaries": list(state.recent_turn_summaries),
                "project_directory_matches": list(state.project_matches),
                "context_package_id": state.directory_context_package_id,
            },
            facts=lambda state: {
                "context": {
                    "requires_review": False,
                    "cross_project": len({
                        str(value.get("project_hint"))
                        for value in state.recent_turn_summaries
                        if value.get("project_hint")
                    }) > 1,
                    "source_invalid": False,
                }
            },
            editable_fields=lambda state: [{
                "key": "selected_summary_ids",
                "label": "采用的主题摘要",
                "type": "multi_select",
                "value": [str(value.get("id")) for value in state.recent_turn_summaries],
                "options": [
                    {"value": str(value.get("id")), "label": str(value.get("topic") or "未命名主题")}
                    for value in state.recent_turn_summaries
                ],
            }] if state.recent_turn_summaries else [],
            revise=_revise_context,
            allow_skip=True,
        ),
        "intent_binding": ProductDecisionSpec(
            key="intent_binding",
            subject_kind="intent",
            title="确认我对本轮意图的理解",
            description="确认目标和场景，避免把简单询问误建成任务或关联到错误Project。",
            accept_action="accept",
            applicable=lambda state: state.intent is not None and state.scenario != "clarify",
            subject=lambda state: dict(state.intent or {}),
            facts=lambda state: {
                "intent": {
                    "confidence": float((state.intent or {}).get("confidence") or 0),
                    "changes_active_work": False,
                    "ambiguous": state.scenario == "clarify",
                }
            },
            editable_fields=lambda state: [
                {
                    "key": "scenario",
                    "label": "场景",
                    "type": "select",
                    "value": state.scenario,
                    "options": [
                        {"value": "simple_question", "label": "简单询问"},
                        {"value": "continue_project", "label": "继续Project"},
                        {"value": "new_task", "label": "新任务"},
                        {"value": "plan_request", "label": "规划请求"},
                        {"value": "learning", "label": "学习"},
                        {"value": "clarify", "label": "需要澄清"},
                    ],
                },
                {"key": "goal", "label": "本轮目标", "type": "text", "value": (state.intent or {}).get("goal") or state.origin_prompt},
                {"key": "project_hint", "label": "Project提示", "type": "text_optional", "value": (state.intent or {}).get("project_hint") or ""},
                {"key": "needs_plan", "label": "需要计划", "type": "boolean", "value": bool((state.intent or {}).get("needs_plan"))},
            ],
            revise=_revise_intent,
        ),
        "project_work_binding": ProductDecisionSpec(
            key="project_work_binding",
            subject_kind="work_binding",
            title="确认本轮关联的 Project / Work",
            description="只有明确关联后，Project状态才会进入后续上下文候选。",
            accept_action="accept",
            applicable=lambda state: bool((state.intent or {}).get("project_hint")) or state.scenario == "continue_project",
            subject=lambda state: {
                "project_hint": (state.intent or {}).get("project_hint"),
                "selected_project_id": state.selected_project_id,
                "formal_project_candidates": list(state.project_matches),
                "scenario": state.scenario,
            },
            facts=lambda state: {
                "project": {
                    "candidate_count": len(state.project_matches),
                    "cross_sensitive_scope": False,
                }
            },
            editable_fields=lambda state: [{
                "key": "project_id",
                "label": "Project / Work",
                "type": "select",
                "value": state.selected_project_id or "",
                "options": [
                    {"value": "", "label": "本轮不关联正式Project"},
                    *[
                        {"value": str(value["id"]), "label": f"{value['title']} · {value['status']}"}
                        for value in state.project_matches
                    ],
                ],
            }],
            revise=_revise_project,
            allow_skip=True,
        ),
        "plan_acceptance": ProductDecisionSpec(
            key="plan_acceptance",
            subject_kind="task_plan",
            title="确认本轮计划",
            description="确认步骤、边界和验证方式；也可以本轮暂不规划。",
            accept_action="accept",
            applicable=lambda state: bool(state.plan),
            subject=lambda state: {"plan": state.plan, "scenario": state.scenario},
            facts=lambda state: {"plan": {"risk_level": 0, "expands_capability": False, "boundary_unclear": False}},
            editable_fields=lambda state: [{"key": "plan_text", "label": "计划", "type": "long_text", "value": state.plan or ""}],
            revise=_revise_plan,
            allow_skip=True,
        ),
        "execution_authorization": ProductDecisionSpec(
            key="execution_authorization",
            subject_kind="execution_draft",
            title="授权本轮执行合同",
            description="确认目标、范围、能力和完成门后，才进入协作响应阶段。",
            accept_action="execute",
            applicable=lambda state: bool(state.execution_draft_revision_id),
            subject=lambda state: {
                "execution_draft_revision_id": state.execution_draft_revision_id,
                "scenario": state.scenario,
            },
            facts=lambda state: {"execution": {"risk_level": 0, "has_side_effects": False, "goal_incomplete": False}},
            editable_fields=lambda state: [{
                "key": "execution_draft_revision_id",
                "label": "ExecutionDraft完整工作台",
                "type": "execution_draft",
                "value": state.execution_draft_revision_id,
            }],
            revise=_revise_execution_draft,
            grant_kind="start_run",
        ),
        "result_commit": ProductDecisionSpec(
            key="result_commit",
            subject_kind="result_candidate",
            title="确认本轮结果",
            description="确认答复和完成声明有当前证据支持，再提交到Product Session。",
            accept_action="accept",
            applicable=lambda state: bool(state.response),
            subject=lambda state: {"response": state.response, "turn_summary": state.turn_summary},
            facts=lambda state: {"result": {"evidence_sufficient": True, "external_delivery": False, "changes_long_term_state": False}},
            editable_fields=lambda state: [{"key": "response_text", "label": "提交给会话的答复", "type": "long_text", "value": state.response or ""}],
            revise=_revise_result,
            grant_kind="commit_result",
        ),
        "work_state_commit": ProductDecisionSpec(
            key="work_state_commit",
            subject_kind="work_state_candidate",
            title="确认Work状态候选",
            description="候选不会自动成为任务或Project的长期状态。",
            accept_action="commit",
            applicable=lambda state: bool((state.turn_summary or {}).get("work_state_candidates")),
            subject=lambda state: {"candidates": (state.turn_summary or {}).get("work_state_candidates") or []},
            facts=lambda state: {"work": {"creates_or_deletes": False, "claims_completion_without_evidence": False}},
            editable_fields=lambda state: [],
            revise=lambda state, changes: _revise_summary_candidates(state, changes, "work_state_candidates"),
            allow_skip=True,
            grant_kind="commit_work_state",
        ),
        "memory_commit": ProductDecisionSpec(
            key="memory_commit",
            subject_kind="memory_candidate",
            title="确认长期Memory候选",
            description="只有你明确接受的候选才可进入长期Memory；原始会话不受影响。",
            accept_action="commit",
            applicable=lambda state: bool((state.turn_summary or {}).get("memory_candidates")),
            subject=lambda state: {"candidates": (state.turn_summary or {}).get("memory_candidates") or []},
            facts=lambda state: {"memory": {"candidate_count": len((state.turn_summary or {}).get("memory_candidates") or [])}},
            editable_fields=lambda state: [],
            revise=lambda state, changes: _revise_summary_candidates(state, changes, "memory_candidates"),
            allow_skip=True,
            grant_kind="commit_memory",
        ),
    }


def _intent_task(state: CollaborationState) -> str:
    return json.dumps(
        {
            "current_user_request": state.origin_prompt,
            "candidate_prior_turn_summaries": list(state.recent_turn_summaries),
            "formal_project_directory_matches": list(state.project_matches),
            "context_package_id": state.directory_context_package_id,
            "rules": [
                "候选摘要不是已采用事实；只有与当前请求直接相关时才引用。",
                "若候选摘要标记awaiting_user_answer=true，当前输入可能是对该开放问题的回答，必须结合两者判断。",
                "若项目匹配不唯一或用户目标不完整，scenario必须为clarify。",
                "‘我有哪些项目/查看项目列表’属于明确产品查询，不得改问用户是否新建；应标记query_kind=project_catalog。",
                "简单问答不创建Project或Task。",
                "Project目录来自Product Harness权威查询；不能把摘要候选冒充正式Project。",
                "只输出规定JSON，不要解释。",
            ],
        },
        ensure_ascii=False,
    )


def _plan_task(state: CollaborationState) -> str:
    return json.dumps(
        {
            "user_request": state.origin_prompt,
            "accepted_intent": state.intent,
            "selected_context_summaries": list(state.recent_turn_summaries),
            "selected_project_id": state.selected_project_id,
            "accepted_context_items": list(state.context_items),
            "request": "形成步骤、依赖、HITL检查点、验证方式和停止条件；不要执行工具。",
        },
        ensure_ascii=False,
    )


def _response_task(state: CollaborationState) -> str:
    return json.dumps(
        {
            "user_request": state.origin_prompt,
            "accepted_intent": state.intent,
            "selected_context_summaries": list(state.recent_turn_summaries),
            "selected_project_id": state.selected_project_id,
            "accepted_context_items": list(state.context_items),
            "plan": state.plan,
            "execution_contract": {
                "draft_revision_id": state.execution_draft_revision_id,
                "run_spec_id": state.run_spec_id,
                "tools_allowed": [],
            },
            "request": "给出本轮可直接提交给用户的答复。不要声称未执行的动作已经完成。",
        },
        ensure_ascii=False,
    )


def _summary_task(state: CollaborationState) -> str:
    return json.dumps(
        {
            "user_request": state.origin_prompt,
            "intent": state.intent,
            "assistant_response": state.response,
            "plan": state.plan,
            "rules": [
                "只提取本轮重点，丢弃无关寒暄。",
                "用户或系统明确确认的内容才进入confirmed_facts。",
                "任务和Memory变化只进入candidate数组，不能自动提交。",
                "只输出规定JSON。",
            ],
        },
        ensure_ascii=False,
    )


def create_continuous_collaboration_workflow(
    *,
    thread_id: str,
    run_id: Callable[[], str],
    profiles: Mapping[str, AgentProfileSnapshot],
    store: InMemoryModelCallReviewStore,
    transport: ProviderTransport,
    sessions: ProductSessionService,
    governance: ExecutionGovernanceService,
    harness: HarnessService | None = None,
    checkpoint_storage: CheckpointStorage | None = None,
):
    harness = harness or HarnessService(sessions.database)
    decision_specs = _decision_specs()
    intake = IntakeExecutor(thread_id=thread_id, sessions=sessions, governance=governance)
    candidates = CandidateContextExecutor(thread_id=thread_id, sessions=sessions)
    directory_context = HarnessDirectoryContextExecutor(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        harness=harness,
    )
    context_decision = ProductDecisionExecutor(
        node_id="context_adoption",
        spec=decision_specs["context_adoption"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    intent = GovernedSemanticAgentExecutor(
        profile=profiles["intent_router"], node_id="intent_agent", call_ordinal=1,
        thread_id=thread_id, run_id=run_id, store=store, transport=transport,
        sessions=sessions, governance=governance, task_builder=_intent_task, result_kind="intent",
    )
    intent_decision = ProductDecisionExecutor(
        node_id="intent_binding",
        spec=decision_specs["intent_binding"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    project_resolver = HarnessProjectResolverExecutor(thread_id=thread_id, sessions=sessions)
    project_decision = ProductDecisionExecutor(
        node_id="project_work_binding",
        spec=decision_specs["project_work_binding"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    router = ScenarioRouterExecutor(thread_id=thread_id, sessions=sessions)
    detail_context = HarnessDetailContextExecutor(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        harness=harness,
    )
    project_catalog = ProjectCatalogExecutor(
        thread_id=thread_id,
        sessions=sessions,
        harness=harness,
    )
    planner = GovernedSemanticAgentExecutor(
        profile=profiles["task_planner"], node_id="planning_agent", call_ordinal=2,
        thread_id=thread_id, run_id=run_id, store=store, transport=transport,
        sessions=sessions, governance=governance, task_builder=_plan_task, result_kind="plan",
    )
    plan_decision = ProductDecisionExecutor(
        node_id="plan_acceptance",
        spec=decision_specs["plan_acceptance"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    compiler = ExecutionDraftCompilerExecutor(
        thread_id=thread_id, run_id=run_id, sessions=sessions, governance=governance
    )
    execution_decision = ProductDecisionExecutor(
        node_id="execution_authorization",
        spec=decision_specs["execution_authorization"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    run_spec_compiler = RunSpecCompilerExecutor(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    responder = GovernedSemanticAgentExecutor(
        profile=profiles["response_agent"], node_id="response_agent", call_ordinal=3,
        thread_id=thread_id, run_id=run_id, store=store, transport=transport,
        sessions=sessions, governance=governance, task_builder=_response_task, result_kind="response",
    )
    result_decision = ProductDecisionExecutor(
        node_id="result_commit",
        spec=decision_specs["result_commit"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    work_decision = ProductDecisionExecutor(
        node_id="work_state_commit",
        spec=decision_specs["work_state_commit"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    memory_decision = ProductDecisionExecutor(
        node_id="memory_commit",
        spec=decision_specs["memory_commit"],
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    harness_commit = HarnessCandidateCommitExecutor(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        harness=harness,
    )
    summarizer = GovernedSemanticAgentExecutor(
        profile=profiles["turn_summarizer"], node_id="turn_summary_agent", call_ordinal=4,
        thread_id=thread_id, run_id=run_id, store=store, transport=transport,
        sessions=sessions, governance=governance, task_builder=_summary_task, result_kind="summary",
    )
    clarification = ClarificationExecutor(thread_id=thread_id, sessions=sessions)
    summary_persist = TurnSummaryPersistExecutor(
        thread_id=thread_id,
        run_id=run_id,
        sessions=sessions,
        governance=governance,
    )
    finalizer = FinalizeExecutor(thread_id=thread_id, sessions=sessions)
    return (
        WorkflowBuilder(
            name=WORKFLOW_ID,
            description="Chat主Workflow：选择性上下文、意图、场景路由、计划、响应与回合主题提取。",
            start_executor=intake,
            output_from=[finalizer],
            checkpoint_storage=checkpoint_storage,
        )
        .add_edge(intake, candidates)
        .add_edge(candidates, directory_context)
        .add_edge(directory_context, context_decision)
        .add_edge(context_decision, intent)
        .add_edge(intent, intent_decision)
        .add_edge(intent_decision, project_resolver)
        .add_edge(project_resolver, project_decision)
        .add_edge(project_decision, detail_context)
        .add_edge(detail_context, router)
        .add_switch_case_edge_group(
            router,
            [
                Case(condition=_is_project_catalog_state, target=project_catalog),
                Case(condition=lambda value: value.scenario == "clarify", target=clarification),
                Case(condition=_needs_plan, target=planner),
                Default(target=compiler),
            ],
        )
        .add_edge(planner, plan_decision)
        .add_edge(plan_decision, compiler)
        .add_edge(compiler, execution_decision)
        .add_edge(execution_decision, run_spec_compiler)
        .add_edge(run_spec_compiler, responder)
        .add_edge(responder, summarizer)
        .add_edge(summarizer, result_decision)
        .add_edge(project_catalog, result_decision)
        .add_edge(result_decision, work_decision)
        .add_edge(work_decision, memory_decision)
        .add_edge(memory_decision, harness_commit)
        .add_edge(harness_commit, summary_persist)
        .add_edge(clarification, summary_persist)
        .add_edge(summary_persist, finalizer)
        .build()
    )
