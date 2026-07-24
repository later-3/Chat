"""The selectable Chat Workflow: intent, routing, planning, response and turn focus."""

from __future__ import annotations

import asyncio
import json
import logging
import os
from dataclasses import asdict, dataclass, replace
from typing import Any, Callable, Mapping

from agent_framework import (
    CheckpointStorage,
    Executor,
    WorkflowContext,
    handler,
    response_handler,
)
from agent_framework._workflows._request_info_mixin import RequestInfoMixin

from ..agent_profiles import AgentProfileSnapshot
from ..collaboration_contexts import CollaborationContextService
from ..collaboration_intents import CollaborationIntentService
from ..collaboration_protocols import CollaborationProtocolService
from ..execution_dispatch.drafts import (
    adopted_repository_source,
    compile_execution_draft_v2,
    compile_run_spec_v2,
)
from ..execution_dispatch.repository_context import RepositoryExecutionContextService
from ..execution_dispatch.service import ExecutionDispatchService
from ..execution_dispatch.workflow import (
    ExecutionRouteExecutor,
    PiReadonlyDispatchExecutor,
    PiReadonlyResultAssemblyExecutor,
)
from ..governance.service import ExecutionGovernanceService, GovernanceConflict
from ..harness import HarnessService
from ..model_call_review import (
    InMemoryModelCallReviewStore,
    ModelCallDraft,
    ModelCallDraftConflict,
    PreparedProviderRequest,
    ProviderDispatchError,
)
from ..model_call_workflow import (
    ProviderTransport,
    normalize_agui_messages_for_provider,
)
from ..product_sessions.service import ProductSessionService
from ..project_resources.context import (
    ContextSourceStale,
    RepositorySourceFreshnessGuard,
)
from ..step_inputs import StepInputProjectionService
from .continuous_chat_contracts import (
    CollaborationState,
)
from .continuous_chat_contracts import (
    apply_intent_set_protocol_overlay as _apply_intent_set_protocol_overlay,
)
from .continuous_chat_contracts import (
    apply_summary_writeback_policy as _apply_summary_writeback_policy,
)
from .continuous_chat_contracts import (
    canonical_hash as _hash,
)
from .continuous_chat_contracts import (
    context_keywords as _context_keywords,
)
from .continuous_chat_contracts import (
    context_source_references as _context_source_references,
)
from .continuous_chat_contracts import (
    evaluate_scenario_route as _evaluate_scenario_route,
)
from .continuous_chat_contracts import (
    is_pending_clarification as _is_pending_clarification,
)
from .continuous_chat_contracts import (
    is_project_catalog_query as _is_project_catalog_query,
)
from .continuous_chat_contracts import (
    is_project_catalog_state as _is_project_catalog_state,
)
from .continuous_chat_contracts import (
    json_object as _json_object,
)
from .continuous_chat_contracts import (
    message_text as _message_text,
)
from .continuous_chat_contracts import (
    needs_plan as _needs_plan,
)
from .continuous_chat_contracts import (
    normalize_intent_candidates as _normalize_intent_candidates,
)
from .continuous_chat_contracts import (
    project_catalog_intent as _project_catalog_intent,
)
from .continuous_chat_contracts import (
    project_hint as _project_hint,
)
from .continuous_chat_contracts import (
    render_project_catalog_result as _render_project_catalog_result,
)
from .continuous_chat_contracts import (
    state_from_snapshot as _state_from_snapshot,
)
from .continuous_chat_factory import (
    ContinuousWorkflowComponents,
    build_continuous_collaboration_workflow,
)

logger = logging.getLogger(__name__)

WORKFLOW_ID = "continuous-collaboration"
WORKFLOW_VERSION = "1.6.0"


class TraceMixin:
    def _trace_init(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        self._thread_id = thread_id
        self._sessions = sessions
        self._step_inputs = StepInputProjectionService(sessions.database)

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
        projection: dict[str, Any] | None = None
        if content_type not in {
            "intent",
            "plan",
            "response",
            "summary",
            "context_source_freshness",
        } or actor.startswith("deterministic_"):
            public_input_mapping = (
                dict(public_input) if isinstance(public_input, Mapping) else {"value": public_input}
            )
            projection = await self._step_inputs.record(
                run_id=str(active["id"]),
                workflow_definition_id=WORKFLOW_ID,
                workflow_version=WORKFLOW_VERSION,
                node_id=executor_id,
                input_value=public_input_mapping,
                agent_profile_key=_optional_string(public_input_mapping.get("agent_profile_key")),
                context_package_id=_optional_string(public_input_mapping.get("context_package_id")),
                protocol_definition_id=_optional_string(public_input_mapping.get("protocol_definition_id")),
                protocol_binding_id=_optional_string(public_input_mapping.get("protocol_binding_id")),
                run_spec_id=_optional_string(public_input_mapping.get("run_spec_id")),
                capability_allowlist=list(public_input_mapping.get("capability_allowlist") or []),
                budget=dict(public_input_mapping.get("budget") or {}),
                output_contract={
                    "content_type": content_type,
                    "public_output_kind": type(public_output).__name__,
                },
                stop_conditions=list(public_input_mapping.get("stop_conditions") or []),
            )
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
                "step_input_projection": (
                    {
                        "id": projection["id"],
                        "revision": projection["projection_revision"],
                        "hash": projection["projection_hash"],
                    }
                    if projection is not None
                    else None
                ),
            },
        )


def _optional_string(value: Any) -> str | None:
    normalized = str(value or "").strip()
    return normalized or None


@dataclass(frozen=True, slots=True)
class ModelDispatchResult:
    """Decoded model text plus the durable Provider-attempt identity."""

    text: str
    attempt_id: str


