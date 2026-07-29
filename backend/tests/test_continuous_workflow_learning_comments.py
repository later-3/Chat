"""持续协作代码可学习性合同：39节点实现必须保留中文职责注释。"""

from __future__ import annotations

import ast
from pathlib import Path

from backend.app.continuous_workflow_learning import (
    CONTINUOUS_NODE_LEARNING_STAGE_LABELS,
    CONTINUOUS_WORKFLOW_LEARNING_STAGES,
)
from backend.app.workflows.catalog import CONTINUOUS_COLLABORATION_WORKFLOW

ROOT = Path(__file__).resolve().parents[2]
EXECUTOR_FILES = (
    ROOT / "backend/app/workflows/continuous_chat.py",
    ROOT / "backend/app/execution_dispatch/workflow.py",
    ROOT / "backend/app/execution_dispatch/result_gate.py",
)
CONTRACT_FILE = ROOT / "backend/app/workflows/continuous_chat_contracts.py"


def _has_chinese(value: str | None) -> bool:
    return bool(value and any("\u4e00" <= character <= "\u9fff" for character in value))


def test_all_39_nodes_have_a_human_learning_phase() -> None:
    definition_node_ids = tuple(value.id for value in CONTINUOUS_COLLABORATION_WORKFLOW.nodes)
    learning_node_ids = tuple(
        node_id for stage in CONTINUOUS_WORKFLOW_LEARNING_STAGES for node_id in stage.node_ids
    )
    assert len(CONTINUOUS_WORKFLOW_LEARNING_STAGES) == 7
    assert [stage.id for stage in CONTINUOUS_WORKFLOW_LEARNING_STAGES] == [
        "S1",
        "S2",
        "S3",
        "S4",
        "S5",
        "S6",
        "S7",
    ]
    assert len(definition_node_ids) == 39
    assert learning_node_ids == definition_node_ids
    assert set(CONTINUOUS_NODE_LEARNING_STAGE_LABELS) == set(definition_node_ids)


def test_continuous_executor_classes_and_handlers_keep_chinese_responsibility_comments() -> None:
    missing: list[str] = []
    for source in EXECUTOR_FILES:
        tree = ast.parse(source.read_text(encoding="utf-8"))
        for node in tree.body:
            if not isinstance(node, ast.ClassDef) or "Executor" not in node.name:
                continue
            if not _has_chinese(ast.get_docstring(node)):
                missing.append(f"{source.name}:{node.name}")
            if "学习阶段S" not in (ast.get_docstring(node) or ""):
                missing.append(f"{source.name}:{node.name}:缺少学习阶段S标记")
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


def test_continuous_pure_contracts_keep_chinese_docstrings() -> None:
    """确定性护栏所在的纯合同模块：模块docstring与全部顶层函数必须保留中文说明。

    调试“不调模型也能判断”的逻辑时一定会单步进入这个文件；它的注释缺失曾使
    目录查询、意图规范化与场景路由求值无法就地理解。
    """

    tree = ast.parse(CONTRACT_FILE.read_text(encoding="utf-8"))
    missing: list[str] = []
    if not _has_chinese(ast.get_docstring(tree)):
        missing.append(f"{CONTRACT_FILE.name}:模块docstring")
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and not _has_chinese(
            ast.get_docstring(node)
        ):
            missing.append(f"{CONTRACT_FILE.name}:{node.name}")
    assert missing == []
