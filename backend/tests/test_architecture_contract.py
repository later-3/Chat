"""No-behavior-refactor fingerprints for Q02 application boundaries."""

from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import inspect

from backend.app.collaboration_intents import models as _ci_models  # noqa: F401
from backend.app.collaboration_protocols import models as _cp_models  # noqa: F401
from backend.app.config import Settings
from backend.app.evidence import models as _ev_models  # noqa: F401
from backend.app.execution_workspaces import models as _ew_models  # noqa: F401
from backend.app.governance import models as _gov_models  # noqa: F401
from backend.app.harness import models as _har_models  # noqa: F401
from backend.app.main import create_app
from backend.app.product_sessions import ProductDatabase, ProductSessionService
from backend.app.project_resources import models as _pr_models  # noqa: F401
from backend.app.runtime_execution import models as _re_models  # noqa: F401
from backend.app.step_inputs import models as _si_models  # noqa: F401
from backend.app.tool_execution import models as _te_models  # noqa: F401
from backend.app.workflows import (
    CHAT_MODEL_CALL_APPROVAL_WORKFLOW,
    CONTINUOUS_COLLABORATION_WORKFLOW,
    GOVERNED_AGENT_HANDOFF_WORKFLOW,
    GOVERNED_IDIOM_CHAIN_WORKFLOW,
    GOVERNED_PI_AGENT_WORKFLOW,
    NESTED_QUALITY_WORKFLOW,
)

# Reviewed 2026-07-25 for SD3. Product Schema adds the isolated
# ExecutionWorkspace plus field-level ToolOperation, Attempt and Reconciliation
# ledgers. Workflow 1.7.0 adds explicit workspace preparation, governed
# workspace pi dispatch and result assembly while preserving the SD2 read-only
# and answer-only branches. The hidden Tool Gateway does not change OpenAPI.
# Reviewed 2026-07-25 for SD4-A. Product Schema adds the 15-table Evidence,
# Artifact, Provenance and Validation lifecycle (F02). Model modules are
# imported explicitly so the in-memory create_all schema is deterministic
# regardless of test execution order.
# Re-reviewed 2026-07-25 after Kimi audit: §4 field alignment (blob GC columns,
# revision storage_blob_id/sha256/supersedes, observation subject/source
# invariants, claim expected_subject_version/target_state, invalidation CHECKs).
# These fingerprints intentionally make future boundary drift fail closed.
# Re-reviewed 2026-07-26 for SD4-C: OpenAPI adds exactly two Evidence endpoints
# (POST /api/evidence/claims/{id}/commit, GET /api/evidence/claims/{id}); the
# commit route is the only user-reachable Evidence mutation (§13.1).
# Re-reviewed 2026-07-28 for deterministic dual Run Trace reports: OpenAPI adds
# exactly one read-only trace-reports endpoint; Product Schema adds only the
# run_trace_reports materialized-projection table. trace_events and domain
# ledgers remain authoritative. Re-reviewed 2026-07-29 after replacing the
# catalog's historical Stage A/B copy with explicit directory/detail terms;
# the Workflow ID/version/node/edge topology is unchanged.
# Re-reviewed 2026-07-30 for APP-PROJECTION read-only v1: OpenAPI adds exactly
# four read-only Workspace/Dossier/Obsidian endpoints and their explicit DTOs.
# Product Schema and Workflow topology are unchanged; projections remain
# rebuildable and the ZIP route never accepts a server filesystem path.
# Re-reviewed 2026-07-31 for W1-01: every REST error now exposes the explicit
# recovery_action enum, and shared CommandId constraints appear in OpenAPI.
# Product Schema and Workflow topology remain unchanged.
OPENAPI_SHA256 = "30265fd2c72be2c983340b141636ce1e49747852f0fb61e1f5764f78976b6503"
PRODUCT_SCHEMA_SHA256 = "f151dc80ad56b9cb29913267f53e17822a63640811856ecae3a1637da62d0e29"
WORKFLOW_CATALOG_SHA256 = "01fe3f41be2ea1b0b68c573b56cb67d43835102b90af146b94c870a6e11c0661"
APP_ROOT = Path(__file__).resolve().parents[1] / "app"


