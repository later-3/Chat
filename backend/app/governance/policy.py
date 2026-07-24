"""Pure policy condition evaluation for the restricted HITL rule DSL."""

from __future__ import annotations

from typing import Any, Iterable, Mapping

from .catalog import ACTION_RANK, FINAL_ACTIONS


def strictest(actions: Iterable[str]) -> str:
    values = [value for value in actions if value in FINAL_ACTIONS]
    return max(values, key=ACTION_RANK.__getitem__) if values else "auto_continue"


def _fact(facts: Mapping[str, Any], path: str) -> tuple[bool, Any]:
    current: Any = facts
    for part in path.split("."):
        if not isinstance(current, Mapping) or part not in current:
            return False, None
        current = current[part]
    return True, current


def evaluate_condition(expression: Any, facts: Mapping[str, Any]) -> tuple[bool, bool]:
    """Return ``(matched, complete)`` for the restricted condition DSL."""

    if not isinstance(expression, Mapping) or len(expression) != 1:
        return False, False
    operator, value = next(iter(expression.items()))
    if operator in {"all", "any"}:
        if not isinstance(value, list) or not value:
            return False, False
        results = [evaluate_condition(item, facts) for item in value]
        complete = all(item[1] for item in results)
        matched = all(item[0] for item in results) if operator == "all" else any(item[0] for item in results)
        return matched, complete
    if operator == "not":
        matched, complete = evaluate_condition(value, facts)
        return (not matched, complete)
    if operator not in {"eq", "in", "gte", "lte", "prefix"}:
        return False, False
    if not isinstance(value, list) or len(value) != 2 or not isinstance(value[0], str):
        return False, False
    exists, actual = _fact(facts, value[0])
    if not exists:
        return False, False
    expected = value[1]
    try:
        if operator == "eq":
            return actual == expected, True
        if operator == "in":
            return actual in expected, isinstance(expected, list)
        if operator == "gte":
            return actual >= expected, True
        if operator == "lte":
            return actual <= expected, True
        return str(actual).startswith(str(expected)), True
    except (TypeError, ValueError):
        return False, False


def condition_specificity(expression: Any) -> int:
    if not isinstance(expression, Mapping):
        return 0
    return (
        1
        + sum(
            condition_specificity(value) for value in expression.values() if isinstance(value, (dict, list))
        )
        + sum(
            condition_specificity(item)
            for value in expression.values()
            if isinstance(value, list)
            for item in value
        )
    )


def valid_condition_shape(expression: Any) -> bool:
    if not isinstance(expression, Mapping) or len(expression) != 1:
        return False
    operator, value = next(iter(expression.items()))
    if operator in {"all", "any"}:
        return isinstance(value, list) and bool(value) and all(valid_condition_shape(item) for item in value)
    if operator == "not":
        return valid_condition_shape(value)
    if operator not in {"eq", "in", "gte", "lte", "prefix"}:
        return False
    if not isinstance(value, list) or len(value) != 2 or not isinstance(value[0], str):
        return False
    return operator != "in" or isinstance(value[1], list)
