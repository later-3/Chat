"""Load the backend's secret-bearing JSON configuration without exposing it."""

from __future__ import annotations

import copy
import hashlib
import json
import logging
import os
import re
import sys
import warnings
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .model_providers import (
    CHAT_COMPLETIONS_MODEL_CAPABILITIES,
    DEFAULT_MODEL_CAPABILITIES,
    ModelCapabilities,
    ModelOption,
    ModelProviderCatalog,
    ModelProviderCatalogError,
    ModelProviderConfig,
    ParameterCapability,
)

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "backend"
DEFAULT_CONFIG_PATH = BACKEND_ROOT / "config.json"
DEFAULT_DATABASE_URL = f"sqlite+aiosqlite:///{(BACKEND_ROOT / '.data' / 'chat.db').as_posix()}"
DEFAULT_EXECUTION_WORKSPACE_ROOT = BACKEND_ROOT / ".data" / "execution-workspaces"
DEFAULT_ARTIFACT_STORE_ROOT = BACKEND_ROOT / ".data" / "artifacts"
DEFAULT_PI_SESSION_DIRECTORY = Path.home() / ".pi" / "agent" / "chat-sessions"
logger = logging.getLogger(__name__)


class SettingsError(ValueError):
    """The backend JSON configuration is missing required structure or values."""

    code = "SETTINGS_INVALID"


@dataclass(frozen=True, slots=True)
class ObservabilitySettings:
    """Safe process logging and telemetry destinations."""

    log_level: str = "INFO"
    log_format: str = "console"
    log_file: Path | None = None
    log_max_bytes: int = 10 * 1024 * 1024
    log_backup_count: int = 5


@dataclass(frozen=True, slots=True)
class ArtifactStoreSettings:
    """Private filesystem root and irreversible scope-key material."""

    root: Path = DEFAULT_ARTIFACT_STORE_ROOT
    scope_key_secret: bytes | None = None
    orphan_grace_seconds: int = 24 * 60 * 60

    @property
    def available(self) -> bool:
        return self.scope_key_secret is not None and len(self.scope_key_secret) >= 32

    def health_view(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "storage": "content_addressed_filesystem",
            "scope_isolation": "hmac_sha256_128bit" if self.available else "not_configured",
            "orphan_grace_seconds": self.orphan_grace_seconds,
        }


@dataclass(frozen=True, slots=True)
class ValidationRuntimeSettings:
    """Pinned project virtual-environment runtime; never falls back to PATH."""

    project_python: Path = PROJECT_ROOT / ".venv" / "bin" / "python"

    @property
    def sandbox_requirement(self) -> str:
        if sys.platform == "darwin":
            return "seatbelt"
        if sys.platform.startswith("linux"):
            return "bwrap"
        return "unavailable"

    @property
    def sandbox_available(self) -> bool:
        executable = {
            "seatbelt": Path("/usr/bin/sandbox-exec"),
            "bwrap": Path("/usr/bin/bwrap"),
        }.get(self.sandbox_requirement)
        return executable is not None and executable.is_file() and os.access(executable, os.X_OK)

    @property
    def available(self) -> bool:
        return self.project_python.is_file() and self.sandbox_available

    def health_view(self) -> dict[str, Any]:
        return {
            "available": self.available,
            "python_source": "project_virtual_environment",
            "system_python_fallback": False,
            "network_policy": "deny",
            "sandbox_requirement": self.sandbox_requirement,
            "sandbox_available": self.sandbox_available,
        }