def _digest(value: Any) -> str:
    body = json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode()
    return hashlib.sha256(body).hexdigest()


def test_openapi_contract_fingerprint_is_stable() -> None:
    app = create_app(Settings.for_test())
    assert _digest(app.openapi()) == OPENAPI_SHA256


def test_workflow_catalog_and_node_ids_are_stable() -> None:
    definitions = (
        CHAT_MODEL_CALL_APPROVAL_WORKFLOW,
        CONTINUOUS_COLLABORATION_WORKFLOW,
        GOVERNED_AGENT_HANDOFF_WORKFLOW,
        GOVERNED_IDIOM_CHAIN_WORKFLOW,
        GOVERNED_PI_AGENT_WORKFLOW,
        NESTED_QUALITY_WORKFLOW,
    )
    assert _digest([definition.view() for definition in definitions]) == WORKFLOW_CATALOG_SHA256


def test_application_module_dependencies_are_acyclic() -> None:
    modules = {
        ".".join(path.relative_to(APP_ROOT.parent).with_suffix("").parts): path
        for path in APP_ROOT.rglob("*.py")
        if path.name != "__init__.py"
    }
    graph: dict[str, set[str]] = {name: set() for name in modules}
    for module, path in modules.items():
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        package = module.split(".")[:-1]
        for node in ast.walk(tree):
            if not isinstance(node, ast.ImportFrom) or node.level == 0:
                continue
            prefix = package[: len(package) - node.level + 1]
            imported = ".".join([*prefix, *(node.module or "").split(".")]).rstrip(".")
            if imported in modules:
                graph[module].add(imported)
            for alias in node.names:
                imported_member = f"{imported}.{alias.name}"
                if imported_member in modules:
                    graph[module].add(imported_member)

    visited: set[str] = set()
    active: list[str] = []

    def visit(module: str) -> None:
        if module in active:
            cycle = " -> ".join([*active[active.index(module) :], module])
            raise AssertionError(f"application module dependency cycle: {cycle}")
        if module in visited:
            return
        active.append(module)
        for dependency in graph[module]:
            visit(dependency)
        active.pop()
        visited.add(module)

    for module in graph:
        visit(module)


def test_domain_services_do_not_depend_on_fastapi_and_router_does_not_open_transactions() -> None:
    for relative in (
        "governance/service.py",
        "governance/queries.py",
        "harness/service.py",
        "harness/commands.py",
        "harness/queries.py",
        "project_resources/service.py",
        "project_resources/queries.py",
        "project_resources/mutations.py",
        "product_sessions/service.py",
    ):
        source = (APP_ROOT / relative).read_text(encoding="utf-8")
        assert "from fastapi" not in source
        assert "import fastapi" not in source
    router_source = (APP_ROOT / "api/product_router.py").read_text(encoding="utf-8")
    assert ".database.sessions.begin(" not in router_source
    repository_router = (APP_ROOT / "project_resources/api.py").read_text(encoding="utf-8")
    assert ".database.sessions.begin(" not in repository_router
    assert "transaction.add(" not in repository_router
    projection_router = (APP_ROOT / "projections/api.py").read_text(encoding="utf-8")
    assert ".database.sessions" not in projection_router
    assert "transaction.add(" not in projection_router


