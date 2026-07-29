"""持续协作代码可学习性合同：39节点实现必须保留中文职责注释。"""

from __future__ import annotations

import ast
from pathlib import Path

from backend.app.product_sessions.trace_reports import CONTINUOUS_NODE_PHASES
from backend.app.workflows.catalog import CONTINUOUS_COLLABORATION_WORKFLOW

ROOT = Path(__file__).resolve().parents[2]
EXECUTOR_FILES = (
    ROOT / "backend/app/workflows/continuous_chat.py",
    ROOT / "backend/app/execution_dispatch/workflow.py",
    ROOT / "backend/app/execution_dispatch/result_gate.py",
)


def _has_chinese(value: str | None) -> bool:
    return bool(value and any("\u4e00" <= character <= "\u9fff" for character in value))


def test_all_39_nodes_have_a_human_learning_phase() -> None:
    node_ids = {value.id for value in CONTINUOUS_COLLABORATION_WORKFLOW.nodes}
    assert len(node_ids) == 39
    assert set(CONTINUOUS_NODE_PHASES) == node_ids


def test_continuous_executor_classes_and_handlers_keep_chinese_responsibility_comments() -> None:
    missing: list[str] = []
    for source in EXECUTOR_FILES:
        tree = ast.parse(source.read_text(encoding="utf-8"))
        for node in tree.body:
            if not isinstance(node, ast.ClassDef) or "Executor" not in node.name:
                continue
            if not _has_chinese(ast.get_docstring(node)):
                missing.append(f"{source.name}:{node.name}")
            for member in node.body:
                if not isinstance(member, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                is_handler = any(
                    (isinstance(decorator, ast.Name) and decorator.id in {"handler", "response_handler"})
                    or (
                        isinstance(decorator, ast.Call)
                        and isinstance(decorator.func, ast.Name)
                        and decorator.func.id in {"handler", "response_handler"}
                    )
                    for decorator in member.decorator_list
                )
                if is_handler and not _has_chinese(ast.get_docstring(member)):
                    missing.append(f"{source.name}:{node.name}.{member.name}")
    assert missing == []