class IntakeExecutor(Executor, TraceMixin):
    def __init__(
        self,
        *,
        thread_id: str,
        sessions: ProductSessionService,
        governance: ExecutionGovernanceService,
        intents: CollaborationIntentService,
    ) -> None:
        super().__init__(id="input_acceptance")
        self._trace_init(thread_id=thread_id, sessions=sessions)
        self._governance = governance
        self._intents = intents

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
        pending_clarification = await self._intents.latest_open_clarification(self._thread_id)
        project_candidates = tuple(
            dict.fromkeys(hint for value in summaries if (hint := _project_hint(value)) is not None)
        )
        state = CollaborationState(
            origin_prompt=prompt,
            recent_turn_summaries=tuple(summaries),
            project_candidates=project_candidates,
            pending_clarification=pending_clarification,
        )
        await self._trace_content(
            executor_id=self.id,
            actor="user",
            content_type="workflow_input",
            public_input=prompt,
            public_output={
                "accepted": True,
                "candidate_summary_count": len(summaries),
                "pending_clarification": pending_clarification,
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
            public_input={
                "prompt": state.origin_prompt,
                "available_summaries": len(state.recent_turn_summaries),
            },
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
    """Resolve Project bindings and required catalog facts from Product Store."""

    def __init__(
        self,
        *,
        thread_id: str,
        sessions: ProductSessionService,
        harness: HarnessService,
    ) -> None:
        super().__init__(id="harness_project_resolver")
        self._harness = harness
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def resolve(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        hint = str((state.intent or {}).get("project_hint") or "").strip().lower()
        matches = [
            value
            for value in state.project_matches
            if hint
            and (
                hint in str(value.get("title") or "").lower() or str(value.get("title") or "").lower() in hint
            )
        ]
        selected = matches[0]["id"] if len(matches) == 1 else state.selected_project_id
        catalog_requested = any(
            value.get("query_kind") == "project_catalog" for value in state.intents or ((state.intent or {}),)
        )
        catalog_result = state.project_catalog_result
        if catalog_requested:
            projects = await self._harness.list_projects(
                statuses=("proposed", "active", "paused", "completed"),
            )
            catalog_result = _render_project_catalog_result(
                projects,
                list(state.project_candidates),
            )
        next_state = replace(
            state,
            selected_project_id=selected,
            project_catalog_result=catalog_result,
        )
        await self._trace_content(
            executor_id=self.id,
            actor="product_harness_resolver",
            content_type="project_resolution",
            public_input={"project_hint": hint, "directory_candidates": list(state.project_matches)},
            public_output={
                "selected_project_id": selected,
                "match_count": len(matches),
                "requires_human_choice": state.scenario == "continue_project" and selected is None,
                "project_catalog_result": catalog_result,
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
        items = await self._harness.detailed_context_items(
            state.selected_project_id,
            prompt=state.origin_prompt,
            scenario=state.scenario,
        )
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


def _state_with_context_package(
    state: CollaborationState,
    package: Mapping[str, Any],
    *,
    stage: str,
) -> CollaborationState:
    """Project one immutable ContextPackage revision into runtime state."""

    adopted = tuple(dict(value) for value in package["items"] if value["adopted"])
    next_state = replace(
        state,
        context_items=adopted,
        directory_context_package_id=(
            str(package["id"]) if stage == "directory" else state.directory_context_package_id
        ),
        detail_context_package_id=(
            str(package["id"]) if stage == "detail" else state.detail_context_package_id
        ),
    )
    if stage != "directory":
        return next_state
    adopted_summary_ids = {
        str(value["source_id"]) for value in adopted if value["source_kind"] == "turn_summary"
    }
    adopted_project_ids = {
        str(value["source_id"]) for value in adopted if value["source_kind"] == "project_directory"
    }
    return replace(
        next_state,
        recent_turn_summaries=tuple(
            value
            for value in state.recent_turn_summaries
            if str(value.get("id") or "") in adopted_summary_ids
        ),
        project_matches=tuple(
            value for value in state.project_matches if str(value.get("id") or "") in adopted_project_ids
        ),
    )


class HarnessContextRevisionExecutor(Executor, TraceMixin):
    """Project the newest user-reviewed ContextPackage revision into Workflow state."""

    def __init__(
        self,
        *,
        node_id: str,
        stage: str,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        harness: HarnessService,
    ) -> None:
        super().__init__(id=node_id)
        if stage not in {"directory", "detail"}:
            raise ValueError(f"Unsupported Context stage: {stage}")
        self._stage = stage
        self._run_id = run_id
        self._harness = harness
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def project(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        package = await self._harness.context_package_for_run(
            run_id=self._run_id(),
            stage=self._stage,
        )
        if package is None:
            await ctx.send_message(state)
            return
        next_state = _state_with_context_package(
            state,
            package,
            stage=self._stage,
        )
        adopted = next_state.context_items
        await self._trace_content(
            executor_id=self.id,
            actor="product_context_projection",
            content_type="context_revision",
            public_input={
                "stage": self._stage,
                "context_package_id": package["id"],
                "revision": package["revision"],
            },
            public_output={
                "adopted_sources": [
                    {
                        "source_kind": value["source_kind"],
                        "source_id": value["source_id"],
                        "source_revision": value["source_revision"],
                        "title": value["title"],
                        "reason": value["reason"],
                    }
                    for value in adopted
                ],
                "excluded_sources": [
                    {
                        "source_kind": value["source_kind"],
                        "source_id": value["source_id"],
                        "source_revision": value["source_revision"],
                        "title": value["title"],
                        "reason": value["reason"],
                    }
                    for value in package["items"]
                    if not value["adopted"]
                ],
            },
        )
        await ctx.send_message(next_state)


class CollaborationProtocolResolverExecutor(Executor, TraceMixin):
    """Bind one immutable Chat Harness method revision to the current turn.

    Resolution is deliberately deterministic and happens after intent and
    authoritative Project binding. The selected revision and applicable rules
    become part of the Workflow checkpoint, ExecutionDraft and public Trace;
    later model calls cannot silently substitute a different method.
    """

    def __init__(
        self,
        *,
        thread_id: str,
        sessions: ProductSessionService,
        collaboration_protocols: CollaborationProtocolService,
    ) -> None:
        super().__init__(id="collaboration_protocol_resolver")
        self._protocols = collaboration_protocols
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def resolve(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        intent = state.intent or {}
        selection = await self._protocols.resolve_for_turn(
            scenario=state.scenario,
            project_id=state.selected_project_id,
            query_kind=str(intent.get("query_kind") or "") or None,
        )
        selection = _apply_intent_set_protocol_overlay(
            selection,
            state.intents or (intent,),
        )
        next_state = replace(state, protocol_selection=selection)
        await self._trace_content(
            executor_id=self.id,
            actor="chat_harness_protocol_resolver",
            content_type="collaboration_protocol_selection",
            public_input={
                "scenario": state.scenario,
                "query_kind": intent.get("query_kind"),
                "selected_project_id": state.selected_project_id,
                "resolution_order": ["work_item", "project", "user", "system"],
                "protocol_definition_id": selection["definition_id"],
                "protocol_binding_id": selection["binding_id"],
                "protocol_key": selection["protocol_key"],
                "protocol_name": selection["protocol_name"],
                "protocol_revision": selection["revision"],
                "selection_source": selection["selection_source"],
                "selection_reason": selection["selection_reason"],
                "phases": selection["phases"],
                "applicable_rules": selection["applicable_rules"],
                "budget": {"token_budget": selection["context_policy"].get("default_token_budget")},
                "base_execution_policy": selection.get(
                    "base_execution_policy",
                    selection.get("execution_policy"),
                ),
                "effective_execution_policy": selection.get("execution_policy"),
                "composition_overlay": selection.get("composition_overlay"),
            },
            public_output={
                "protocol_key": selection["protocol_key"],
                "protocol_name": selection["protocol_name"],
                "revision": selection["revision"],
                "definition_id": selection["definition_id"],
                "binding_id": selection["binding_id"],
                "definition_hash": selection["definition_hash"],
                "selection_hash": selection["selection_hash"],
                "effective_selection_hash": selection.get(
                    "effective_selection_hash",
                    selection["selection_hash"],
                ),
                "selection_source": selection["selection_source"],
                "selection_reason": selection["selection_reason"],
                "phases": selection["phases"],
                "applicable_rules": selection["applicable_rules"],
                "base_execution_policy": selection.get(
                    "base_execution_policy",
                    selection.get("execution_policy"),
                ),
                "effective_execution_policy": selection.get("execution_policy"),
                "composition_overlay": selection.get("composition_overlay"),
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
        harness: HarnessService | None = None,
        collaboration_contexts: CollaborationContextService | None = None,
    ) -> None:
        super().__init__(id=node_id)
        self.spec = spec
        self._run_id = run_id
        self._governance = governance
        self._harness = harness
        self._collaboration_contexts = collaboration_contexts
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
            subject = await self._governance.execution_draft_subject(state.execution_draft_revision_id)
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
        context_state: CollaborationState | None = None
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
        context_state = await self._revise_directory_context_if_needed(
            state=state,
            action=action,
            decision=decision,
            request_id=str(original_request["decision_request_id"]),
        )
        if action == "revise":
            if context_state is not None:
                await self._advance(context_state, ctx)
                return
            changes = decision.get("changes")
            if not isinstance(changes, Mapping):
                raise ValueError("修改决定必须提供结构化changes")
            await self._advance(self.spec.revise(state, changes), ctx)
            return
        if action == "skip":
            await self._trace_decision(state, self.spec.subject(state), "skipped", "用户本轮跳过")
            if context_state is not None:
                await ctx.send_message(context_state)
                return
            changes: Mapping[str, Any] = {"skip": True}
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

    async def _revise_directory_context_if_needed(
        self,
        *,
        state: CollaborationState,
        action: str,
        decision: Mapping[str, Any],
        request_id: str,
    ) -> CollaborationState | None:
        """Persist context revise/skip before the checkpoint advances.

        The Workflow checkpoint contains an exact package revision. A retry
        therefore reads that revision by id and replays one deterministic
        command, even if the first attempt committed the new revision before
        process loss.
        """

        if self.id != "context_adoption" or action not in {"revise", "skip"}:
            return None
        if self._harness is None or self._collaboration_contexts is None:
            raise RuntimeError("Context决定缺少Harness应用协调依赖")
        package_id = state.directory_context_package_id
        if package_id is None:
            raise GovernanceConflict("Context决定缺少绑定的ContextPackage")
        package = await self._harness.context_package_by_id(package_id)
        if package is None:
            raise GovernanceConflict("ContextPackage已不存在，请重新准备本轮")
        changes = decision.get("changes")
        if action == "revise":
            if not isinstance(changes, Mapping):
                raise ValueError("修改决定必须提供结构化changes")
            selected = changes.get("selected_summary_ids")
            if not isinstance(selected, list) or not all(isinstance(value, str) for value in selected):
                raise ValueError("Context修改必须提供selected_summary_ids")
            selected_ids = set(selected)
        else:
            selected_ids = set()
        item_changes: list[dict[str, Any]] = []
        for item in package["items"]:
            desired = (
                False
                if action == "skip"
                else (
                    str(item["source_id"]) in selected_ids
                    if item["source_kind"] == "turn_summary"
                    else bool(item["adopted"])
                )
            )
            if desired == bool(item["adopted"]):
                continue
            item_changes.append(
                {
                    "ordinal": int(item["ordinal"]),
                    "adopted": desired,
                    "reason": (
                        "用户在Workflow中跳过本轮目录Context"
                        if action == "skip"
                        else "用户在Workflow中调整采用的回合重点"
                    ),
                }
            )
        if not item_changes:
            raise ValueError("Context没有发生变化；如无需修改请直接接受")
        revised = await self._collaboration_contexts.revise_package(
            package_id=package["id"],
            command_id=f"workflow-context:{request_id}:{action}",
            expected_package_hash=package["package_hash"],
            reason=(
                "用户在Workflow决定点跳过本轮目录Context"
                if action == "skip"
                else "用户在Workflow决定点修改本轮目录Context"
            ),
            item_changes=item_changes,
        )
        return _state_with_context_package(state, revised, stage="directory")


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
        repository_freshness: RepositorySourceFreshnessGuard | None = None,
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
        self._repository_freshness = repository_freshness
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @property
    def description(self) -> str:
        return self.profile.description

    def _begin(self, state: CollaborationState) -> ModelCallDraft:
        task = self._task_builder(state)
        context_package_id = state.detail_context_package_id or state.directory_context_package_id
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
                "context_package_id": context_package_id,
                "repository_source_revisions": [
                    {
                        "source_kind": value.get("source_kind"),
                        "source_id": value.get("source_id"),
                        "source_revision": value.get("source_revision"),
                        "title": value.get("title"),
                        "adoption_reason": value.get("reason"),
                    }
                    for value in state.context_items
                    if str(value.get("source_kind") or "").startswith("repository_")
                    or (
                        value.get("source_kind") == "user_override"
                        and ":" in str(value.get("source_id") or "")
                    )
                ],
            },
        )

    @handler(input=CollaborationState)
    async def prepare(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState, str],
    ) -> None:
        if self._result_kind == "intent" and _is_project_catalog_query(state.origin_prompt):
            intent = _project_catalog_intent(state.origin_prompt)
            await self._trace_content(
                executor_id=self.id,
                actor="deterministic_intent_guard",
                content_type="intent",
                public_input={"origin_prompt": state.origin_prompt},
                public_output={
                    **intent,
                    "execution_mode": "deterministic_guard",
                    "model_call_count": 0,
                    "reason": "明确的Product目录查询直接进入权威查询分支",
                },
            )
            await ctx.send_message(
                replace(
                    state,
                    intent=intent,
                    intents=(intent,),
                    scenario=str(intent["scenario"]),
                )
            )
            return
        await self._advance(self._begin(state), state, ctx)

    async def _advance(
        self,
        draft: ModelCallDraft,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState, str],
    ) -> None:
        freshness = await self._require_fresh_context(
            state,
            phase="draft_prepare",
        )
        card = draft.review_card()
        effective_context = card.get("effective_context")
        if isinstance(effective_context, dict):
            sources = self._knowledge_sources(state)
            effective_context["knowledge_sources"] = sources
            adoption_reasons = effective_context.get("adoption_reasons")
            if isinstance(adoption_reasons, dict):
                adoption_reasons["history_and_knowledge"] = (
                    "消息数组与独立Context来源都从同一Provider请求草稿派生；每个来源公开采用原因和版本"
                )
                adoption_reasons["knowledge_sources"] = (
                    "本轮明确采用的Project、Repository、规则、摘要、笔记与Memory；正文已实际编入当前任务消息"
                )
        execution_context = card.setdefault("execution_context", {})
        if isinstance(execution_context, dict):
            execution_context["context_freshness"] = freshness
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
        if isinstance(execution_context, dict):
            execution_context["governance"] = governance_view
        await self._trace_content(
            executor_id=self.id,
            actor=self.profile.name,
            content_type="model_call_draft",
            public_input={
                "task": self._task_builder(state),
                "selected_turn_summaries": list(state.recent_turn_summaries),
                "agent_profile_key": self.profile.id,
                "context_package_id": (state.detail_context_package_id or state.directory_context_package_id),
                "context_sources": self._knowledge_sources(state),
                "protocol_definition_id": ((state.protocol_selection or {}).get("definition_id")),
                "protocol_binding_id": ((state.protocol_selection or {}).get("binding_id")),
                "run_spec_id": state.run_spec_id,
                "capability_allowlist": [],
                "budget": {
                    "token_budget": (
                        (state.protocol_selection or {}).get("context_policy", {}).get("default_token_budget")
                    ),
                    "model_calls": 1,
                },
                "stop_conditions": [
                    "模型调用必须先通过当前ModelCallDraft授权",
                    "结构输出无效时关闭失败，不猜测状态",
                ],
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
            dispatched = await self._dispatch(
                draft,
                revision,
                grant_id=grant.id,
                binding_hash=revision.binding_hash,
                state=state,
                request_id=None,
            )
            if dispatched is not None:
                await self._deliver(dispatched, state, revision.id, ctx)
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

    async def _dispatch(
        self,
        draft,
        revision,
        *,
        grant_id: str,
        binding_hash: str,
        state: CollaborationState,
        request_id: str | None,
    ) -> ModelDispatchResult | None:
        await self._require_fresh_context(
            state,
            phase="provider_dispatch",
            revision_id=revision.id,
            request_id=request_id,
        )
        try:
            await self._sessions.mark_running(self._thread_id)
            claimed = self._store.claim(
                approval_id=draft.approval_id,
                expected_hash=draft.binding_hash,
                owner=f"api-pid-{os.getpid()}:{self.id}",
            )
        except ModelCallDraftConflict:
            return None
        consumption = await self._governance.claim_grant(
            grant_id=grant_id,
            binding_hash=binding_hash,
            consumer_kind="model_call_attempt",
            consumer_id=revision.id,
            idempotency_key=f"model-call:{revision.id}",
            claimed_by=f"api-pid-{os.getpid()}:{self.id}",
        )
        attempt = await self._governance.start_model_call_attempt(
            revision=revision,
            consumption=consumption,
        )
        chunks: list[str] = []
        dispatch_started = False

        async def report_provider_stage(
            stage: str,
            status: str,
            details: dict[str, Any],
        ) -> None:
            nonlocal dispatch_started
            starts_dispatch = stage == "provider.dispatch" and status == "in_progress"
            try:
                await self._governance.record_model_call_transport_event(
                    attempt_id=attempt.id,
                    stage=stage,
                    status=status,
                    details=details,
                )
            except Exception as error:
                raise ProviderDispatchError(
                    "模型调用审计写入失败，已停止继续处理Provider结果。",
                    error_code="model_call_audit_failed",
                    outcome_status="outcome_unknown" if dispatch_started else "failed",
                ) from error
            if starts_dispatch:
                dispatch_started = True

        try:
            prepared = PreparedProviderRequest.from_draft(
                claimed,
                stage_reporter=report_provider_stage,
            )
            async for text in self._transport.stream(prepared):
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
            self._store.mark_attempt(
                draft.approval_id, "outcome_unknown", error_code="provider_dispatch_cancelled"
            )
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
        decoded_text = "".join(chunks)
        await self._governance.finish_model_call_attempt(
            attempt_id=attempt.id,
            status="completed",
            output_text=decoded_text,
        )
        return ModelDispatchResult(
            text=decoded_text or "模型调用已完成，但没有返回可显示的文本。",
            attempt_id=attempt.id,
        )

    def _knowledge_sources(self, state: CollaborationState) -> list[dict[str, Any]]:
        if self._result_kind == "summary":
            return [
                {
                    "source_type": value["kind"],
                    "source_id": value["id"],
                    "source_revision": value.get("revision"),
                    "source_label": value.get("title"),
                    "adoption_reason": value.get("adoption_reason"),
                    "selection_origin": value.get("selection_origin"),
                    "modified_in_review": value["kind"] == "user_override",
                    "content_mode": "reference_only",
                }
                for value in _context_source_references(state.context_items)
            ]
        return [
            {
                "source_type": value.get("source_kind"),
                "source_id": value.get("source_id"),
                "source_revision": value.get("source_revision"),
                "source_label": value.get("title"),
                "adoption_reason": value.get("reason"),
                "selection_origin": value.get("selection_origin"),
                "modified_in_review": value.get("source_kind") == "user_override",
                "token_estimate": value.get("token_estimate"),
                "content": value.get("content"),
            }
            for value in state.context_items
            if value.get("adopted", True)
        ]

    async def _require_fresh_context(
        self,
        state: CollaborationState,
        *,
        phase: str,
        revision_id: str | None = None,
        request_id: str | None = None,
    ) -> dict[str, Any]:
        package_id = state.detail_context_package_id or state.directory_context_package_id
        if self._repository_freshness is None:
            return {
                "fresh": True,
                "context_package_id": package_id,
                "sources": [],
                "guard": "not_configured",
            }
        try:
            report = await self._repository_freshness.assert_package_fresh(package_id)
        except ContextSourceStale as error:
            logger.warning(
                "repository_context_gate phase=%s context_package_id=%s result=stale reason_code=%s",
                phase,
                package_id,
                error.reason_code,
            )
            if revision_id is not None:
                await self._governance.invalidate_model_call_source(
                    revision_id=revision_id,
                    request_id=request_id,
                    reason_code=error.code.lower(),
                )
            await self._trace_content(
                executor_id=self.id,
                actor="context_source_freshness_guard",
                content_type="context_source_freshness",
                public_input={
                    "phase": phase,
                    "context_package_id": package_id,
                },
                public_output={
                    "status": "stale",
                    "error_code": error.code.lower(),
                    "reason_code": error.reason_code,
                    "recovery_actions": ["reprepare", "stop"],
                },
            )
            await self._sessions.fail_active_run(
                self._thread_id,
                status="failed",
                error_code=error.code.lower(),
                message=("仓库上下文已变化，旧请求未发送。请按最新仓库重新准备，或停止本轮。"),
            )
            raise
        logger.info(
            "repository_context_gate phase=%s context_package_id=%s result=fresh sources=%d",
            phase,
            package_id,
            len(report.get("sources") or []),
        )
        await self._trace_content(
            executor_id=self.id,
            actor="context_source_freshness_guard",
            content_type="context_source_freshness",
            public_input={
                "phase": phase,
                "context_package_id": package_id,
            },
            public_output={
                "status": "fresh",
                "source_count": len(report.get("sources") or []),
                "source_revisions": [
                    {
                        "binding_id": value.get("binding_id"),
                        "semantic_hash": value.get("semantic_hash"),
                        "snapshot_sequence": value.get("snapshot_sequence"),
                    }
                    for value in report.get("sources") or []
                ],
            },
        )
        return {**report, "guard": "repository_source_freshness_v1"}

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
        revision_id = str(governance_view.get("model_call_revision_id") or "")
        from ..governance.models import ModelCallDraftRevisionRecord

        async with self._governance.database.sessions() as transaction:
            revision = await transaction.get(ModelCallDraftRevisionRecord, revision_id)
            if revision is None:
                raise RuntimeError("持久ModelCall revision不存在")
        await self._require_fresh_context(
            state,
            phase="approval",
            revision_id=revision.id,
            request_id=request_id,
        )
        resolved = pre_recorded or await self._governance.resolve_single_human_request(
            request_id=request_id,
            expected_request_hash=request_hash,
            expected_row_version=row_version,
            decision="approve",
        )
        grant_id = str(resolved.get("authorization_grant_id") or "")
        draft = restored_draft
        dispatched = await self._dispatch(
            draft,
            revision,
            grant_id=grant_id,
            binding_hash=str(resolved["binding_hash"]),
            state=state,
            request_id=request_id,
        )
        if dispatched is None:
            await ctx.yield_output("该授权已失效或已消费，没有重复发送模型请求。")
            return
        await self._deliver(dispatched, state, revision.id, ctx)

    async def _deliver(
        self,
        dispatched: ModelDispatchResult,
        state,
        revision_id,
        ctx,
    ) -> None:
        text = dispatched.text
        disposition = f"accepted_as_{self._result_kind}"
        disposition_reason = f"Provider解码文本已由{self.id}作为{self._result_kind}采用"
        if self._result_kind == "intent":
            parsed = _json_object(text)
            if _is_project_catalog_query(state.origin_prompt):
                candidates = (_project_catalog_intent(state.origin_prompt),)
                disposition = "overridden_by_deterministic_guard"
                disposition_reason = "恢复旧Checkpoint时命中明确项目清单查询，模型候选未被采用"
            else:
                candidates = _normalize_intent_candidates(
                    parsed,
                    origin_prompt=state.origin_prompt,
                )
            pending_id = str((state.pending_clarification or {}).get("id") or "")
            candidates = tuple(
                {
                    **candidate,
                    "answers_clarification_id": (
                        pending_id
                        if pending_id and candidate.get("answers_clarification_id") == pending_id
                        else None
                    ),
                }
                for candidate in candidates
            )
            if (
                len(candidates) == 1
                and candidates[0]["scenario"] == "clarify"
                and float(candidates[0].get("confidence") or 0) == 0
            ):
                disposition = "rejected_invalid_output"
                disposition_reason = "意图模型输出未通过多意图结构校验，已关闭失败为澄清"
            primary = dict(candidates[0])
            next_state = replace(
                state,
                intent=primary,
                intents=candidates,
                scenario=str(primary["scenario"]),
                last_model_call_revision_id=revision_id,
            )
            public_output: Any = {
                "intent_count": len(candidates),
                "combination_policy": "single" if len(candidates) == 1 else "sequential",
                "intents": list(candidates),
            }
        elif self._result_kind == "plan":
            next_state = replace(state, plan=text, last_model_call_revision_id=revision_id)
            public_output = text
        elif self._result_kind == "response":
            next_state = replace(state, response=text, last_model_call_revision_id=revision_id)
            public_output = text
        elif self._result_kind == "summary":
            summary = _json_object(text)
            if summary is None:
                summary = {
                    "topic": state.intent.get("goal") if state.intent else state.origin_prompt[:80],
                    "confirmed_facts": [],
                    "decisions": [],
                    "open_questions": [],
                    "project_hint": state.intent.get("project_hint") if state.intent else None,
                    "work_state_candidates": [],
                    "memory_candidates": [],
                    "extraction_warning": "模型未返回有效JSON，仅保存最小主题候选。",
                }
                disposition = "rejected_invalid_output"
                disposition_reason = "主题摘取输出不是有效JSON，已保存确定性最小候选"
            summary, suppressions = _apply_summary_writeback_policy(
                summary,
                origin_prompt=state.origin_prompt,
            )
            if suppressions:
                disposition = "accepted_with_writeback_filter"
                disposition_reason = "模型摘要已采用，但违反用户只读边界的Work/Memory候选被确定性移除"
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
                "candidate_suppressions": suppressions,
                "note": "Work/Memory仍是候选，不会自动成为长期事实。",
            }
        else:
            raise RuntimeError(f"未知语义结果类型: {self._result_kind}")
        await self._governance.record_model_output_disposition(
            attempt_id=dispatched.attempt_id,
            disposition=disposition,
            reason=disposition_reason,
        )
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


class IntentSetProjectionExecutor(Executor, TraceMixin):
    """Persist model candidates before any product decision can accept them."""

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        intents: CollaborationIntentService,
    ) -> None:
        super().__init__(id="intent_set_projection")
        self._run_id = run_id
        self._intents = intents
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def project(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        candidates = state.intents or ((state.intent or {}),)
        pending_id = str((state.pending_clarification or {}).get("id") or "")
        answers_pending = bool(
            pending_id
            and any(str(value.get("answers_clarification_id") or "") == pending_id for value in candidates)
        )
        answered = None
        if answers_pending:
            answered = await self._intents.answer_latest_open(
                session_id=self._thread_id,
                answering_run_id=self._run_id(),
                answer_text=state.origin_prompt,
            )
        projected = await self._intents.record_candidate(
            run_id=self._run_id(),
            origin_prompt=state.origin_prompt,
            intents=candidates,
            source_model_call_revision_id=state.last_model_call_revision_id,
            combination_policy="single" if len(candidates) == 1 else "sequential",
        )
        next_state = replace(
            state,
            intent_set_id=projected["id"],
            intent_set_revision_id=projected["current_revision"]["id"],
            intent_set_revision_hash=projected["current_revision"]["revision_hash"],
            answered_clarification=answered,
        )
        await self._trace_content(
            executor_id=self.id,
            actor="deterministic_intent_projector",
            content_type="intent_set",
            public_input={
                "candidate_count": len(candidates),
                "pending_clarification_id": pending_id or None,
                "answers_pending_clarification": answers_pending,
            },
            public_output={
                "intent_set_id": projected["id"],
                "revision": projected["current_revision"]["revision"],
                "revision_hash": projected["current_revision"]["revision_hash"],
                "combination_policy": projected["current_revision"]["combination_policy"],
                "execution_order": projected["current_revision"]["execution_order"],
                "status": projected["status"],
                "answered_clarification_id": answered["id"] if answered else None,
            },
        )
        await ctx.send_message(next_state)


class IntentSetAcceptanceExecutor(Executor, TraceMixin):
    """Reconcile a reviewed primary intent and accept the exact set revision."""

    def __init__(
        self,
        *,
        thread_id: str,
        run_id: Callable[[], str],
        sessions: ProductSessionService,
        intents: CollaborationIntentService,
    ) -> None:
        super().__init__(id="intent_set_acceptance")
        self._run_id = run_id
        self._intents = intents
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def accept(
        self,
        state: CollaborationState,
        ctx: WorkflowContext[CollaborationState],
    ) -> None:
        candidates = state.intents or ((state.intent or {}),)
        projected = await self._intents.record_candidate(
            run_id=self._run_id(),
            origin_prompt=state.origin_prompt,
            intents=candidates,
            source_model_call_revision_id=state.last_model_call_revision_id,
            author_kind="workflow_review",
            combination_policy="single" if len(candidates) == 1 else "sequential",
        )
        accepted = False
        if state.scenario != "clarify":
            projected = await self._intents.accept_current(
                intent_set_id=projected["id"],
                expected_revision_hash=projected["current_revision"]["revision_hash"],
            )
            accepted = True
        next_state = replace(
            state,
            intent_set_id=projected["id"],
            intent_set_revision_id=projected["current_revision"]["id"],
            intent_set_revision_hash=projected["current_revision"]["revision_hash"],
        )
        await self._trace_content(
            executor_id=self.id,
            actor="deterministic_intent_acceptance",
            content_type="intent_set_acceptance",
            public_input={
                "intent_set_id": projected["id"],
                "scenario": state.scenario,
                "candidate_count": len(candidates),
            },
            public_output={
                "accepted": accepted,
                "status": projected["status"],
                "revision": projected["current_revision"]["revision"],
                "revision_hash": projected["current_revision"]["revision_hash"],
                "note": (
                    "澄清Intent保持candidate，等待下一条用户输入"
                    if not accepted
                    else "当前不可变Intent Set revision已接受"
                ),
            },
        )
        await ctx.send_message(next_state)


class ScenarioRouterExecutor(Executor, TraceMixin):
    def __init__(self, *, thread_id: str, sessions: ProductSessionService) -> None:
        super().__init__(id="scenario_router")
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def route(self, state: CollaborationState, ctx: WorkflowContext[CollaborationState]) -> None:
        route_decision = _evaluate_scenario_route(state)
        await self._trace_content(
            executor_id=self.id,
            actor="deterministic_scenario_router",
            content_type="scenario_route",
            public_input=state.intent,
            public_output={
                "scenario": state.scenario,
                "branch": route_decision["selected_branch"],
                "route_decision": route_decision,
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
        catalog_result = state.project_catalog_result
        if catalog_result is None:
            projects = await self._harness.list_projects(
                statuses=("proposed", "active", "paused", "completed"),
            )
            catalog_result = _render_project_catalog_result(
                projects,
                list(state.project_candidates),
            )
        projects = list(catalog_result["formal_projects"])
        response = str(catalog_result["assistant_response"])
        summary = {
            "topic": "查看现有项目列表",
            "confirmed_facts": [
                {
                    "text": f"当前正式Project数量为{len(projects)}",
                    "source_refs": [
                        {
                            "kind": "product_query",
                            "id": "project_catalog",
                        }
                    ],
                }
            ],
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
                **catalog_result,
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
        repository_execution_context: RepositoryExecutionContextService,
        pi_available: bool,
    ) -> None:
        super().__init__(id="execution_draft_compiler")
        self._run_id = run_id
        self._governance = governance
        self._repository_execution_context = repository_execution_context
        self._pi_available = pi_available
        self._trace_init(thread_id=thread_id, sessions=sessions)

    @handler(input=CollaborationState)
    async def compile(self, state: CollaborationState, ctx: WorkflowContext[CollaborationState]) -> None:
        repository_fence = None
        source = adopted_repository_source(state.context_items)
        if state.selected_project_id and source is not None:
            repository_fence = await self._repository_execution_context.resolve_fence(
                project_id=state.selected_project_id,
                binding_id=source["binding_id"],
                expected_semantic_hash=source["semantic_hash"],
            )
        payload, brief = compile_execution_draft_v2(
            state=state,
            thread_id=self._thread_id,
            run_id=self._run_id(),
            workflow_id=WORKFLOW_ID,
            workflow_version=WORKFLOW_VERSION,
            repository_fence=repository_fence,
            pi_available=self._pi_available,
        )
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
            public_input={
                "intent": state.intent,
                "plan": state.plan,
                "context_package_id": (state.detail_context_package_id or state.directory_context_package_id),
                "repository_fence": repository_fence.public_view() if repository_fence else None,
            },
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
        accepted = await self._governance.accepted_execution_draft(state.execution_draft_revision_id)
        spec_payload = compile_run_spec_v2(
            accepted=accepted,
            state=state,
            thread_id=self._thread_id,
            run_id=self._run_id(),
            workflow_id=WORKFLOW_ID,
            workflow_version=WORKFLOW_VERSION,
        )
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
        summary = dict(
            state.turn_summary
            or {
                "topic": (state.intent or {}).get("goal") or state.origin_prompt[:80],
                "confirmed_facts": [],
                "decisions": [],
                "open_questions": [],
                "project_hint": (state.intent or {}).get("project_hint"),
                "work_state_candidates": [],
                "memory_candidates": [],
                "extraction_warning": "本轮未形成模型摘要，保存确定性的最小主题候选。",
            }
        )
        persisted = await self._governance.save_turn_summary(
            session_id=self._thread_id,
            run_id=self._run_id(),
            summary=summary,
            source_model_call_revision_id=state.last_model_call_revision_id,
            product_fact_refs=_committed_product_fact_refs(state.harness_commit_results),
        )
        persisted_digest = dict(persisted["summary"])
        next_state = replace(state, turn_summary=persisted_digest)
        await self._trace_content(
            executor_id=self.id,
            actor="turn_summary_repository",
            content_type="turn_summary_commit",
            public_input={
                "topic": persisted_digest.get("topic"),
                "work_state_candidates": persisted_digest.get("work_state_candidates") or [],
                "memory_candidates": persisted_digest.get("memory_candidates") or [],
            },
            public_output={
                "turn_summary_id": persisted["id"],
                "summary_hash": persisted["summary_hash"],
                "status": persisted["status"],
                "note": "摘要是可追溯的回合派生候选；不替代原始Message，也不自动成为Work或Accepted Memory。",
            },
        )
        await ctx.send_message(next_state)


def _committed_product_fact_refs(
    result: Mapping[str, Any] | None,
) -> list[dict[str, Any]]:
    """Project committed Harness results into TurnDigest references."""

    if not result:
        return []
    refs: list[dict[str, Any]] = []
    for kind, key in (
        ("work_item", "work_items"),
        ("accepted_memory", "accepted_memory"),
    ):
        for value in result.get(key) or []:
            if not isinstance(value, Mapping) or not value.get("id"):
                continue
            refs.append(
                {
                    "kind": kind,
                    "id": str(value["id"]),
                    **({"revision": value["row_version"]} if value.get("row_version") is not None else {}),
                }
            )
    return refs


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
    if "intents" in changes:
        raw_intents = changes["intents"]
        if not isinstance(raw_intents, list) or not 1 <= len(raw_intents) <= 4:
            raise ValueError("Intent Set必须包含1到4个Intent")
        if not all(isinstance(value, Mapping) for value in raw_intents):
            raise ValueError("Intent Set中的每个Intent都必须是结构化对象")
        revised_intents = _normalize_intent_candidates(
            {"intents": raw_intents},
            origin_prompt=state.origin_prompt,
        )
        if (
            len(revised_intents) == 1
            and revised_intents[0]["scenario"] == "clarify"
            and revised_intents[0]["confidence"] == 0
        ):
            raise ValueError(str(revised_intents[0]["reason_summary"]))
        primary = dict(revised_intents[0])
        return replace(
            state,
            intent=primary,
            intents=revised_intents,
            scenario=str(primary["scenario"]),
        )
    current = dict(state.intent or {})
    for key in ("scenario", "goal", "project_hint", "needs_plan", "clarification_question"):
        if key in changes:
            current[key] = changes[key]
    scenario = str(current.get("scenario") or "clarify")
    if scenario not in {
        "simple_question",
        "continue_project",
        "new_task",
        "plan_request",
        "learning",
        "clarify",
    }:
        raise ValueError("意图场景无效")
    current["confidence"] = 1.0
    current["needs_clarification"] = scenario == "clarify"
    remaining = state.intents[1:] if state.intents else ()
    return replace(
        state,
        intent=current,
        intents=(current, *remaining),
        scenario=scenario,
    )


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
                    "cross_project": len(
                        {
                            str(value.get("project_hint"))
                            for value in state.recent_turn_summaries
                            if value.get("project_hint")
                        }
                    )
                    > 1,
                    "source_invalid": False,
                }
            },
            editable_fields=lambda state: (
                [
                    {
                        "key": "selected_summary_ids",
                        "label": "采用的主题摘要",
                        "type": "multi_select",
                        "value": [str(value.get("id")) for value in state.recent_turn_summaries],
                        "options": [
                            {"value": str(value.get("id")), "label": str(value.get("topic") or "未命名主题")}
                            for value in state.recent_turn_summaries
                        ],
                    }
                ]
                if state.recent_turn_summaries
                else []
            ),
            revise=_revise_context,
            allow_skip=True,
        ),
        "detail_context_adoption": ProductDecisionSpec(
            key="context_adoption",
            subject_kind="context_package",
            title="确认本轮采用的项目与仓库信息",
            description=(
                "确认将进入后续计划和响应的Project、Repository Snapshot与治理规则；"
                "需要调整时可先在本轮协作信息中采用、排除或载入正文。"
            ),
            accept_action="accept",
            applicable=lambda state: state.detail_context_package_id is not None,
            subject=lambda state: {
                "context_package_id": state.detail_context_package_id,
                "sources": [
                    {
                        "source_kind": value.get("source_kind"),
                        "source_id": value.get("source_id"),
                        "source_revision": value.get("source_revision"),
                        "title": value.get("title"),
                        "adopted": value.get("adopted"),
                        "reason": value.get("reason"),
                        "token_estimate": value.get("token_estimate"),
                    }
                    for value in state.context_items
                ],
            },
            facts=lambda state: {
                "context": {
                    "requires_review": False,
                    "cross_project": False,
                    "source_invalid": False,
                    "repository_source_count": sum(
                        str(value.get("source_kind") or "").startswith("repository_")
                        for value in state.context_items
                    ),
                }
            },
            editable_fields=lambda state: [],
            revise=lambda state, changes: state,
            allow_skip=False,
        ),
        "intent_binding": ProductDecisionSpec(
            key="intent_binding",
            subject_kind="intent",
            title="确认我对本轮意图的理解",
            description="确认目标和场景，避免把简单询问误建成任务或关联到错误Project。",
            accept_action="accept",
            applicable=lambda state: state.intent is not None and state.scenario != "clarify",
            subject=lambda state: {
                "intent_set_id": state.intent_set_id,
                "combination_policy": "single" if len(state.intents) <= 1 else "sequential",
                "intents": list(state.intents or ((state.intent or {}),)),
            },
            facts=lambda state: {
                "intent": {
                    "confidence": float((state.intent or {}).get("confidence") or 0),
                    "changes_active_work": False,
                    "ambiguous": state.scenario == "clarify",
                }
            },
            editable_fields=lambda state: [
                {
                    "key": "intents",
                    "label": "本轮Intent Set",
                    "type": "intent_set",
                    "value": list(state.intents or ((state.intent or {}),)),
                }
            ],
            revise=_revise_intent,
        ),
        "project_work_binding": ProductDecisionSpec(
            key="project_work_binding",
            subject_kind="work_binding",
            title="确认本轮关联的 Project / Work",
            description="只有明确关联后，Project状态才会进入后续上下文候选。",
            accept_action="accept",
            applicable=lambda state: (
                bool((state.intent or {}).get("project_hint")) or state.scenario == "continue_project"
            ),
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
            editable_fields=lambda state: [
                {
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
                }
            ],
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
            facts=lambda state: {
                "plan": {"risk_level": 0, "expands_capability": False, "boundary_unclear": False}
            },
            editable_fields=lambda state: [
                {"key": "plan_text", "label": "计划", "type": "long_text", "value": state.plan or ""}
            ],
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
            facts=lambda state: {
                "execution": {"risk_level": 0, "has_side_effects": False, "goal_incomplete": False}
            },
            editable_fields=lambda state: [
                {
                    "key": "execution_draft_revision_id",
                    "label": "ExecutionDraft完整工作台",
                    "type": "execution_draft",
                    "value": state.execution_draft_revision_id,
                }
            ],
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
            facts=lambda state: {
                "result": {
                    "evidence_sufficient": True,
                    "external_delivery": False,
                    "changes_long_term_state": False,
                }
            },
            editable_fields=lambda state: [
                {
                    "key": "response_text",
                    "label": "提交给会话的答复",
                    "type": "long_text",
                    "value": state.response or "",
                }
            ],
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
            subject=lambda state: {
                "candidates": (state.turn_summary or {}).get("work_state_candidates") or []
            },
            facts=lambda state: {
                "work": {"creates_or_deletes": False, "claims_completion_without_evidence": False}
            },
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
            facts=lambda state: {
                "memory": {"candidate_count": len((state.turn_summary or {}).get("memory_candidates") or [])}
            },
            editable_fields=lambda state: [],
            revise=lambda state, changes: _revise_summary_candidates(state, changes, "memory_candidates"),
            allow_skip=True,
            grant_kind="commit_memory",
        ),
    }


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
    collaboration_protocols: CollaborationProtocolService | None = None,
    collaboration_intents: CollaborationIntentService | None = None,
    collaboration_contexts: CollaborationContextService | None = None,
    repository_freshness: RepositorySourceFreshnessGuard | None = None,
    repository_execution_context: RepositoryExecutionContextService,
    pi_available: bool,
    execution_dispatch: ExecutionDispatchService,
    checkpoint_storage: CheckpointStorage | None = None,
):
    """Compatibility entrypoint delegating graph wiring to its composition module."""

    return build_continuous_collaboration_workflow(
        components=ContinuousWorkflowComponents(
            workflow_id=WORKFLOW_ID,
            intake=IntakeExecutor,
            candidates=CandidateContextExecutor,
            directory_context=HarnessDirectoryContextExecutor,
            decision=ProductDecisionExecutor,
            semantic_agent=GovernedSemanticAgentExecutor,
            intent_projection=IntentSetProjectionExecutor,
            intent_acceptance=IntentSetAcceptanceExecutor,
            project_resolver=HarnessProjectResolverExecutor,
            protocol_resolver=CollaborationProtocolResolverExecutor,
            router=ScenarioRouterExecutor,
            detail_context=HarnessDetailContextExecutor,
            context_revision=HarnessContextRevisionExecutor,
            project_catalog=ProjectCatalogExecutor,
            execution_draft_compiler=ExecutionDraftCompilerExecutor,
            run_spec_compiler=RunSpecCompilerExecutor,
            execution_route=ExecutionRouteExecutor,
            pi_readonly_dispatch=PiReadonlyDispatchExecutor,
            pi_readonly_result_assembly=PiReadonlyResultAssemblyExecutor,
            clarification=ClarificationExecutor,
            harness_commit=HarnessCandidateCommitExecutor,
            summary_persist=TurnSummaryPersistExecutor,
            finalizer=FinalizeExecutor,
            decision_specs=_decision_specs,
            is_project_catalog_state=_is_project_catalog_state,
            needs_plan=_needs_plan,
        ),
        thread_id=thread_id,
        run_id=run_id,
        profiles=profiles,
        store=store,
        transport=transport,
        sessions=sessions,
        governance=governance,
        harness=harness,
        collaboration_protocols=collaboration_protocols,
        collaboration_intents=collaboration_intents,
        collaboration_contexts=collaboration_contexts,
        repository_freshness=repository_freshness,
        repository_execution_context=repository_execution_context,
        pi_available=pi_available,
        execution_dispatch=execution_dispatch,
        checkpoint_storage=checkpoint_storage,
    )