def test_private_runtime_joins_and_http_errors_stay_inside_their_adapters() -> None:
    private_runtime_boundary = APP_ROOT / "runtime_adapters/maf_compat.py"
    error_boundary = APP_ROOT / "api/errors.py"
    private_imports: list[str] = []
    raw_http_errors: list[str] = []
    for path in APP_ROOT.rglob("*.py"):
        source = path.read_text(encoding="utf-8")
        if path != private_runtime_boundary and (
            "agent_framework._" in source or "agent_framework_ag_ui._" in source
        ):
            private_imports.append(str(path.relative_to(APP_ROOT)))
        if path != error_boundary and "HTTPException(" in source:
            raw_http_errors.append(str(path.relative_to(APP_ROOT)))

    assert private_imports == []
    assert raw_http_errors == []
    assert "RequestInfoMixin" not in "\n".join(
        path.read_text(encoding="utf-8")
        for path in APP_ROOT.rglob("*.py")
        if path != private_runtime_boundary
    )


def test_extracted_query_rule_and_command_boundaries_preserve_transaction_ownership() -> None:
    read_only_modules = (
        "governance/policy.py",
        "governance/queries.py",
        "harness/contracts.py",
        "harness/projection_queries.py",
        "harness/queries.py",
        "projections/contracts.py",
        "projections/obsidian.py",
        "projections/service.py",
        "project_resources/contracts.py",
        "project_resources/queries.py",
        "project_resources/snapshots.py",
    )
    for relative in read_only_modules:
        source = (APP_ROOT / relative).read_text(encoding="utf-8")
        assert ".sessions.begin(" not in source
        assert ".commit(" not in source
        assert "transaction.add(" not in source
        assert "from .service import" not in source

    recorder = (APP_ROOT / "harness/commands.py").read_text(encoding="utf-8")
    assert ".sessions" not in recorder
    assert ".begin(" not in recorder
    assert ".commit(" not in recorder
    assert "transaction.add(" in recorder

    repository_mutations = (APP_ROOT / "project_resources/mutations.py").read_text(encoding="utf-8")
    assert ".sessions" not in repository_mutations
    assert ".begin(" not in repository_mutations
    assert ".commit(" not in repository_mutations
    assert "transaction.execute(" in repository_mutations

    for relative in ("governance/service.py", "harness/service.py"):
        coordinator = (APP_ROOT / relative).read_text(encoding="utf-8")
        assert ".sessions.begin(" in coordinator


def test_targeted_frontend_coordinators_stay_within_reviewed_boundaries() -> None:
    frontend = APP_ROOT.parents[1] / "frontend" / "src"
    app_source = (frontend / "App.tsx").read_text(encoding="utf-8")
    lazy_features = (frontend / "lazy-features.ts").read_text(encoding="utf-8")
    agent_hook = (frontend / "use-chat-agent.ts").read_text(encoding="utf-8")
    workflow_view = (frontend / "workflow-run-view.tsx").read_text(encoding="utf-8")

    assert "lazy(() =>" not in app_source
    assert lazy_features.count("lazy(() =>") >= 8
    assert len(app_source.splitlines()) < 800
    assert "getRuntimeEvents" not in agent_hook
    assert "replayRuntimeEvents" not in agent_hook
    assert len(agent_hook.splitlines()) <= 500
    assert "progressFromTrace" not in workflow_view
    assert len(workflow_view.splitlines()) <= 500


@pytest.mark.anyio
async def test_product_store_schema_fingerprint_is_stable() -> None:
    settings = Settings.for_test()
    service = ProductSessionService(ProductDatabase(settings.database_url))
    app = create_app(settings, product_session_service=service)
    async with app.router.lifespan_context(app):
        async with service.database.engine.connect() as connection:

            def schema(connection) -> dict[str, list[dict[str, Any]]]:
                inspector = inspect(connection)
                return {
                    table: [
                        {
                            "name": column["name"],
                            "type": str(column["type"]),
                            "nullable": column["nullable"],
                            "primary_key": column["primary_key"],
                        }
                        for column in inspector.get_columns(table)
                    ]
                    for table in sorted(inspector.get_table_names())
                }

            snapshot = await connection.run_sync(schema)
    assert _digest(snapshot) == PRODUCT_SCHEMA_SHA256
