"""Deterministic normalization for one interaction's durable focus.

The model may propose a summary, but it cannot promote its own prose to an
accepted fact or decision. This module preserves useful candidates, attaches
stable evidence references, and produces the canonical TurnDigest v1 shape
before persistence and hashing.
"""

from __future__ import annotations

from typing import Any, Mapping, Sequence

DIGEST_VERSION = 1
ARRAY_FIELDS = (
    "confirmed_facts",
    "decisions",
    "open_questions",
    "product_fact_refs",
    "work_state_candidates",
    "memory_candidates",
    "source_refs",
    "discarded",
)
EXTENSION_FIELDS = (
    "project_hint",
    "query_kind",
    "awaiting_user_answer",
    "clarification_context",
    "context_keywords",
)
PRODUCT_FACT_KINDS = {
    "project",
    "work_item",
    "note",
    "accepted_memory",
    "evidence",
    "artifact",
}


def normalize_turn_digest(
    summary: Mapping[str, Any],
    *,
    run_id: str,
    user_message_id: str,
    source_model_call_revision_id: str | None,
    product_fact_refs: Sequence[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    """Return a bounded, evidence-aware TurnDigest v1.

    String-only ``confirmed_facts`` and ``decisions`` are retained as explicit
    candidates because a model sentence is not proof of a Product fact or a
    user decision. Structured entries with non-empty source references remain
    in the accepted arrays.
    """

    warning_parts: list[str] = []
    discarded = _mapping_list(summary.get("discarded"))
    source_refs = [
        {"kind": "product_message", "id": user_message_id},
        {"kind": "product_run", "id": run_id},
    ]
    if source_model_call_revision_id:
        source_refs.append(
            {
                "kind": "model_call_revision",
                "id": source_model_call_revision_id,
            }
        )
    source_refs.extend(_mapping_list(summary.get("source_refs")))

    confirmed, unverified = _referenced_items(summary.get("confirmed_facts"))
    if unverified:
        warning_parts.append("无来源的confirmed_facts已保留为未验证候选")
        discarded.append(
            {
                "category": "unverified_confirmed_fact",
                "count": len(unverified),
                "reason": "模型输出本身不是Product事实或用户确认的证据",
            }
        )

    decisions, decision_candidates = _decision_items(summary.get("decisions"))
    if decision_candidates:
        warning_parts.append("未绑定Decision/Product引用的decisions已保留为候选")
        discarded.append(
            {
                "category": "unbound_decision",
                "count": len(decision_candidates),
                "reason": "决定必须绑定用户Decision或已提交Product事实",
            }
        )

    valid_product_refs: list[dict[str, Any]] = []
    invalid_product_ref_count = 0
    for raw in [*_mapping_list(summary.get("product_fact_refs")), *product_fact_refs]:
        kind = str(raw.get("kind") or "").strip()
        ref_id = str(raw.get("id") or "").strip()
        if kind not in PRODUCT_FACT_KINDS or not ref_id:
            invalid_product_ref_count += 1
            continue
        valid_product_refs.append(
            {
                "kind": kind,
                "id": ref_id,
                **({"revision": raw["revision"]} if raw.get("revision") is not None else {}),
            }
        )
    if invalid_product_ref_count:
        warning_parts.append("无效product_fact_refs已丢弃")

    raw_warning = str(summary.get("extraction_warning") or "").strip()
    if raw_warning:
        warning_parts.insert(0, raw_warning[:1000])
    topic = str(summary.get("topic") or "本轮对话").strip()[:240] or "本轮对话"
    digest: dict[str, Any] = {
        "digest_version": DIGEST_VERSION,
        "topic": topic,
        "confirmed_facts": confirmed[:100],
        "decisions": decisions[:100],
        "open_questions": _text_list(summary.get("open_questions"))[:100],
        "product_fact_refs": _dedupe_refs(valid_product_refs)[:200],
        "work_state_candidates": _candidate_list(summary.get("work_state_candidates"))[:100],
        "memory_candidates": _candidate_list(summary.get("memory_candidates"))[:100],
        "source_refs": _dedupe_refs(source_refs)[:200],
        "discarded": discarded[:100],
    }
    if unverified:
        digest["unverified_fact_candidates"] = unverified[:100]
    if decision_candidates:
        digest["decision_candidates"] = decision_candidates[:100]
    if warning_parts:
        digest["extraction_warning"] = "；".join(dict.fromkeys(warning_parts))
    for field in EXTENSION_FIELDS:
        if field in summary:
            digest[field] = summary[field]
    return digest


def _referenced_items(value: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    accepted: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    for raw in _sequence(value):
        if isinstance(raw, Mapping):
            text = str(raw.get("text") or raw.get("content") or "").strip()
            refs = _dedupe_refs(_mapping_list(raw.get("source_refs")))
            if text and refs:
                accepted.append({"text": text[:2000], "source_refs": refs})
            elif text:
                candidates.append(
                    {
                        "text": text[:2000],
                        "reason": "没有可验证的source_refs",
                    }
                )
        else:
            text = str(raw).strip()
            if text:
                candidates.append(
                    {
                        "text": text[:2000],
                        "reason": "字符串事实没有可验证的source_refs",
                    }
                )
    return accepted, candidates


def _decision_items(value: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    accepted: list[dict[str, Any]] = []
    candidates: list[dict[str, Any]] = []
    for raw in _sequence(value):
        if isinstance(raw, Mapping):
            text = str(raw.get("text") or raw.get("content") or "").strip()
            decision_record_id = str(raw.get("decision_record_id") or "").strip()
            product_ref = raw.get("product_ref")
            if text and (decision_record_id or isinstance(product_ref, Mapping)):
                accepted.append(
                    {
                        "text": text[:2000],
                        **({"decision_record_id": decision_record_id} if decision_record_id else {}),
                        **({"product_ref": dict(product_ref)} if isinstance(product_ref, Mapping) else {}),
                    }
                )
            elif text:
                candidates.append(
                    {
                        "text": text[:2000],
                        "reason": "没有绑定Decision Record或Product引用",
                    }
                )
        else:
            text = str(raw).strip()
            if text:
                candidates.append(
                    {
                        "text": text[:2000],
                        "reason": "字符串决定没有绑定Decision Record或Product引用",
                    }
                )
    return accepted, candidates


def _candidate_list(value: Any) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for raw in _sequence(value):
        if isinstance(raw, Mapping):
            result.append(dict(raw))
        else:
            text = str(raw).strip()
            if text:
                result.append({"text": text[:4000]})
    return result


def _text_list(value: Any) -> list[str]:
    return [text[:2000] for raw in _sequence(value) if (text := str(raw).strip())]


def _mapping_list(value: Any) -> list[dict[str, Any]]:
    return [dict(raw) for raw in _sequence(value) if isinstance(raw, Mapping)]


def _sequence(value: Any) -> list[Any]:
    if isinstance(value, (list, tuple)):
        return list(value)
    return []


def _dedupe_refs(values: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for raw in values:
        kind = str(raw.get("kind") or "").strip()
        ref_id = str(raw.get("id") or "").strip()
        revision = str(raw.get("revision") or "").strip()
        if not kind or not ref_id:
            continue
        key = (kind, ref_id, revision)
        if key in seen:
            continue
        seen.add(key)
        result.append(
            {
                "kind": kind,
                "id": ref_id,
                **({"revision": revision} if revision else {}),
            }
        )
    return result
