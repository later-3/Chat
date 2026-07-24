"""No-behavior-refactor fingerprints for Q02 application boundaries."""

from __future__ import annotations

import ast
import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import inspect

from backend.app.config import Settings
from backend.app.main import create_app
from backend.app.product_sessions import ProductDatabase, ProductSessionService
from backend.app.workflows import (
    CHAT_MODEL_CALL_APPROVAL_WORKFLOW,
    CONTINUOUS_COLLABORATION_WORKFLOW,
    GOVERNED_AGENT_HANDOFF_WORKFLOW,
    GOVERNED_IDIOM_CHAIN_WORKFLOW,
    GOVERNED_PI_AGENT_WORKFLOW,
    NESTED_QUALITY_WORKFLOW,
)

# Reviewed 2026-07-24 after adding immutable Collaboration Intent Set/Intent
# revisions, cross-Run clarification contracts, and two real Intent governance
# Workflow nodes. The API, schema, and Workflow changes are intentional.
# These fingerprints intentionally make future boundary drift fail closed.
OPENAPI_SHA256 = "cf47064ec9f2e71ec7b965a9af652f75d5faee3362badcb378005aea3360841e"
PRODUCT_SCHEMA_SHA256 = "613e4d2d8d7c3c4db46d512b329768c7cee3dc9980b8237d253aad8caa247c17"
WORKFLOW_CATALOG_SHA256 = "9c814c13d878779f6ca3eaa0789e9ee8c2e5797eb7d6b5c68246fe2d061a2f6f"
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
        "product_sessions/service.py",
    ):
        source = (APP_ROOT / relative).read_text(encoding="utf-8")
        assert "from fastapi" not in source
        assert "import fastapi" not in source
    router_source = (APP_ROOT / "api/product_router.py").read_text(encoding="utf-8")
    assert ".database.sessions.begin(" not in router_source


def test_extracted_query_rule_and_command_boundaries_preserve_transaction_ownership() -> None:
    read_only_modules = (
        "governance/policy.py",
        "governance/queries.py",
        "harness/contracts.py",
        "harness/queries.py",
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

    for relative in ("governance/service.py", "harness/service.py"):
        coordinator = (APP_ROOT / relative).read_text(encoding="utf-8")
        assert ".sessions.begin(" in coordinator


def test_targeted_frontend_coordinators_stay_within_reviewed_boundaries() -> None:
    frontend = APP_ROOT.parents[1] / "frontend" / "src"
    app_source = (frontend / "App.tsx").read_text(encoding="utf-8")
    agent_hook = (frontend / "use-chat-agent.ts").read_text(encoding="utf-8")
    workflow_view = (frontend / "workflow-run-view.tsx").read_text(encoding="utf-8")

    assert "lazy(() =>" in app_source
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
