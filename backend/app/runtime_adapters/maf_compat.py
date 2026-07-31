"""One compatibility boundary for the installed MAF and AG-UI versions.

Public framework types remain imported by their consumers.  The three helpers
below are deliberately the only production code allowed to touch private MAF
surfaces: checkpoint serialization, runtime type matching and the AG-UI rc8
checkpoint restore bridge.  Upgrade tests lock those joins to the installed
package versions and fail closed when the surfaces move.
"""

from __future__ import annotations

import inspect
from collections.abc import Awaitable, Callable, Mapping
from importlib.metadata import PackageNotFoundError, version
from types import UnionType
from typing import Any, cast

from agent_framework import CheckpointStorage, Executor, Workflow
from agent_framework._workflows._checkpoint_encoding import (  # pyright: ignore[reportPrivateUsage]
    decode_checkpoint_value,
    encode_checkpoint_value,
)
from agent_framework._workflows._typing_utils import (  # pyright: ignore[reportPrivateUsage]
    is_instance_of,
)
from agent_framework_ag_ui import AGUIRequest

EXPECTED_RUNTIME_PACKAGES: Mapping[str, str] = {
    "agent-framework-core": "1.11.0",
    "agent-framework-ag-ui": "1.0.0rc8",
    "agent-framework-openai": "1.10.1",
}
MAF_REFERENCE_COMMIT = "9c4cd07899502157284b64a73f9a0adfb4594d96"


class RuntimeCompatibilityError(RuntimeError):
    """The installed runtime no longer satisfies Chat's tested adapter contract."""

    code = "RUNTIME_COMPATIBILITY_FAILED"


def installed_runtime_versions() -> dict[str, str]:
    """Return installed versions without importing package implementation metadata."""

    versions: dict[str, str] = {}
    for package in EXPECTED_RUNTIME_PACKAGES:
        try:
            versions[package] = version(package)
        except PackageNotFoundError:
            versions[package] = "missing"
    return versions


def assert_runtime_compatibility(
    expected_versions: Mapping[str, str] = EXPECTED_RUNTIME_PACKAGES,
) -> dict[str, str]:
    """Fail before startup/CI when versions or critical public surfaces drift."""

    installed = installed_runtime_versions()
    mismatches = {
        package: {"expected": expected, "actual": installed.get(package, "missing")}
        for package, expected in expected_versions.items()
        if installed.get(package) != expected
    }
    if mismatches:
        summary = ", ".join(
            f"{package}={values['actual']} (expected {values['expected']})"
            for package, values in sorted(mismatches.items())
        )
        raise RuntimeCompatibilityError(f"Agent Runtime版本未通过兼容门: {summary}")

    executor_surfaces = ("_discover_response_handlers", "_find_response_handler")
    if not all(callable(getattr(Executor, name, None)) for name in executor_surfaces):
        raise RuntimeCompatibilityError("MAF Executor不再提供HITL response handler合同")
    required_agui_fields = {"messages", "run_id", "thread_id", "resume"}
    if not required_agui_fields.issubset(AGUIRequest.model_fields):
        raise RuntimeCompatibilityError("AG-UI Request合同缺少Chat接纳或恢复字段")
    if not inspect.iscoroutinefunction(getattr(CheckpointStorage, "load", None)):
        raise RuntimeCompatibilityError("MAF CheckpointStorage.load合同已变化")
    return installed


def encode_checkpoint_payload(value: Any) -> Any:
    """Encode one MAF-owned checkpoint payload with its restricted serializer."""

    return encode_checkpoint_value(value)


def decode_checkpoint_payload(value: Any, *, allowed_types: frozenset[str]) -> Any:
    """Decode a checkpoint while keeping the application's explicit type allow-list."""

    return decode_checkpoint_value(value, allowed_types=allowed_types)


def maf_is_instance(value: Any, target_type: type[Any] | UnionType | Any) -> bool:
    """Use MAF's runtime matcher for workflow annotations until it becomes public."""

    return is_instance_of(value, target_type)


async def pending_request_ids(workflow: Workflow) -> frozenset[str]:
    """Read pending HITL IDs from the installed MAF Workflow runner context."""

    runner_context = getattr(workflow, "_runner_context", None)
    getter = getattr(runner_context, "get_pending_request_info_events", None)
    if not callable(getter):
        raise RuntimeCompatibilityError("MAF Workflow pending request接口已变化")
    pending = await cast("Callable[[], Awaitable[object]]", getter)()
    if not isinstance(pending, Mapping):
        raise RuntimeCompatibilityError("MAF Workflow pending request结果形状已变化")
    return frozenset(str(request_id) for request_id in pending)


async def restore_workflow_checkpoint(
    workflow: Workflow,
    *,
    checkpoint_id: str,
    checkpoint_storage: CheckpointStorage,
) -> None:
    """Restore runner state before AG-UI rc8 validates and applies Resume.

    AG-UI rc8 does not forward ``checkpoint_id`` to ``Workflow.run``.  Calling
    the public run API here would execute the graph before the standard AG-UI
    converter applies the resume payload, so this bridge is intentionally
    isolated and guarded by the compatibility suite.
    """

    runner = getattr(workflow, "_runner", None)
    restore = getattr(runner, "restore_from_checkpoint", None)
    if not callable(restore):
        raise RuntimeCompatibilityError("MAF Workflow checkpoint恢复接口已变化")
    await cast(
        "Callable[[str, CheckpointStorage], Awaitable[None]]",
        restore,
    )(checkpoint_id, checkpoint_storage)
