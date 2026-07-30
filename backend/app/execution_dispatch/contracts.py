"""Pure, versioned contracts for execution routing and pi read-only results.

This module deliberately imports neither MAF nor SQLAlchemy.  The immutable
RunSpec remains the routing authority, while these types make invalid or
capability-expanding runtime requests fail closed before any subprocess starts.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any, Literal, Mapping

from ..harness.contracts import content_hash

ExecutionRouteKind = Literal["answer_only", "pi_readonly", "pi_workspace"]
PiTerminalStatus = Literal["succeeded", "failed", "cancelled"]


@dataclass(frozen=True, slots=True)
class RepositoryFence:
    """Immutable repository observation bound into a governed execution."""

    project_id: str
    binding_id: str
    snapshot_id: str
    binding_generation: int
    snapshot_sequence: int
    semantic_hash: str
    governance_manifest_hash: str
    head_oid: str | None
    worktree_fingerprint: str | None
    root_key: str
    relative_path: str

    def __post_init__(self) -> None:
        required = {
            "project_id": self.project_id,
            "binding_id": self.binding_id,
            "snapshot_id": self.snapshot_id,
            "semantic_hash": self.semantic_hash,
            "governance_manifest_hash": self.governance_manifest_hash,
            "root_key": self.root_key,
            "relative_path": self.relative_path,
        }
        missing = [key for key, value in required.items() if not str(value).strip()]
        if missing:
            raise ValueError(f"RepositoryFence缺少字段: {', '.join(missing)}")
        if self.binding_generation < 1 or self.snapshot_sequence < 1:
            raise ValueError("RepositoryFence generation和sequence必须大于0")

    def public_view(self) -> dict[str, Any]:
        """Return the path-safe form allowed in Drafts, RunSpecs and Trace."""

        return asdict(self)

    @property
    def fence_hash(self) -> str:
        return content_hash(self.public_view())


@dataclass(frozen=True, slots=True)
class ExecutionRoute:
    """One deterministic branch decision derived only from an immutable RunSpec."""

    kind: ExecutionRouteKind
    reason_code: str
    run_spec_id: str
    run_spec_hash: str
    repository_fence: RepositoryFence | None = None

    def public_view(self) -> dict[str, Any]:
        return {
            "kind": self.kind,
            "reason_code": self.reason_code,
            "run_spec_id": self.run_spec_id,
            "run_spec_hash": self.run_spec_hash,
            "repository_fence": (self.repository_fence.public_view() if self.repository_fence else None),
        }


@dataclass(frozen=True, slots=True)
class PiReadonlyResult:
    """Sanitized terminal result; it never carries hidden reasoning or raw payloads."""

    execution_id: str
    status: PiTerminalStatus
    final_text: str
    model_call_count: int
    tool_call_count: int
    input_tokens: int
    output_tokens: int
    duration_ms: int
    result_hash: str
    terminal_reason_code: str
    mode: str = "readonly"
    workspace_id: str | None = None
    workspace_diff_hash: str | None = None
    changed_paths: tuple[str, ...] = ()

    def public_view(self) -> dict[str, Any]:
        return asdict(self)


def _mapping(value: Any, *, field: str) -> Mapping[str, Any]:
    if not isinstance(value, Mapping):
        raise ValueError(f"RunSpec字段{field}必须是对象")
    return value


def _repository_fence(value: Any) -> RepositoryFence:
    data = _mapping(value, field="runtime_agent.repository_fence")
    return RepositoryFence(
        project_id=str(data.get("project_id") or ""),
        binding_id=str(data.get("binding_id") or ""),
        snapshot_id=str(data.get("snapshot_id") or ""),
        binding_generation=int(data.get("binding_generation") or 0),
        snapshot_sequence=int(data.get("snapshot_sequence") or 0),
        semantic_hash=str(data.get("semantic_hash") or ""),
        governance_manifest_hash=str(data.get("governance_manifest_hash") or ""),
        head_oid=str(data["head_oid"]) if data.get("head_oid") is not None else None,
        worktree_fingerprint=(
            str(data["worktree_fingerprint"]) if data.get("worktree_fingerprint") is not None else None
        ),
        root_key=str(data.get("root_key") or ""),
        relative_path=str(data.get("relative_path") or ""),
    )


def route_from_run_spec(
    *,
    run_spec_id: str,
    run_spec_hash: str,
    spec: Mapping[str, Any],
) -> ExecutionRoute:
    """Resolve the execution branch without inspecting the user's raw message.

    Routing after approval must not reinterpret text: a human-approved RunSpec
    is the sole authority.  Unknown runtimes, missing fences and any writable pi
    mode fail closed instead of silently falling back to another Agent.
    """

    breakpoint()  # DEBUG-BREAKPOINT: BP-22
    runtime_agent = _mapping(spec.get("runtime_agent"), field="runtime_agent")
    runtime = str(runtime_agent.get("runtime") or "")
    mode = str(runtime_agent.get("mode") or "")
    if runtime == "maf-workflow" and mode in {"", "answer_only"}:
        return ExecutionRoute(
            kind="answer_only",
            reason_code="run_spec_selected_answer_only",
            run_spec_id=run_spec_id,
            run_spec_hash=run_spec_hash,
        )
    if runtime == "pi" and mode == "readonly":
        return ExecutionRoute(
            kind="pi_readonly",
            reason_code="run_spec_selected_pi_readonly",
            run_spec_id=run_spec_id,
            run_spec_hash=run_spec_hash,
            repository_fence=_repository_fence(runtime_agent.get("repository_fence")),
        )
    if runtime == "pi" and mode == "workspace_edit":
        fence = _repository_fence(runtime_agent.get("repository_fence"))
        if not fence.head_oid or not fence.worktree_fingerprint:
            raise ValueError("pi workspace_edit要求完整、干净且可定位的RepositoryFence")
        return ExecutionRoute(
            kind="pi_workspace",
            reason_code="run_spec_selected_pi_workspace_edit",
            run_spec_id=run_spec_id,
            run_spec_hash=run_spec_hash,
            repository_fence=fence,
        )
    if runtime == "pi":
        raise ValueError("当前只允许pi readonly或workspace_edit模式")
    raise ValueError(f"RunSpec包含不受支持的runtime: {runtime or '<empty>'}")
