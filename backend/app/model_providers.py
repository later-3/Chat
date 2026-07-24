"""Server-owned model provider catalog and safe public capability projection."""

from __future__ import annotations

import copy
import re
from dataclasses import dataclass
from typing import Any

_PROVIDER_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]*$")


class ModelProviderCatalogError(ValueError):
    """Provider/model configuration or selection is invalid."""

    code = "MODEL_PROVIDER_SELECTION_INVALID"


@dataclass(frozen=True, slots=True)
class ParameterCapability:
    """One editable provider-body parameter and its validation contract."""

    key: str
    label: str
    value_type: str
    default: Any
    choices: tuple[str, ...] = ()
    minimum: float | None = None
    maximum: float | None = None
    child_key: str | None = None
    locked_value: Any = None
    locked: bool = False

    def public_view(self) -> dict[str, object]:
        return {
            "key": self.key,
            "label": self.label,
            "value_type": self.value_type,
            "default": copy.deepcopy(self.default),
            "choices": list(self.choices),
            "minimum": self.minimum,
            "maximum": self.maximum,
            "child_key": self.child_key,
            "locked": self.locked,
        }


@dataclass(frozen=True, slots=True)
class ModelCapabilities:
    """Provider/model-specific request surface exposed to review and validation."""

    roles: tuple[str, ...]
    content_types_by_role: tuple[tuple[str, tuple[str, ...]], ...]
    parameters: tuple[ParameterCapability, ...]
    token_estimator: str = "unicode_heuristic_v1"
    allow_unknown_parameters: bool = False

    def content_types(self, role: str) -> tuple[str, ...]:
        return next((types for item_role, types in self.content_types_by_role if item_role == role), ())

    def parameter(self, key: str) -> ParameterCapability | None:
        return next((item for item in self.parameters if item.key == key), None)

    def public_view(self) -> dict[str, object]:
        return {
            "roles": list(self.roles),
            "content_types_by_role": {
                role: list(content_types) for role, content_types in self.content_types_by_role
            },
            "parameters": [parameter.public_view() for parameter in self.parameters],
            "token_estimator": self.token_estimator,
            "allow_unknown_parameters": self.allow_unknown_parameters,
        }


DEFAULT_MODEL_CAPABILITIES = ModelCapabilities(
    roles=("user", "assistant", "developer", "system"),
    content_types_by_role=(
        ("user", ("input_text",)),
        ("assistant", ("output_text",)),
        ("developer", ("input_text",)),
        ("system", ("input_text",)),
    ),
    parameters=(
        ParameterCapability(
            key="store",
            label="Provider保存响应",
            value_type="boolean",
            default=False,
            locked_value=False,
            locked=True,
        ),
        ParameterCapability(
            key="stream",
            label="流式返回",
            value_type="boolean",
            default=True,
        ),
    ),
)

CHAT_COMPLETIONS_MODEL_CAPABILITIES = ModelCapabilities(
    roles=("user", "assistant", "developer", "system"),
    content_types_by_role=(
        ("user", ("text", "image_url")),
        ("assistant", ("text",)),
        ("developer", ("text",)),
        ("system", ("text",)),
    ),
    parameters=DEFAULT_MODEL_CAPABILITIES.parameters,
)


@dataclass(frozen=True, slots=True)
class ModelOption:
    id: str
    label: str
    capabilities: ModelCapabilities = DEFAULT_MODEL_CAPABILITIES


@dataclass(frozen=True, slots=True)
class ModelProviderConfig:
    """Runtime provider configuration; secrets never enter ``public_view``."""

    id: str
    label: str
    models: tuple[ModelOption, ...]
    base_url: str | None
    api_key: str | None
    protocol: str = "openai_responses"
    requires_api_key: bool = True
    enabled: bool = True

    @property
    def configured(self) -> bool:
        return self.enabled and bool(self.models) and (bool(self.api_key) or not self.requires_api_key)

    def public_view(self) -> dict[str, object]:
        return {
            "id": self.id,
            "label": self.label,
            "protocol": self.protocol,
            "models": [
                {
                    "id": model.id,
                    "label": model.label,
                    "capabilities": model.capabilities.public_view(),
                }
                for model in self.models
            ],
        }


@dataclass(frozen=True, slots=True)
class ModelProviderCatalog:
    """Immutable startup snapshot used for selection, validation and routing."""

    providers: tuple[ModelProviderConfig, ...]
    default_provider_id: str
    default_model: str

    def __post_init__(self) -> None:
        if not self.providers:
            raise ModelProviderCatalogError("至少需要一个已配置的模型Provider")
        provider_ids: set[str] = set()
        for provider in self.providers:
            if not _PROVIDER_ID.fullmatch(provider.id):
                raise ModelProviderCatalogError(f"Provider ID格式无效: {provider.id}")
            if provider.id in provider_ids:
                raise ModelProviderCatalogError(f"Provider ID重复: {provider.id}")
            provider_ids.add(provider.id)
            if provider.protocol not in {"openai_responses", "openai_chat_completions"}:
                raise ModelProviderCatalogError(
                    f"Provider {provider.id}使用了尚未支持的协议: {provider.protocol}"
                )
            model_ids = [model.id for model in provider.models]
            if not model_ids or any(not model_id.strip() for model_id in model_ids):
                raise ModelProviderCatalogError(f"Provider {provider.id}必须配置至少一个有效模型")
            if len(model_ids) != len(set(model_ids)):
                raise ModelProviderCatalogError(f"Provider {provider.id}存在重复模型")
        default_provider = self.get(self.default_provider_id)
        if default_provider is None:
            raise ModelProviderCatalogError(f"默认Provider不存在: {self.default_provider_id}")
        if self.default_model not in {item.id for item in default_provider.models}:
            raise ModelProviderCatalogError(
                f"模型{self.default_model}不属于Provider {self.default_provider_id}的可选目录"
            )

    def get(self, provider_id: str) -> ModelProviderConfig | None:
        return next((provider for provider in self.providers if provider.id == provider_id), None)

    def require_selection(self, provider_id: str, model: str) -> ModelProviderConfig:
        provider = self.get(provider_id)
        if provider is None:
            raise ModelProviderCatalogError(f"未知Provider: {provider_id}")
        if not provider.configured:
            raise ModelProviderCatalogError(f"Provider未完成运行配置: {provider_id}")
        if model not in {item.id for item in provider.models}:
            raise ModelProviderCatalogError(f"模型{model}不属于Provider {provider_id}的可选目录")
        return provider

    def require_model(self, provider_id: str, model: str) -> ModelOption:
        provider = self.require_selection(provider_id, model)
        return next(item for item in provider.models if item.id == model)

    def public_view(self) -> list[dict[str, object]]:
        return [provider.public_view() for provider in self.providers if provider.configured]