@dataclass(frozen=True, slots=True)
class PiRuntimeSettings:
    """Startup-owned safety boundary for the external pi coding runtime."""

    enabled: bool = False
    contract_version: str = "0.82.1"
    node_path: Path | None = None
    cli_path: Path | None = None
    source_root: Path | None = None
    session_directory: Path = DEFAULT_PI_SESSION_DIRECTORY
    node_debug_port: int | None = None
    node_debug_break: bool = False
    allowed_working_roots: tuple[Path, ...] = ()
    default_working_directory: Path = PROJECT_ROOT
    gateway_origin: str = "http://127.0.0.1:8030"

    @property
    def available(self) -> bool:
        return bool(
            self.enabled
            and self.node_path is not None
            and self.node_path.is_file()
            and self.cli_path is not None
            and self.cli_path.is_file()
            and self.allowed_working_roots
        )

    def public_view(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "available": self.available,
            "contract_version": self.contract_version,
            "runtime_source": "source_build" if self.source_root is not None else "installed_package",
            "integration_mode": "jsonl_rpc_subprocess",
            "session_retention": "dedicated_per_tool_execution",
            "session_auto_resume": False,
            "debugger_enabled": self.node_debug_port is not None,
            "provider_gate": "every_pi_model_call",
            "tool_gate": "every_pi_internal_tool_call",
            "allowed_working_roots": [str(path) for path in self.allowed_working_roots],
            "default_working_directory": str(self.default_working_directory),
        }

    def health_view(self) -> dict[str, Any]:
        """Return runtime readiness without exposing host filesystem paths."""

        return {
            "enabled": self.enabled,
            "available": self.available,
            "contract_version": self.contract_version,
            "runtime_source": "source_build" if self.source_root is not None else "installed_package",
            "integration_mode": "jsonl_rpc_subprocess",
            "session_retention": "dedicated_per_tool_execution",
            "session_auto_resume": False,
            "debugger_enabled": self.node_debug_port is not None,
            "provider_gate": "every_pi_model_call",
            "tool_gate": "every_pi_internal_tool_call",
            "allowed_working_root_count": len(self.allowed_working_roots),
            "default_working_directory_configured": bool(self.default_working_directory),
        }


WORKSPACE_ROOT_KEY_PATTERN = re.compile(r"^[a-z][a-z0-9-]{0,63}$")


@dataclass(frozen=True, slots=True)
class WorkspaceRootSettings:
    """Private startup declaration for one user-selectable filesystem root.

    ``path`` is intentionally absent from every public projection. The
    project-resources adapter resolves and validates it, while product records
    retain only the stable key and an identity hash.
    """

    key: str
    label: str
    path: Path
    source: str = "configured"


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


