"""Editable model-call drafts and an exact provider transport boundary.

This module is the first production-facing vertical slice of model-call review.
Its store is deliberately process-local until the Product Store and runtime
repository design pass the wider architecture gate.  The request compiler,
validation, version/hash rules and exact-byte transport are not temporary:
they define the contract the durable implementation must preserve.
"""

from __future__ import annotations

import copy
import hashlib
import json
import threading
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

import httpx

from .model_providers import (
    DEFAULT_MODEL_CAPABILITIES,
    ModelCapabilities,
    ModelOption,
    ModelProviderCatalog,
    ModelProviderCatalogError,
    ModelProviderConfig,
    ParameterCapability,
)


DEFAULT_INSTRUCTIONS = (
    "你是 Later 的 Chat 协作助手。"
    "使用中文直接回答，明确区分已知事实、候选和需要用户确认的事项。"
)

_CONTINUATION_FIELDS = frozenset(
    {"previous_response_id", "conversation", "conversation_id", "continuation_token"}
)
_RESERVED_TOP_LEVEL_FIELDS = frozenset({"model", "instructions", "input", "messages", "tools"})


def _new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex}"


def canonical_json_bytes(value: Mapping[str, Any]) -> bytes:
    """Serialize the reviewed request deterministically for hashing and send."""

    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


class ModelCallDraftError(ValueError):
    """Base error for draft commands."""


class ModelCallDraftConflict(ModelCallDraftError):
    """The caller acted on a stale or already-resolved draft."""


class ModelCallDraftValidationError(ModelCallDraftError):
    """The edited provider request cannot pass the current send policy."""

    def __init__(self, issues: Sequence[str]) -> None:
        self.issues = tuple(issues)
        super().__init__("; ".join(self.issues))


class ProviderDispatchError(RuntimeError):
    """The provider rejected a request or returned an invalid response."""

    def __init__(
        self,
        message: str,
        *,
        error_code: str = "provider_rejected",
        outcome_status: str = "failed",
    ) -> None:
        self.error_code = error_code
        self.outcome_status = outcome_status
        super().__init__(message)


def _validate_parameter(
    parameter: ParameterCapability,
    value: Any,
    *,
    issues: list[str],
) -> None:
    label = parameter.key
    if parameter.locked and value != parameter.locked_value:
        issues.append(f"{label}必须保持为{parameter.locked_value!r}")
        return
    if parameter.value_type == "boolean":
        if not isinstance(value, bool):
            issues.append(f"{label}必须是布尔值")
        return
    if parameter.value_type in {"integer", "number"}:
        valid_number = isinstance(value, (int, float)) and not isinstance(value, bool)
        if not valid_number or (parameter.value_type == "integer" and not isinstance(value, int)):
            issues.append(f"{label}必须是{'整数' if parameter.value_type == 'integer' else '数值'}")
            return
        numeric = float(value)
        if parameter.minimum is not None and numeric < parameter.minimum:
            issues.append(f"{label}不能小于{parameter.minimum:g}")
        if parameter.maximum is not None and numeric > parameter.maximum:
            issues.append(f"{label}不能大于{parameter.maximum:g}")
        return
    if parameter.value_type == "enum":
        if value not in parameter.choices:
            issues.append(f"{label}必须是以下值之一: {', '.join(parameter.choices)}")
        return
    if parameter.value_type == "object_enum":
        if not isinstance(value, Mapping) or parameter.child_key not in value:
            issues.append(f"{label}必须包含{parameter.child_key}")
            return
        child_value = value[parameter.child_key]
        if child_value not in parameter.choices:
            issues.append(
                f"{label}.{parameter.child_key}必须是以下值之一: {', '.join(parameter.choices)}"
            )


def _validate_message_input(
    request_input: Any,
    *,
    capabilities: ModelCapabilities,
    allowed_tool_names: Sequence[str] = (),
    issues: list[str],
) -> None:
    if isinstance(request_input, str):
        if not request_input.strip():
            issues.append("input文字不能为空")
        return
    if not isinstance(request_input, list) or not request_input:
        issues.append("input必须是非空字符串或消息数组")
        return
    for message_index, message in enumerate(request_input):
        prefix = f"input[{message_index}]"
        if not isinstance(message, Mapping):
            issues.append(f"{prefix}必须是消息对象")
            continue
        item_type = message.get("type")
        if item_type in {"function_call", "function_call_output", "reasoning"}:
            # Responses API represents later tool-loop turns as typed input
            # items rather than role/content messages. They remain visible and
            # editable in Provider JSON, while Tool declarations are validated
            # separately against the server-owned catalog.
            if item_type == "function_call":
                function_name = message.get("name")
                if not isinstance(function_name, str):
                    issues.append(f"{prefix}.name必须是字符串")
                elif function_name not in set(allowed_tool_names):
                    issues.append(f"{prefix}.name引用了未授权Tool: {function_name}")
            if item_type == "function_call_output" and "output" not in message:
                issues.append(f"{prefix}.output不能省略")
            continue
        role = message.get("role")
        if not isinstance(role, str) or role not in capabilities.roles:
            issues.append(f"{prefix}.role必须是以下角色之一: {', '.join(capabilities.roles)}")
            continue
        content = message.get("content")
        if isinstance(content, str):
            if not content.strip():
                issues.append(f"{prefix}.content不能为空")
            continue
        if not isinstance(content, list) or not content:
            issues.append(f"{prefix}.content必须是非空文字或内容列表")
            continue
        allowed_types = capabilities.content_types(role)
        for content_index, part in enumerate(content):
            part_prefix = f"{prefix}.content[{content_index}]"
            if not isinstance(part, Mapping):
                issues.append(f"{part_prefix}必须是内容对象")
                continue
            content_type = part.get("type")
            if not isinstance(content_type, str) or content_type not in allowed_types:
                issues.append(
                    f"{part_prefix}.type与角色{role}不兼容；可选: {', '.join(allowed_types) or '无'}"
                )
                continue
            if content_type in {"input_text", "output_text", "refusal", "text"}:
                text = part.get("text")
                if not isinstance(text, str) or not text.strip():
                    issues.append(f"{part_prefix}.text不能为空")
            if content_type in {"input_image", "image_url"}:
                image_url = part.get("image_url")
                if isinstance(image_url, Mapping):
                    image_url = image_url.get("url")
                if not isinstance(image_url, str) or not image_url.strip():
                    issues.append(f"{part_prefix}.image_url不能为空")


