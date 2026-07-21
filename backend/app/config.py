"""Load the backend's secret-bearing JSON configuration without exposing it."""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .model_providers import (
    CHAT_COMPLETIONS_MODEL_CAPABILITIES,
    DEFAULT_MODEL_CAPABILITIES,
    ModelCapabilities,
    ModelOption,
    ParameterCapability,
    ModelProviderCatalog,
    ModelProviderCatalogError,
    ModelProviderConfig,
)


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "backend"
DEFAULT_CONFIG_PATH = BACKEND_ROOT / "config.json"


class SettingsError(ValueError):
    """The backend JSON configuration is missing required structure or values."""


def _record(value: object, *, field: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SettingsError(f"{field}必须是JSON对象")
    return value


def _origins(value: object) -> tuple[str, ...]:
    defaults = ("http://127.0.0.1:5073", "http://localhost:5073")
    if value is None:
        return defaults
    if isinstance(value, str):
        parsed = tuple(item.strip() for item in value.split(",") if item.strip())
        return parsed or defaults
    if isinstance(value, list):
        parsed = tuple(str(item).strip() for item in value if str(item).strip())
        return parsed or defaults
    raise SettingsError("server.frontend_origins必须是字符串数组")


def _boolean(value: object, *, field: str, default: bool) -> bool:
    if value is None:
        return default
    if not isinstance(value, bool):
        raise SettingsError(f"{field}必须是JSON布尔值")
    return value


def _string_tuple(value: object, *, field: str, fallback: tuple[str, ...]) -> tuple[str, ...]:
    if value is None:
        return fallback
    if not isinstance(value, list) or not all(isinstance(item, str) and item.strip() for item in value):
        raise ModelProviderCatalogError(f"{field}必须是非空字符串数组")
    return tuple(item.strip() for item in value)


def _parameter_capabilities(
    value: object,
    *,
    field: str,
    fallback: tuple[ParameterCapability, ...],
) -> tuple[ParameterCapability, ...]:
    if value is None:
        return fallback
    if not isinstance(value, list):
        raise ModelProviderCatalogError(f"{field}必须是参数对象数组")
    declared: list[ParameterCapability] = []
    for index, raw_value in enumerate(value):
        raw = _record(raw_value, field=f"{field}[{index}]")
        key = str(raw.get("key") or "").strip()
        value_type = str(raw.get("value_type") or "").strip()
        if not key or value_type not in {"boolean", "integer", "number", "enum", "object_enum"}:
            raise ModelProviderCatalogError(
                f"{field}[{index}]必须提供key和有效value_type"
            )
        choices = _string_tuple(
            raw.get("choices"),
            field=f"{field}[{index}].choices",
            fallback=(),
        )
        if value_type in {"enum", "object_enum"} and not choices:
            raise ModelProviderCatalogError(f"{field}[{index}]枚举参数必须提供choices")
        child_key = str(raw.get("child_key") or "").strip() or None
        if value_type == "object_enum" and child_key is None:
            raise ModelProviderCatalogError(f"{field}[{index}]对象枚举必须提供child_key")
        default = copy.deepcopy(raw.get("default"))
        locked = _boolean(raw.get("locked"), field=f"{field}[{index}].locked", default=False)
        declared.append(
            ParameterCapability(
                key=key,
                label=str(raw.get("label") or key).strip(),
                value_type=value_type,
                default=default,
                choices=choices,
                minimum=float(raw["minimum"]) if raw.get("minimum") is not None else None,
                maximum=float(raw["maximum"]) if raw.get("maximum") is not None else None,
                child_key=child_key,
                locked_value=copy.deepcopy(raw.get("locked_value")),
                locked=locked,
            )
        )
    keys = [item.key for item in declared]
    if len(keys) != len(set(keys)):
        raise ModelProviderCatalogError(f"{field}存在重复参数key")
    parameters = {item.key: item for item in fallback}
    parameters.update({item.key: item for item in declared})
    return tuple(parameters.values())


def _model_capabilities(
    value: object,
    *,
    field: str,
    fallback: ModelCapabilities = DEFAULT_MODEL_CAPABILITIES,
) -> ModelCapabilities:
    if value is None:
        return fallback
    raw = _record(value, field=field)
    roles = _string_tuple(raw.get("roles"), field=f"{field}.roles", fallback=fallback.roles)
    raw_content_types = raw.get("content_types_by_role")
    if raw_content_types is None:
        content_map = {role: tuple(types) for role, types in fallback.content_types_by_role}
        if raw.get("image_input") is True and "user" in roles:
            image_type = "image_url" if "text" in content_map.get("user", ()) else "input_image"
            content_map["user"] = tuple(
                dict.fromkeys((*content_map.get("user", ()), image_type))
            )
        content_types = tuple((role, content_map.get(role, ())) for role in roles)
    else:
        content_record = _record(raw_content_types, field=f"{field}.content_types_by_role")
        content_types = tuple(
            (
                role,
                _string_tuple(
                    content_record.get(role),
                    field=f"{field}.content_types_by_role.{role}",
                    fallback=(),
                ),
            )
            for role in roles
        )
    return ModelCapabilities(
        roles=roles,
        content_types_by_role=content_types,
        parameters=_parameter_capabilities(
            raw.get("parameters"),
            field=f"{field}.parameters",
            fallback=fallback.parameters,
        ),
        token_estimator=str(raw.get("token_estimator") or fallback.token_estimator).strip(),
        allow_unknown_parameters=_boolean(
            raw.get("allow_unknown_parameters"),
            field=f"{field}.allow_unknown_parameters",
            default=fallback.allow_unknown_parameters,
        ),
    )


def _model_options(
    value: object,
    *,
    fallback: str,
    provider_capabilities: ModelCapabilities,
) -> tuple[ModelOption, ...]:
    if value is None:
        raw_items: list[object] = [fallback] if fallback else []
    elif isinstance(value, list):
        raw_items = value
    else:
        raise ModelProviderCatalogError("Provider models必须是字符串或{id,label}对象组成的数组")

    options: list[ModelOption] = []
    for item in raw_items:
        if isinstance(item, str):
            model_id = item.strip()
            label = model_id
            capabilities = provider_capabilities
        elif isinstance(item, dict):
            model_id = str(item.get("id") or "").strip()
            label = str(item.get("label") or model_id).strip()
            capabilities = _model_capabilities(
                item.get("capabilities"),
                field=f"models[{len(options)}].capabilities",
                fallback=provider_capabilities,
            )
        else:
            raise ModelProviderCatalogError("模型目录项必须是字符串或{id,label}对象")
        if model_id:
            options.append(
                ModelOption(id=model_id, label=label or model_id, capabilities=capabilities)
            )
    return tuple(options)


def _provider_catalog(payload: dict[str, Any]) -> ModelProviderCatalog | None:
    raw_providers = payload.get("providers", [])
    if not isinstance(raw_providers, list):
        raise SettingsError("providers必须是JSON数组")
    if not raw_providers:
        return None

    providers: list[ModelProviderConfig] = []
    configured_defaults: dict[str, str] = {}
    for index, raw_value in enumerate(raw_providers):
        raw_provider = _record(raw_value, field=f"providers[{index}]")
        provider_id = str(raw_provider.get("id") or "").strip()
        default_model = str(raw_provider.get("default_model") or "").strip()
        protocol = str(raw_provider.get("protocol") or "openai_responses").strip()
        default_capabilities = (
            CHAT_COMPLETIONS_MODEL_CAPABILITIES
            if protocol == "openai_chat_completions"
            else DEFAULT_MODEL_CAPABILITIES
        )
        provider_capabilities = _model_capabilities(
            raw_provider.get("capabilities"),
            field=f"providers[{index}].capabilities",
            fallback=default_capabilities,
        )
        configured_defaults[provider_id] = default_model
        providers.append(
            ModelProviderConfig(
                id=provider_id,
                label=str(raw_provider.get("label") or provider_id).strip(),
                models=_model_options(
                    raw_provider.get("models"),
                    fallback=default_model,
                    provider_capabilities=provider_capabilities,
                ),
                base_url=str(raw_provider.get("base_url") or "").strip() or None,
                api_key=str(raw_provider.get("api_key") or "").strip() or None,
                protocol=protocol,
                requires_api_key=_boolean(
                    raw_provider.get("requires_api_key"),
                    field=f"providers[{index}].requires_api_key",
                    default=True,
                ),
                enabled=_boolean(
                    raw_provider.get("enabled"),
                    field=f"providers[{index}].enabled",
                    default=True,
                ),
            )
        )

    default_provider_id = str(payload.get("default_provider_id") or providers[0].id).strip()
    default_provider = next((provider for provider in providers if provider.id == default_provider_id), None)
    if default_provider is None:
        raise ModelProviderCatalogError(f"默认Provider不存在: {default_provider_id}")
    default_model = configured_defaults.get(default_provider_id, "") or (
        default_provider.models[0].id if default_provider.models else ""
    )

    # Validate every declared ID/model first, including disabled providers. Only
    # fully configured providers become runtime routes or leave the backend.
    ModelProviderCatalog(
        providers=tuple(providers),
        default_provider_id=default_provider_id,
        default_model=default_model,
    )
    configured_providers = tuple(provider for provider in providers if provider.configured)
    if not configured_providers:
        return None
    if not default_provider.configured:
        raise ModelProviderCatalogError(f"默认Provider未完成运行配置: {default_provider_id}")
    return ModelProviderCatalog(
        providers=configured_providers,
        default_provider_id=default_provider_id,
        default_model=default_model,
    )


def _load_payload(path: Path) -> dict[str, Any]:
    try:
        value: Any = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise SettingsError(f"后端配置文件不存在: {path}") from error
    except json.JSONDecodeError as error:
        raise SettingsError(f"后端配置文件不是有效JSON: 第{error.lineno}行第{error.colno}列") from error
    return _record(value, field="配置根节点")


@dataclass(frozen=True, slots=True)
class Settings:
    """A startup-time configuration snapshot shared by app and agent factories."""

    host: str
    port: int
    frontend_origins: tuple[str, ...]
    model: str
    model_api_key: str | None
    model_base_url: str | None
    model_providers: tuple[ModelProviderConfig, ...] = ()
    default_model_provider: str | None = None

    @property
    def runtime_mode(self) -> str:
        return "model" if self.model_catalog() is not None else "bootstrap"

    def model_catalog(self) -> ModelProviderCatalog | None:
        if self.model_providers:
            provider_id = self.default_model_provider or self.model_providers[0].id
            return ModelProviderCatalog(
                providers=self.model_providers,
                default_provider_id=provider_id,
                default_model=self.model,
            )
        if not self.model_api_key:
            return None
        provider_id = self.default_model_provider or "configured"
        provider = ModelProviderConfig(
            id=provider_id,
            label="Configured Provider",
            models=(ModelOption(id=self.model, label=self.model),),
            base_url=self.model_base_url,
            api_key=self.model_api_key,
        )
        return ModelProviderCatalog(
            providers=(provider,),
            default_provider_id=provider_id,
            default_model=self.model,
        )

    @classmethod
    def from_file(cls, path: Path | None = None) -> "Settings":
        """Load the sole backend configuration source from JSON."""

        payload = _load_payload(path or DEFAULT_CONFIG_PATH)
        version = payload.get("version", 1)
        if version != 1:
            raise SettingsError(f"不支持的配置版本: {version!r}")
        server = _record(payload.get("server", {}), field="server")
        catalog = _provider_catalog(payload)
        if catalog is None:
            model = "bootstrap/no-model"
            api_key = None
            base_url = None
            providers: tuple[ModelProviderConfig, ...] = ()
            default_provider_id = None
        else:
            selected = catalog.require_selection(catalog.default_provider_id, catalog.default_model)
            model = catalog.default_model
            api_key = selected.api_key
            base_url = selected.base_url
            providers = catalog.providers
            default_provider_id = catalog.default_provider_id
        try:
            port = int(server.get("port", 8030))
        except (TypeError, ValueError) as error:
            raise SettingsError("server.port必须是整数") from error
        return cls(
            host=str(server.get("host") or "127.0.0.1"),
            port=port,
            frontend_origins=_origins(server.get("frontend_origins")),
            model=model,
            model_api_key=api_key,
            model_base_url=base_url,
            model_providers=providers,
            default_model_provider=default_provider_id,
        )

    @classmethod
    def for_test(cls) -> "Settings":
        return cls(
            host="127.0.0.1",
            port=8030,
            frontend_origins=("http://testserver",),
            model="test/bootstrap",
            model_api_key=None,
            model_base_url=None,
        )