def _observability(payload: dict[str, Any]) -> ObservabilitySettings:
    raw = _record(payload.get("observability", {}), field="observability")
    log_level = str(raw.get("log_level") or "INFO").strip().upper()
    if log_level not in {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}:
        raise SettingsError("observability.log_level必须是有效日志级别")
    log_format = str(raw.get("log_format") or "console").strip().lower()
    if log_format not in {"console", "json"}:
        raise SettingsError("observability.log_format必须是console或json")
    # Runtime configuration always receives a durable log destination. Tests
    # can still opt out explicitly by constructing ObservabilitySettings with
    # ``log_file=None`` instead of loading the production JSON configuration.
    raw_log_file = raw.get("log_file") or "backend/.data/logs/chat.jsonl"
    log_file = Path(str(raw_log_file)).expanduser()
    if not log_file.is_absolute():
        log_file = PROJECT_ROOT / log_file
    log_file = log_file.resolve()
    try:
        log_max_bytes = int(raw.get("log_max_bytes", 10 * 1024 * 1024))
        log_backup_count = int(raw.get("log_backup_count", 5))
    except (TypeError, ValueError) as error:
        raise SettingsError("observability日志轮转参数必须是整数") from error
    if log_max_bytes < 64 * 1024:
        raise SettingsError("observability.log_max_bytes不能小于65536")
    if not 1 <= log_backup_count <= 20:
        raise SettingsError("observability.log_backup_count必须在1到20之间")
    return ObservabilitySettings(
        log_level=log_level,
        log_format=log_format,
        log_file=log_file,
        log_max_bytes=log_max_bytes,
        log_backup_count=log_backup_count,
    )


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
            raise ModelProviderCatalogError(f"{field}[{index}]必须提供key和有效value_type")
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
            content_map["user"] = tuple(dict.fromkeys((*content_map.get("user", ()), image_type)))
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
            context_window = 128_000
            reasoning = True
            thinking_level_map: tuple[tuple[str, str | None], ...] = ()
        elif isinstance(item, dict):
            model_id = str(item.get("id") or "").strip()
            label = str(item.get("label") or model_id).strip()
            capabilities = _model_capabilities(
                item.get("capabilities"),
                field=f"models[{len(options)}].capabilities",
                fallback=provider_capabilities,
            )
            raw_context_window = item.get("context_window", 128_000)
            if isinstance(raw_context_window, bool) or not isinstance(raw_context_window, int):
                raise ModelProviderCatalogError(f"models[{len(options)}].context_window必须是正整数")
            if raw_context_window <= 0:
                raise ModelProviderCatalogError(f"models[{len(options)}].context_window必须是正整数")
            context_window = raw_context_window
            reasoning = _boolean(
                item.get("reasoning"),
                field=f"models[{len(options)}].reasoning",
                default=True,
            )
            raw_thinking_map = item.get("thinking_level_map", {})
            if not isinstance(raw_thinking_map, dict):
                raise ModelProviderCatalogError(f"models[{len(options)}].thinking_level_map必须是JSON对象")
            supported_levels = {"off", "minimal", "low", "medium", "high", "xhigh"}
            unknown_levels = set(raw_thinking_map) - supported_levels
            if unknown_levels:
                raise ModelProviderCatalogError(f"models[{len(options)}].thinking_level_map包含未知等级")
            thinking_items: list[tuple[str, str | None]] = []
            for level, mapped in raw_thinking_map.items():
                if mapped is not None and (not isinstance(mapped, str) or not mapped.strip()):
                    raise ModelProviderCatalogError(
                        f"models[{len(options)}].thinking_level_map.{level}必须是字符串或null"
                    )
                thinking_items.append((level, mapped.strip() if isinstance(mapped, str) else None))
            thinking_level_map = tuple(thinking_items)
        else:
            raise ModelProviderCatalogError("模型目录项必须是字符串或{id,label}对象")
        if model_id:
            options.append(
                ModelOption(
                    id=model_id,
                    label=label or model_id,
                    capabilities=capabilities,
                    context_window=context_window,
                    reasoning=reasoning,
                    thinking_level_map=thinking_level_map,
                )
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


def _pi_runtime(payload: dict[str, Any], *, host: str, port: int) -> PiRuntimeSettings:
    raw = _record(payload.get("pi_agent", {}), field="pi_agent")
    enabled = _boolean(raw.get("enabled"), field="pi_agent.enabled", default=False)
    contract_version = str(raw.get("contract_version") or "0.82.1").strip()
    if not contract_version or len(contract_version) > 32:
        raise SettingsError("pi_agent.contract_version必须是1到32字符的版本标识")

    def optional_path(key: str) -> Path | None:
        value = str(raw.get(key) or "").strip()
        return Path(value).expanduser().resolve() if value else None

    node_path = optional_path("node_path")
    cli_path = optional_path("cli_path")
    source_root = optional_path("source_root")
    session_value = str(raw.get("session_directory") or DEFAULT_PI_SESSION_DIRECTORY).strip()
    session_directory = Path(session_value).expanduser().resolve()
    raw_debug_port = raw.get("node_debug_port")
    try:
        node_debug_port = int(raw_debug_port) if raw_debug_port is not None else None
    except (TypeError, ValueError) as error:
        raise SettingsError("pi_agent.node_debug_port必须是整数") from error
    if node_debug_port is not None and not 1 <= node_debug_port <= 65535:
        raise SettingsError("pi_agent.node_debug_port必须在1到65535之间")
    node_debug_break = _boolean(
        raw.get("node_debug_break"),
        field="pi_agent.node_debug_break",
        default=False,
    )
    if node_debug_break and node_debug_port is None:
        raise SettingsError("pi_agent.node_debug_break需要同时配置node_debug_port")
    if source_root is not None:
        if cli_path is None or (cli_path != source_root and not cli_path.is_relative_to(source_root)):
            raise SettingsError("pi_agent.cli_path必须位于source_root内")
        package_json = source_root / "packages" / "coding-agent" / "package.json"
        try:
            package_version = str(json.loads(package_json.read_text(encoding="utf-8"))["version"])
        except (OSError, KeyError, TypeError, json.JSONDecodeError) as error:
            raise SettingsError("pi_agent.source_root不是可识别的pi源码目录") from error
        if package_version != contract_version:
            raise SettingsError("pi_agent.contract_version与本地pi源码版本不一致")

    raw_roots = raw.get("allowed_working_roots", [])
    if not isinstance(raw_roots, list) or not all(
        isinstance(value, str) and value.strip() for value in raw_roots
    ):
        raise SettingsError("pi_agent.allowed_working_roots必须是非空路径字符串数组")
    roots = tuple(Path(value).expanduser().resolve() for value in raw_roots)
    default_value = str(raw.get("default_working_directory") or PROJECT_ROOT).strip()
    default_working_directory = Path(default_value).expanduser().resolve()
    if enabled and not roots:
        raise SettingsError("启用pi_agent时必须配置allowed_working_roots")
    if roots and not any(
        default_working_directory == root or default_working_directory.is_relative_to(root) for root in roots
    ):
        raise SettingsError("pi_agent.default_working_directory不在允许的工作目录内")
    gateway_host = "127.0.0.1" if host in {"0.0.0.0", "::"} else host
    gateway_origin = str(raw.get("gateway_origin") or f"http://{gateway_host}:{port}").rstrip("/")
    if enabled and not gateway_origin.startswith(("http://127.0.0.1", "http://localhost", "http://[::1]")):
        raise SettingsError("pi_agent.gateway_origin必须是本机HTTP地址")
    return PiRuntimeSettings(
        enabled=enabled,
        contract_version=contract_version,
        node_path=node_path,
        cli_path=cli_path,
        source_root=source_root,
        session_directory=session_directory,
        node_debug_port=node_debug_port,
        node_debug_break=node_debug_break,
        allowed_working_roots=roots,
        default_working_directory=default_working_directory,
        gateway_origin=gateway_origin,
    )


def _workspace_roots(
    payload: dict[str, Any],
    *,
    pi_runtime: PiRuntimeSettings,
) -> tuple[WorkspaceRootSettings, ...]:
    """Parse the common Root Catalog without changing the legacy pi contract."""

    if "workspace_roots" not in payload:
        if not pi_runtime.allowed_working_roots:
            return ()
        warnings.warn(
            "workspace_roots未配置；本次启动只读提升pi_agent.allowed_working_roots，"
            "请迁移到公共Workspace Root Catalog",
            DeprecationWarning,
            stacklevel=2,
        )
        logger.warning(
            "workspace_root_catalog_legacy_pi_roots count=%d",
            len(pi_runtime.allowed_working_roots),
        )
        return tuple(
            WorkspaceRootSettings(
                key=f"legacy-{hashlib.sha256(str(path).encode('utf-8')).hexdigest()[:12]}",
                label=f"兼容工作区 {index}",
                path=path,
                source="pi_compatibility",
            )
            for index, path in enumerate(pi_runtime.allowed_working_roots, start=1)
        )

    raw_roots = payload.get("workspace_roots")
    if not isinstance(raw_roots, list):
        raise SettingsError("workspace_roots必须是对象数组")
    roots: list[WorkspaceRootSettings] = []
    seen_keys: set[str] = set()
    for index, raw_value in enumerate(raw_roots):
        raw = _record(raw_value, field=f"workspace_roots[{index}]")
        key = str(raw.get("key") or "").strip()
        label = str(raw.get("label") or "").strip()
        path_value = str(raw.get("path") or "").strip()
        if not WORKSPACE_ROOT_KEY_PATTERN.fullmatch(key):
            raise SettingsError(f"workspace_roots[{index}].key必须匹配[a-z][a-z0-9-]{{0,63}}")
        if key in seen_keys:
            raise SettingsError(f"workspace_roots存在重复key: {key}")
        if not label or len(label) > 120:
            raise SettingsError(f"workspace_roots[{index}].label必须为1到120个字符")
        if not path_value:
            raise SettingsError(f"workspace_roots[{index}].path不能为空")
        path = Path(path_value).expanduser()
        if not path.is_absolute():
            raise SettingsError(f"workspace_roots[{index}].path必须是绝对路径")
        seen_keys.add(key)
        roots.append(
            WorkspaceRootSettings(
                key=key,
                label=label,
                path=path,
            )
        )
    return tuple(roots)


def _execution_workspace_root(payload: dict[str, Any]) -> Path:
    """Resolve the private root used only for Chat-managed execution worktrees."""

    raw = _record(payload.get("execution", {}), field="execution")
    value = str(raw.get("workspace_root") or DEFAULT_EXECUTION_WORKSPACE_ROOT).strip()
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    return path.resolve()


def _artifact_store(payload: dict[str, Any]) -> ArtifactStoreSettings:
    raw = _record(payload.get("artifact_store", {}), field="artifact_store")
    root_value = str(raw.get("root") or DEFAULT_ARTIFACT_STORE_ROOT).strip()
    root = Path(root_value).expanduser()
    if not root.is_absolute():
        root = PROJECT_ROOT / root
    secret_hex = str(raw.get("scope_key_secret_hex") or "").strip()
    secret: bytes | None = None
    if secret_hex:
        if len(secret_hex) < 64 or len(secret_hex) % 2 or not re.fullmatch(r"[0-9a-fA-F]+", secret_hex):
            raise SettingsError("artifact_store.scope_key_secret_hex必须是至少64位的偶数长度十六进制")
        secret = bytes.fromhex(secret_hex)
    try:
        grace = int(raw.get("orphan_grace_seconds", 24 * 60 * 60))
    except (TypeError, ValueError) as error:
        raise SettingsError("artifact_store.orphan_grace_seconds必须是整数") from error
    if not 60 <= grace <= 90 * 24 * 60 * 60:
        raise SettingsError("artifact_store.orphan_grace_seconds必须在60秒到90天之间")
    return ArtifactStoreSettings(
        root=root.resolve(),
        scope_key_secret=secret,
        orphan_grace_seconds=grace,
    )


def _validation_runtime(payload: dict[str, Any]) -> ValidationRuntimeSettings:
    raw = _record(payload.get("validation", {}), field="validation")
    value = str(raw.get("project_python") or (PROJECT_ROOT / ".venv" / "bin" / "python")).strip()
    path = Path(value).expanduser()
    if not path.is_absolute():
        path = PROJECT_ROOT / path
    # Preserve the venv launcher path rather than resolving its symlink into
    # the uv runtime, because pyvenv.cfg controls the approved dependency set.
    return ValidationRuntimeSettings(project_python=path.absolute())


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
    database_url: str = DEFAULT_DATABASE_URL
    pi_runtime: PiRuntimeSettings = PiRuntimeSettings()
    workspace_roots: tuple[WorkspaceRootSettings, ...] = ()
    execution_workspace_root: Path = DEFAULT_EXECUTION_WORKSPACE_ROOT
    artifact_store: ArtifactStoreSettings = ArtifactStoreSettings()
    validation_runtime: ValidationRuntimeSettings = ValidationRuntimeSettings()
    observability: ObservabilitySettings = ObservabilitySettings()

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
        product_store = _record(payload.get("product_store", {}), field="product_store")
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
        host = str(server.get("host") or "127.0.0.1")
        pi_runtime = _pi_runtime(payload, host=host, port=port)
        workspace_roots = _workspace_roots(payload, pi_runtime=pi_runtime)
        return cls(
            host=host,
            port=port,
            frontend_origins=_origins(server.get("frontend_origins")),
            model=model,
            model_api_key=api_key,
            model_base_url=base_url,
            model_providers=providers,
            default_model_provider=default_provider_id,
            database_url=str(product_store.get("url") or DEFAULT_DATABASE_URL),
            pi_runtime=pi_runtime,
            workspace_roots=workspace_roots,
            execution_workspace_root=_execution_workspace_root(payload),
            artifact_store=_artifact_store(payload),
            validation_runtime=_validation_runtime(payload),
            observability=_observability(payload),
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
            database_url="sqlite+aiosqlite:///:memory:",
            pi_runtime=PiRuntimeSettings(),
            workspace_roots=(),
            execution_workspace_root=DEFAULT_EXECUTION_WORKSPACE_ROOT,
            artifact_store=ArtifactStoreSettings(),
            validation_runtime=ValidationRuntimeSettings(),
            observability=ObservabilitySettings(log_level="WARNING", log_file=None),
        )