def validate_provider_request(
    provider_request: Mapping[str, Any],
    capabilities: ModelCapabilities | None = None,
    protocol: str = "openai_responses",
    *,
    allowed_tool_names: Sequence[str] = (),
) -> None:
    """Validate shape and the already-approved full-context policy.

    Every body field stays editable in the draft.  A changed draft is only
    sendable when it is syntactically valid and still satisfies the currently
    approved ``store=False`` / no-continuation policy.
    """

    issues: list[str] = []
    resolved_capabilities = capabilities or DEFAULT_MODEL_CAPABILITIES
    model = provider_request.get("model")
    if not isinstance(model, str) or not model.strip():
        issues.append("model必须是非空字符串")

    instructions = provider_request.get("instructions")
    if instructions is not None and not isinstance(instructions, str):
        issues.append("instructions必须是字符串或省略")

    message_field = "messages" if protocol == "openai_chat_completions" else "input"
    _validate_message_input(
        provider_request.get(message_field),
        capabilities=resolved_capabilities,
        allowed_tool_names=allowed_tool_names,
        issues=issues,
    )
    unexpected_message_field = "input" if message_field == "messages" else "messages"
    if unexpected_message_field in provider_request:
        issues.append(f"{protocol}协议不应包含{unexpected_message_field}字段")

    tools = provider_request.get("tools")
    if tools is not None and not isinstance(tools, list):
        issues.append("tools必须是数组或省略")
    elif tools:
        allowed = set(allowed_tool_names)
        if not allowed:
            issues.append("当前没有已注册且可执行的Tool，tools必须为空")
        seen: set[str] = set()
        for index, tool in enumerate(tools):
            if not isinstance(tool, Mapping):
                issues.append(f"tools[{index}]必须是Tool定义对象")
                continue
            function = tool.get("function")
            name = (
                function.get("name")
                if isinstance(function, Mapping)
                else tool.get("name")
            )
            if not isinstance(name, str) or not name.strip():
                issues.append(f"tools[{index}]缺少有效name")
                continue
            if allowed and name not in allowed:
                issues.append(f"tools[{index}]声明了未注册或未授权Tool: {name}")
            if name in seen:
                issues.append(f"tools中存在重复Tool: {name}")
            seen.add(name)

    continuation = sorted(field for field in _CONTINUATION_FIELDS if provider_request.get(field) is not None)
    if continuation:
        issues.append(f"当前完整上下文策略禁止Continuation字段: {', '.join(continuation)}")

    parameter_keys = {
        key
        for key in provider_request
        if key not in _RESERVED_TOP_LEVEL_FIELDS and key not in _CONTINUATION_FIELDS
    }
    for parameter in resolved_capabilities.parameters:
        if parameter.key in provider_request:
            _validate_parameter(parameter, provider_request[parameter.key], issues=issues)
    unknown_parameters = sorted(
        key
        for key in parameter_keys
        if resolved_capabilities.parameter(key) is None
    )
    if unknown_parameters and not resolved_capabilities.allow_unknown_parameters:
        issues.append(f"当前模型没有声明这些参数能力: {', '.join(unknown_parameters)}")

    if provider_request.get("store") is not False:
        issues.append("当前完整上下文策略要求store=false")

    try:
        canonical_json_bytes(provider_request)
    except (TypeError, ValueError) as error:
        issues.append(f"请求不是有效JSON: {error}")

    if issues:
        raise ModelCallDraftValidationError(issues)


def _message_text(message: Mapping[str, Any]) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for part in content:
        if not isinstance(part, Mapping):
            continue
        text = part.get("text")
        if isinstance(text, str):
            parts.append(text)
    return "\n".join(parts)


def _provider_content(message: Mapping[str, Any]) -> list[dict[str, Any]]:
    role = str(message.get("role") or "user")
    content = message.get("content")
    if isinstance(content, str):
        content_type = "output_text" if role == "assistant" else "input_text"
        return [{"type": content_type, "text": content}]
    if not isinstance(content, list):
        return [{"type": "input_text", "text": str(content or "")}]

    provider_parts: list[dict[str, Any]] = []
    for part in content:
        if not isinstance(part, Mapping):
            provider_parts.append({"type": "input_text", "text": str(part)})
            continue
        part_type = part.get("type")
        if part_type == "text" and isinstance(part.get("text"), str):
            content_type = "output_text" if role == "assistant" else "input_text"
            provider_parts.append({"type": content_type, "text": part["text"]})
            continue
        if part_type == "image" and isinstance(part.get("source"), Mapping):
            source = part["source"]
            if source.get("type") == "url":
                provider_parts.append({"type": "input_image", "image_url": source.get("value")})
                continue
            if source.get("type") == "data":
                mime_type = str(source.get("mimeType") or "application/octet-stream")
                provider_parts.append(
                    {
                        "type": "input_image",
                        "image_url": f"data:{mime_type};base64,{source.get('value', '')}",
                    }
                )
                continue
        # Preserve provider-shaped parts and future fields instead of silently
        # dropping content the user must be able to inspect and edit.
        provider_parts.append(copy.deepcopy(dict(part)))
    return provider_parts


def _chat_content(message: Mapping[str, Any]) -> str | list[dict[str, Any]]:
    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return str(content or "")
    parts: list[dict[str, Any]] = []
    text_only = True
    for part in content:
        if not isinstance(part, Mapping):
            parts.append({"type": "text", "text": str(part)})
            continue
        part_type = part.get("type")
        if part_type in {"text", "input_text", "output_text"} and isinstance(part.get("text"), str):
            parts.append({"type": "text", "text": part["text"]})
            continue
        if part_type in {"image", "input_image", "image_url"}:
            text_only = False
            image_url = part.get("image_url")
            if isinstance(image_url, Mapping):
                parts.append({"type": "image_url", "image_url": copy.deepcopy(dict(image_url))})
                continue
            if isinstance(image_url, str):
                parts.append({"type": "image_url", "image_url": {"url": image_url}})
                continue
        text_only = False
        parts.append(copy.deepcopy(dict(part)))
    if text_only:
        return "\n".join(str(part.get("text") or "") for part in parts)
    return parts


def compile_provider_request(
    *,
    model: str,
    messages: Sequence[Mapping[str, Any]],
    instructions: str = DEFAULT_INSTRUCTIONS,
    capabilities: ModelCapabilities = DEFAULT_MODEL_CAPABILITIES,
    protocol: str = "openai_responses",
) -> dict[str, Any]:
    """Compile one explicit Responses-style provider request."""

    provider_messages: list[dict[str, Any]] = []
    for message in messages:
        role = str(message.get("role") or "")
        if role not in {"user", "assistant", "system", "developer", "tool"}:
            continue
        item: dict[str, Any] = {
            "role": role,
            "content": (
                _chat_content(message)
                if protocol == "openai_chat_completions"
                else _provider_content(message)
            ),
        }
        if role == "tool" and message.get("toolCallId"):
            item["tool_call_id"] = str(message["toolCallId"])
        provider_messages.append(item)

    if protocol == "openai_chat_completions":
        request = {
            "model": model,
            "messages": [
                {"role": "system", "content": instructions},
                *provider_messages,
            ],
            "tools": [],
            "store": False,
            "stream": True,
        }
    else:
        request = {
            "model": model,
            "instructions": instructions,
            "input": provider_messages,
            "tools": [],
            "store": False,
            "stream": True,
        }
    validate_provider_request(request, capabilities, protocol)
    return request


def _estimate_value_tokens(value: Any) -> int:
    """Return a transparent Unicode heuristic, never an exact tokenizer claim."""

    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, sort_keys=True)
    cjk = sum(1 for char in text if "\u3400" <= char <= "\u9fff")
    other = len(text) - cjk
    return max(1, cjk + (other + 3) // 4)


def _token_breakdown(provider_request: Mapping[str, Any]) -> dict[str, Any]:
    messages = provider_request.get("input", provider_request.get("messages", []))
    message_items = messages if isinstance(messages, list) else [messages]
    parameters = {
        key: value
        for key, value in provider_request.items()
        if key not in {"instructions", "input", "messages", "tools"}
    }
    breakdown = {
        "instructions": _estimate_value_tokens(provider_request.get("instructions", "")),
        "messages": [_estimate_value_tokens(item) for item in message_items],
        "tools": _estimate_value_tokens(provider_request.get("tools", [])),
        "parameters": _estimate_value_tokens(parameters),
    }
    breakdown["total"] = (
        breakdown["instructions"]
        + sum(breakdown["messages"])
        + breakdown["tools"]
        + breakdown["parameters"]
    )
    breakdown["method"] = "unicode_heuristic_v1"
    breakdown["exact"] = False
    return breakdown


def _effective_instructions(provider_request: Mapping[str, Any]) -> str | None:
    instructions = provider_request.get("instructions")
    if isinstance(instructions, str):
        return instructions
    messages = provider_request.get("messages")
    if not isinstance(messages, list):
        return None
    system = next(
        (
            item
            for item in messages
            if isinstance(item, Mapping) and item.get("role") == "system"
        ),
        None,
    )
    return _message_text(system) if isinstance(system, Mapping) else None


def _instruction_message_index(provider_request: Mapping[str, Any]) -> int | None:
    messages = provider_request.get("messages")
    if not isinstance(messages, list):
        return None
    return next(
        (
            index
            for index, item in enumerate(messages)
            if isinstance(item, Mapping) and item.get("role") == "system"
        ),
        None,
    )


def _initial_context_sources(provider_request: Mapping[str, Any]) -> tuple[dict[str, Any], ...]:
    request_input = provider_request.get("input", provider_request.get("messages"))
    if not isinstance(request_input, list):
        return (
            {
                "input_index": 0,
                "source_type": "current_input",
                "source_label": "本轮用户输入",
                "adoption_reason": "用户在本轮明确提交，作为当前任务输入采用",
                "modified_in_review": False,
            },
        )
    instruction_index = _instruction_message_index(provider_request)
    last_user_index = max(
        (index for index, item in enumerate(request_input) if isinstance(item, Mapping) and item.get("role") == "user"),
        default=len(request_input) - 1,
    )
    sources: list[dict[str, Any]] = []
    for index in range(len(request_input)):
        instructions = index == instruction_index
        current = index == last_user_index
        sources.append(
            {
                "input_index": index,
                "source_type": "agent_instructions" if instructions else "current_input" if current else "conversation_history",
                "source_label": "Agent Instructions" if instructions else "本轮用户输入" if current else "当前会话历史",
                "adoption_reason": (
                    "当前Agent的行为约束；Chat Completions协议将其作为system消息发送"
                    if instructions
                    else "用户在本轮明确提交，作为当前任务输入采用"
                    if current
                    else "位于当前活动消息路径中，为保持对话连续性而采用"
                ),
                "modified_in_review": False,
            }
        )
    return tuple(sources)


def _semantic_message(message: Any) -> Any:
    """Normalize protocol-specific text/image wrappers for provenance comparison."""

    if not isinstance(message, Mapping):
        return message
    content = message.get("content")
    if isinstance(content, str):
        normalized_content: Any = (("text", content),)
    elif isinstance(content, list):
        parts: list[Any] = []
        for part in content:
            if not isinstance(part, Mapping):
                parts.append(part)
                continue
            if part.get("type") in {"text", "input_text", "output_text"}:
                parts.append(("text", part.get("text")))
                continue
            if part.get("type") in {"image", "input_image", "image_url"}:
                image_url = part.get("image_url")
                if isinstance(image_url, Mapping):
                    image_url = image_url.get("url")
                parts.append(("image", image_url))
                continue
            parts.append(copy.deepcopy(dict(part)))
        normalized_content = tuple(parts)
    else:
        normalized_content = content
    return (message.get("role"), normalized_content)


def _reconcile_context_sources(
    previous_sources: Sequence[Mapping[str, Any]],
    previous_request: Mapping[str, Any],
    revised_request: Mapping[str, Any],
) -> tuple[dict[str, Any], ...]:
    previous_input = previous_request.get("input", previous_request.get("messages"))
    revised_input = revised_request.get("input", revised_request.get("messages"))
    if not isinstance(revised_input, list):
        return _initial_context_sources(revised_request)
    previous_items = previous_input if isinstance(previous_input, list) else []
    previous_instruction_index = _instruction_message_index(previous_request)
    revised_instruction_index = _instruction_message_index(revised_request)
    previous_context_items = [
        item for index, item in enumerate(previous_items) if index != previous_instruction_index
    ]
    previous_context_sources = [
        source
        for index, source in enumerate(previous_sources)
        if index != previous_instruction_index
    ]
    revised_context_index = 0
    sources: list[dict[str, Any]] = []
    for index, item in enumerate(revised_input):
        if index == revised_instruction_index:
            modified = _effective_instructions(previous_request) != _effective_instructions(revised_request)
            source = {
                "input_index": index,
                "source_type": "agent_instructions",
                "source_label": "Agent Instructions",
                "adoption_reason": (
                    "当前Agent的行为约束；Chat Completions协议将其作为system消息发送"
                    + ("；本次发送前已由用户修改并重新审批" if modified else "")
                ),
                "modified_in_review": modified,
            }
        elif revised_context_index < len(previous_context_sources):
            source = copy.deepcopy(dict(previous_context_sources[revised_context_index]))
            source["input_index"] = index
            source["modified_in_review"] = (
                revised_context_index >= len(previous_context_items)
                or _semantic_message(item)
                != _semantic_message(previous_context_items[revised_context_index])
            )
            if source["modified_in_review"]:
                source["adoption_reason"] = (
                    f"{source.get('adoption_reason', '来自已采用上下文')}；本次发送前已由用户修改并重新审批"
                )
        else:
            source = {
                "input_index": index,
                "source_type": "manual_context",
                "source_label": "审批时手动添加",
                "adoption_reason": "用户在发送前审核中主动添加到本次模型上下文",
                "modified_in_review": True,
            }
        sources.append(source)
        if index != revised_instruction_index:
            revised_context_index += 1
    return tuple(sources)


def effective_context_view(
    provider_request: Mapping[str, Any],
    context_sources: Sequence[Mapping[str, Any]] = (),
    capabilities: ModelCapabilities = DEFAULT_MODEL_CAPABILITIES,
) -> dict[str, Any]:
    """Project a readable view from the same canonical provider request."""

    continuation = {
        field: copy.deepcopy(provider_request[field])
        for field in sorted(_CONTINUATION_FIELDS)
        if field in provider_request
    }
    model_parameters = {
        key: copy.deepcopy(value)
        for key, value in provider_request.items()
        if key not in _RESERVED_TOP_LEVEL_FIELDS and key not in _CONTINUATION_FIELDS
    }
    token_breakdown = _token_breakdown(provider_request)
    messages = copy.deepcopy(provider_request.get("input", provider_request.get("messages", [])))
    source_items: list[dict[str, Any]] = []
    if isinstance(messages, list):
        for index, message in enumerate(messages):
            source = copy.deepcopy(dict(context_sources[index])) if index < len(context_sources) else {
                "input_index": index,
                "source_type": "unknown",
                "source_label": "未标注来源",
                "adoption_reason": "该内容存在于当前规范Provider请求中",
                "modified_in_review": False,
            }
            source["content"] = copy.deepcopy(message)
            source["token_estimate"] = token_breakdown["messages"][index]
            source_items.append(source)
    return {
        "instructions": _effective_instructions(provider_request),
        "messages": messages,
        "history_and_knowledge": source_items,
        "knowledge_sources": [],
        "tools": copy.deepcopy(provider_request.get("tools", [])),
        "model_parameters": {
            "model": copy.deepcopy(provider_request.get("model")),
            **model_parameters,
        },
        "continuation": continuation or None,
        "token_estimate": token_breakdown["total"],
        "token_breakdown": token_breakdown,
        "model_capabilities": capabilities.public_view(),
        "adoption_reasons": {
            "instructions": "当前Agent的可编辑行为约束",
            "messages": "本次AG-UI请求中被装配进模型上下文的完整消息",
            "history_and_knowledge": "逐项展示进入本次消息数组的行为约束、本轮输入、会话历史和手动上下文来源；当前没有独立知识源",
            "tools": "本次向模型声明的工具定义；声明不自动授予真实执行权限",
            "model_parameters": "本次调用选择的模型、输出、推理和传输参数",
        },
    }


@dataclass(frozen=True, slots=True)
class ModelCallDraft:
    draft_id: str
    approval_id: str
    thread_id: str
    run_id: str
    version: int
    origin_prompt: str
    provider_id: str
    provider_protocol: str
    provider_catalog: tuple[dict[str, object], ...]
    provider_request: dict[str, Any]
    body: bytes
    body_sha256: str
    binding_hash: str
    context_sources: tuple[dict[str, Any], ...]
    model_capabilities: ModelCapabilities
    allowed_tool_names: tuple[str, ...] = ()
    execution_context: dict[str, Any] = field(default_factory=dict)
    status: str = "pending_approval"
    previous_draft_id: str | None = None

    def review_card(self) -> dict[str, Any]:
        return {
            "message": "请审核本次模型调用",
            "review_kind": "model_call",
            "draft_id": self.draft_id,
            "approval_id": self.approval_id,
            "thread_id": self.thread_id,
            "run_id": self.run_id,
            "version": self.version,
            "origin_prompt": self.origin_prompt,
            "binding_hash": self.binding_hash,
            "body_sha256": self.body_sha256,
            "provider_id": self.provider_id,
            "provider_protocol": self.provider_protocol,
            "status": self.status,
            "execution_context": copy.deepcopy(self.execution_context),
            "provider_catalog": copy.deepcopy(list(self.provider_catalog)),
            "effective_context": effective_context_view(
                self.provider_request,
                self.context_sources,
                self.model_capabilities,
            ),
            "provider_request": copy.deepcopy(self.provider_request),
        }


@dataclass(slots=True)
class ModelCallAttempt:
    attempt_id: str
    approval_id: str
    draft_id: str
    owner: str
    status: str = "claimed"
    error_code: str | None = None


class InMemoryModelCallReviewStore:
    """Process-local review state with production-equivalent invariants."""

    def __init__(self, provider_catalog: ModelProviderCatalog | None = None) -> None:
        self._lock = threading.RLock()
        self._provider_catalog = provider_catalog
        self._drafts: dict[str, ModelCallDraft] = {}
        self._current_by_thread: dict[str, str] = {}
        self._approval_status: dict[str, str] = {}
        self._attempts: dict[str, ModelCallAttempt] = {}
        self._attempt_by_approval: dict[str, str] = {}

    def _make_draft(
        self,
        *,
        thread_id: str,
        run_id: str,
        version: int,
        origin_prompt: str,
        provider_id: str,
        provider_request: Mapping[str, Any],
        previous_draft_id: str | None,
        previous_draft: ModelCallDraft | None = None,
        execution_context: Mapping[str, Any] | None = None,
        allowed_tool_names: Sequence[str] = (),
        capabilities: ModelCapabilities | None = None,
    ) -> ModelCallDraft:
        request_copy = copy.deepcopy(dict(provider_request))
        catalog = self._require_catalog(str(request_copy.get("model") or ""))
        try:
            provider = catalog.require_selection(provider_id, str(request_copy.get("model") or ""))
            model_option = catalog.require_model(provider_id, str(request_copy.get("model") or ""))
        except ModelProviderCatalogError as error:
            raise ModelCallDraftValidationError([str(error)]) from error
        resolved_capabilities = capabilities or model_option.capabilities
        validate_provider_request(
            request_copy,
            resolved_capabilities,
            provider.protocol,
            allowed_tool_names=allowed_tool_names,
        )
        context_sources = (
            _reconcile_context_sources(
                previous_draft.context_sources,
                previous_draft.provider_request,
                request_copy,
            )
            if previous_draft is not None
            else _initial_context_sources(request_copy)
        )
        body = canonical_json_bytes(request_copy)
        body_sha256 = hashlib.sha256(body).hexdigest()
        binding_hash = hashlib.sha256(
            canonical_json_bytes({"provider_id": provider_id, "body_sha256": body_sha256})
        ).hexdigest()
        return ModelCallDraft(
            draft_id=_new_id("model_call_draft"),
            approval_id=_new_id("model_call_approval"),
            thread_id=thread_id,
            run_id=run_id,
            version=version,
            origin_prompt=origin_prompt,
            provider_id=provider_id,
            provider_protocol=provider.protocol,
            provider_catalog=tuple(catalog.public_view()),
            provider_request=request_copy,
            body=body,
            body_sha256=body_sha256,
            binding_hash=binding_hash,
            context_sources=context_sources,
            model_capabilities=resolved_capabilities,
            allowed_tool_names=tuple(allowed_tool_names),
            execution_context=copy.deepcopy(
                dict(execution_context or (previous_draft.execution_context if previous_draft else {}))
            ),
            previous_draft_id=previous_draft_id,
        )

    def _require_catalog(self, model: str) -> ModelProviderCatalog:
        if self._provider_catalog is None:
            provider = ModelProviderConfig(
                id="configured",
                label="Configured Provider",
                models=(ModelOption(id=model, label=model),),
                base_url=None,
                api_key="test-or-injected",
            )
            self._provider_catalog = ModelProviderCatalog(
                providers=(provider,),
                default_provider_id=provider.id,
                default_model=model,
            )
        return self._provider_catalog

    def begin(
        self,
        *,
        thread_id: str,
        run_id: str,
        messages: Sequence[Mapping[str, Any]],
        model: str,
        provider_id: str | None = None,
        instructions: str = DEFAULT_INSTRUCTIONS,
        execution_context: Mapping[str, Any] | None = None,
        origin_prompt: str | None = None,
    ) -> ModelCallDraft:
        resolved_origin_prompt = origin_prompt or ""
        if not resolved_origin_prompt:
            for message in reversed(messages):
                if message.get("role") == "user":
                    resolved_origin_prompt = _message_text(message)
                    break
        catalog = self._require_catalog(model)
        selected_provider_id = provider_id or catalog.default_provider_id
        try:
            selected_provider = catalog.require_selection(selected_provider_id, model)
            model_capabilities = catalog.require_model(selected_provider_id, model).capabilities
        except ModelProviderCatalogError as error:
            raise ModelCallDraftValidationError([str(error)]) from error
        draft = self._make_draft(
            thread_id=thread_id,
            run_id=run_id,
            version=1,
            origin_prompt=resolved_origin_prompt,
            provider_id=selected_provider_id,
            provider_request=compile_provider_request(
                model=model,
                messages=messages,
                instructions=instructions,
                capabilities=model_capabilities,
                protocol=selected_provider.protocol,
            ),
            previous_draft_id=None,
            execution_context=execution_context,
        )
        with self._lock:
            current_id = self._current_by_thread.get(thread_id)
            if current_id is not None:
                current = self._drafts[current_id]
                if current.status == "pending_approval":
                    raise ModelCallDraftConflict("当前Thread已有待审批模型调用")
            self._drafts[draft.draft_id] = draft
            self._current_by_thread[thread_id] = draft.draft_id
            self._approval_status[draft.approval_id] = "pending"
        return draft

    def begin_provider_request(
        self,
        *,
        thread_id: str,
        run_id: str,
        provider_id: str,
        provider_request: Mapping[str, Any],
        origin_prompt: str,
        allowed_tool_names: Sequence[str],
        execution_context: Mapping[str, Any] | None = None,
    ) -> ModelCallDraft:
        """Create a draft from an already Provider-shaped runtime request.

        pi owns its model loop and therefore produces the protocol body before
        Chat can pause it. Chat still canonicalizes that body once, validates
        every declared Tool against the execution snapshot, and forwards only
        the bytes bound to the user's approval.
        """

        request_copy = copy.deepcopy(dict(provider_request))
        model = str(request_copy.get("model") or "")
        catalog = self._require_catalog(model)
        try:
            model_option = catalog.require_model(provider_id, model)
        except ModelProviderCatalogError as error:
            raise ModelCallDraftValidationError([str(error)]) from error
        runtime_parameters = tuple(
            ParameterCapability(
                key=value.key,
                label=value.label,
                value_type=value.value_type,
                default=value.default,
                choices=value.choices,
                minimum=value.minimum,
                maximum=value.maximum,
                child_key=value.child_key,
                locked_value=True,
                locked=True,
            )
            if value.key == "stream"
            else value
            for value in model_option.capabilities.parameters
        )
        capabilities = ModelCapabilities(
            roles=model_option.capabilities.roles,
            content_types_by_role=model_option.capabilities.content_types_by_role,
            parameters=runtime_parameters,
            token_estimator=model_option.capabilities.token_estimator,
            allow_unknown_parameters=True,
        )
        draft = self._make_draft(
            thread_id=thread_id,
            run_id=run_id,
            version=1,
            origin_prompt=origin_prompt,
            provider_id=provider_id,
            provider_request=request_copy,
            previous_draft_id=None,
            execution_context=execution_context,
            allowed_tool_names=allowed_tool_names,
            capabilities=capabilities,
        )
        with self._lock:
            current_id = self._current_by_thread.get(thread_id)
            if current_id is not None:
                current = self._drafts[current_id]
                if current.status == "pending_approval":
                    raise ModelCallDraftConflict("当前Thread已有待审批模型调用")
            self._drafts[draft.draft_id] = draft
            self._current_by_thread[thread_id] = draft.draft_id
            self._approval_status[draft.approval_id] = "pending"
        return draft

    def get(self, draft_id: str) -> ModelCallDraft:
        with self._lock:
            draft = self._drafts.get(draft_id)
            if draft is None:
                raise LookupError(draft_id)
            return draft

    def current_for_thread(self, thread_id: str) -> ModelCallDraft | None:
        with self._lock:
            draft_id = self._current_by_thread.get(thread_id)
            return self._drafts.get(draft_id) if draft_id else None

    def revise(
        self,
        *,
        draft_id: str,
        expected_hash: str,
        provider_id: str,
        provider_request: Mapping[str, Any],
    ) -> ModelCallDraft:
        request_copy = copy.deepcopy(dict(provider_request))
        with self._lock:
            old = self.get(draft_id)
            if old.status != "pending_approval" or self._approval_status[old.approval_id] != "pending":
                raise ModelCallDraftConflict("只有当前待审批草稿可以修改")
            if old.binding_hash != expected_hash:
                raise ModelCallDraftConflict("草稿Hash已变化，请刷新后再修改")
            revised_capabilities: ModelCapabilities | None = None
            if old.model_capabilities.allow_unknown_parameters:
                try:
                    option = self._require_catalog(
                        str(request_copy.get("model") or "")
                    ).require_model(provider_id, str(request_copy.get("model") or ""))
                except ModelProviderCatalogError as error:
                    raise ModelCallDraftValidationError([str(error)]) from error
                revised_capabilities = ModelCapabilities(
                    roles=option.capabilities.roles,
                    content_types_by_role=option.capabilities.content_types_by_role,
                    parameters=tuple(
                        ParameterCapability(
                            key=value.key,
                            label=value.label,
                            value_type=value.value_type,
                            default=value.default,
                            choices=value.choices,
                            minimum=value.minimum,
                            maximum=value.maximum,
                            child_key=value.child_key,
                            locked_value=True,
                            locked=True,
                        )
                        if value.key == "stream"
                        else value
                        for value in option.capabilities.parameters
                    ),
                    token_estimator=option.capabilities.token_estimator,
                    allow_unknown_parameters=True,
                )
            revised = self._make_draft(
                thread_id=old.thread_id,
                run_id=old.run_id,
                version=old.version + 1,
                origin_prompt=old.origin_prompt,
                provider_id=provider_id,
                provider_request=request_copy,
                previous_draft_id=old.draft_id,
                previous_draft=old,
                execution_context=old.execution_context,
                allowed_tool_names=old.allowed_tool_names,
                capabilities=revised_capabilities,
            )
            self._drafts[old.draft_id] = dataclass_replace(old, status="superseded")
            self._approval_status[old.approval_id] = "superseded"
            self._drafts[revised.draft_id] = revised
            self._approval_status[revised.approval_id] = "pending"
            self._current_by_thread[old.thread_id] = revised.draft_id
            return revised

    def successor(self, old_draft_id: str, new_draft_id: str) -> ModelCallDraft:
        with self._lock:
            draft = self.get(new_draft_id)
            if draft.previous_draft_id != old_draft_id or draft.status != "pending_approval":
                raise ModelCallDraftConflict("修改结果不是当前草稿的服务端后继版本")
            return draft

    def claim(self, *, approval_id: str, expected_hash: str, owner: str) -> ModelCallDraft:
        with self._lock:
            if self._approval_status.get(approval_id) != "pending":
                raise ModelCallDraftConflict("审批已失效或已消费")
            draft = next((item for item in self._drafts.values() if item.approval_id == approval_id), None)
            if draft is None or draft.status != "pending_approval":
                raise ModelCallDraftConflict("审批没有绑定可发送草稿")
            if draft.binding_hash != expected_hash:
                raise ModelCallDraftConflict("审批Hash与当前请求不一致")
            if approval_id in self._attempt_by_approval:
                raise ModelCallDraftConflict("该审批已创建发送尝试")
            try:
                self._require_catalog(
                    str(draft.provider_request.get("model") or "")
                ).require_model(
                    draft.provider_id,
                    str(draft.provider_request.get("model") or ""),
                )
            except ModelProviderCatalogError as error:
                raise ModelCallDraftConflict(str(error)) from error
            validate_provider_request(
                draft.provider_request,
                draft.model_capabilities,
                draft.provider_protocol,
                allowed_tool_names=draft.allowed_tool_names,
            )
            attempt = ModelCallAttempt(
                attempt_id=_new_id("model_call_attempt"),
                approval_id=approval_id,
                draft_id=draft.draft_id,
                owner=owner,
            )
            self._attempts[attempt.attempt_id] = attempt
            self._attempt_by_approval[approval_id] = attempt.attempt_id
            self._approval_status[approval_id] = "consumed"
            self._drafts[draft.draft_id] = dataclass_replace(draft, status="dispatching")
            return self._drafts[draft.draft_id]

    def mark_attempt(self, approval_id: str, status: str, *, error_code: str | None = None) -> None:
        with self._lock:
            attempt_id = self._attempt_by_approval.get(approval_id)
            if attempt_id is None:
                raise ModelCallDraftConflict("该审批没有发送尝试")
            attempt = self._attempts[attempt_id]
            attempt.status = status
            attempt.error_code = error_code
            draft = self.get(attempt.draft_id)
            self._drafts[draft.draft_id] = dataclass_replace(draft, status=status)

    def abandon(self, approval_id: str) -> ModelCallDraft:
        with self._lock:
            if self._approval_status.get(approval_id) != "pending":
                raise ModelCallDraftConflict("只有待审批调用可以放弃")
            draft = next((item for item in self._drafts.values() if item.approval_id == approval_id), None)
            if draft is None:
                raise LookupError(approval_id)
            self._approval_status[approval_id] = "abandoned"
            self._drafts[draft.draft_id] = dataclass_replace(draft, status="abandoned")
            return self._drafts[draft.draft_id]

    def attempts(self) -> list[ModelCallAttempt]:
        with self._lock:
            return [copy.copy(item) for item in self._attempts.values()]

    def review_card(self, draft_id: str) -> dict[str, Any]:
        with self._lock:
            draft = self.get(draft_id)
            card = draft.review_card()
            attempt = next(
                (item for item in self._attempts.values() if item.draft_id == draft_id),
                None,
            )
            card["attempt"] = (
                {
                    "attempt_id": attempt.attempt_id,
                    "status": attempt.status,
                    "error_code": attempt.error_code,
                }
                if attempt is not None
                else None
            )
            return card


def dataclass_replace(draft: ModelCallDraft, *, status: str) -> ModelCallDraft:
    """Replace only mutable lifecycle state while preserving immutable bytes."""

    return ModelCallDraft(
        draft_id=draft.draft_id,
        approval_id=draft.approval_id,
        thread_id=draft.thread_id,
        run_id=draft.run_id,
        version=draft.version,
        origin_prompt=draft.origin_prompt,
        provider_id=draft.provider_id,
        provider_protocol=draft.provider_protocol,
        provider_catalog=draft.provider_catalog,
        provider_request=draft.provider_request,
        body=draft.body,
        body_sha256=draft.body_sha256,
        binding_hash=draft.binding_hash,
        context_sources=draft.context_sources,
        model_capabilities=draft.model_capabilities,
        allowed_tool_names=draft.allowed_tool_names,
        execution_context=copy.deepcopy(draft.execution_context),
        status=status,
        previous_draft_id=draft.previous_draft_id,
    )


@dataclass(frozen=True, slots=True)
class PreparedProviderRequest:
    provider_id: str
    body: bytes
    body_sha256: str
    provider_request: dict[str, Any]

    @classmethod
    def from_draft(cls, draft: ModelCallDraft) -> "PreparedProviderRequest":
        return cls(
            provider_id=draft.provider_id,
            body=draft.body,
            body_sha256=draft.body_sha256,
            provider_request=copy.deepcopy(draft.provider_request),
        )


@dataclass(slots=True)
class ExactProviderTransport:
    """Send the exact approved body and translate common response text events."""

    endpoint: str
    api_key: str | None
    timeout_seconds: float = 60.0
    extra_headers: dict[str, str] = field(default_factory=dict)

    async def stream(self, prepared: PreparedProviderRequest) -> AsyncIterator[str]:
        headers = {"content-type": "application/json", **self.extra_headers}
        if self.api_key:
            headers["authorization"] = f"Bearer {self.api_key}"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_seconds, follow_redirects=False) as client:
                async with client.stream("POST", self.endpoint, content=prepared.body, headers=headers) as response:
                    if response.is_error:
                        error_body = await response.aread()
                        raise ProviderDispatchError(
                            _safe_provider_status_error(response.status_code, error_body),
                            error_code=f"provider_http_{response.status_code}",
                            outcome_status="failed",
                        )
                    content_type = response.headers.get("content-type", "")
                    if "text/event-stream" in content_type:
                        async for line in response.aiter_lines():
                            if not line.startswith("data:"):
                                continue
                            data = line.removeprefix("data:").strip()
                            if not data or data == "[DONE]":
                                continue
                            for text in _provider_text(json.loads(data)):
                                yield text
                        return
                    payload = json.loads((await response.aread()).decode("utf-8"))
                    for text in _provider_text(payload):
                        yield text
        except httpx.TimeoutException as error:
            raise ProviderDispatchError(
                _redacted_provider_error(error),
                error_code="provider_timeout",
                outcome_status="outcome_unknown",
            ) from error
        except httpx.HTTPError as error:
            raise ProviderDispatchError(
                _redacted_provider_error(error),
                error_code="provider_connection_failed",
                outcome_status="outcome_unknown",
            ) from error
        except json.JSONDecodeError as error:
            raise ProviderDispatchError(
                _redacted_provider_error(error),
                error_code="provider_response_invalid",
                outcome_status="outcome_unknown",
            ) from error


@dataclass(slots=True)
class RoutedProviderTransport:
    """Route an approved provider/model pair without exposing credentials to the draft."""

    transports: Mapping[str, ExactProviderTransport]

    async def stream(self, prepared: PreparedProviderRequest) -> AsyncIterator[str]:
        transport = self.transports.get(prepared.provider_id)
        if transport is None:
            raise ProviderDispatchError(f"Provider路由不存在: {prepared.provider_id}")
        async for text in transport.stream(prepared):
            yield text


def _safe_provider_status_error(status_code: int, body: bytes) -> str:
    """Expose a bounded provider validation message without echoing headers or request data."""

    detail = ""
    try:
        payload = json.loads(body.decode("utf-8"))
        error = payload.get("error") if isinstance(payload, Mapping) else None
        if isinstance(error, Mapping):
            parts = [error.get("code"), error.get("type"), error.get("message")]
            detail = " | ".join(str(part) for part in parts if part)
        elif isinstance(payload, Mapping) and isinstance(payload.get("message"), str):
            detail = payload["message"]
    except (UnicodeDecodeError, json.JSONDecodeError):
        pass
    detail = " ".join(detail.split())[:500]
    suffix = f": {detail}" if detail else ""
    return f"Provider请求失败: HTTP {status_code}{suffix}"


def _provider_text(event: Mapping[str, Any]) -> list[str]:
    event_type = event.get("type")
    if event_type in {"response.error", "error"}:
        error = event.get("error")
        message = error.get("message") if isinstance(error, Mapping) else event.get("message")
        raise ProviderDispatchError(
            str(message or "Provider返回错误"),
            error_code="provider_response_error",
            outcome_status="failed",
        )
    delta = event.get("delta")
    if event_type == "response.output_text.delta" and isinstance(delta, str):
        return [delta]
    if isinstance(delta, str) and event_type is None:
        return [delta]
    output_text = event.get("output_text")
    if isinstance(output_text, str):
        return [output_text]
    choices = event.get("choices")
    if isinstance(choices, list) and choices and isinstance(choices[0], Mapping):
        choice_delta = choices[0].get("delta")
        if isinstance(choice_delta, Mapping) and isinstance(choice_delta.get("content"), str):
            return [str(choice_delta["content"])]
    output = event.get("output")
    texts: list[str] = []
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, Mapping) or not isinstance(item.get("content"), list):
                continue
            for content in item["content"]:
                if isinstance(content, Mapping) and isinstance(content.get("text"), str):
                    texts.append(str(content["text"]))
    return texts


def _redacted_provider_error(error: Exception) -> str:
    if isinstance(error, httpx.HTTPStatusError):
        return f"Provider请求失败: HTTP {error.response.status_code}"
    if isinstance(error, httpx.TimeoutException):
        return "Provider请求超时"
    if isinstance(error, json.JSONDecodeError):
        return "Provider返回了无法解析的JSON或SSE事件"
    return f"Provider连接失败: {type(error).__name__}"


def responses_endpoint(base_url: str | None) -> str:
    root = (base_url or "https://api.openai.com/v1").rstrip("/")
    return root if root.endswith("/responses") else f"{root}/responses"


def provider_endpoint(base_url: str | None, protocol: str) -> str:
    root = (base_url or "https://api.openai.com/v1").rstrip("/")
    if protocol == "openai_chat_completions":
        return root if root.endswith("/chat/completions") else f"{root}/chat/completions"
    return responses_endpoint(root)
