"""Deterministic validation capability catalog, compiler and process sandbox.

Validation is a Chat-owned system operation.  Model output may select from an
approved capability, but it cannot provide an executable, arbitrary argv or
environment variables.  This module is intentionally independent from MAF and
pi so a validation result cannot inherit Agent Tool permissions.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
import signal
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Iterable, Mapping, Protocol, Sequence

from sqlalchemy import select

from ..product_sessions.database import ProductDatabase
from .contracts import (
    EvidenceConflict,
    EvidenceValidationError,
    ValidationCapabilityUnavailable,
    content_hash,
)
from .models import ValidationCapabilityRecord
from .service import EvidenceRepository

_ALLOWED_PYTEST_EXTRA_ARGS = frozenset({"-x", "-q", "--tb=short"})
_TARGET_PATTERN = re.compile(r"^[A-Za-z0-9_./-]+(?:::[A-Za-z0-9_\[\].-]+)*$")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_relative(value: str, *, field: str) -> str:
    pure = PurePosixPath(value)
    if (
        not value
        or pure.is_absolute()
        or ".." in pure.parts
        or "\\" in value
        or not _TARGET_PATTERN.fullmatch(value)
    ):
        raise EvidenceValidationError(f"{field}必须是Workspace内安全相对目标")
    return value


@dataclass(frozen=True, slots=True)
class ValidationCapabilityDefinition:
    capability_key: str
    capability_version: str
    executable_policy: str
    executable_ref: str
    renderer_key: str
    argv_prefix: tuple[str, ...]
    params_schema: Mapping[str, Any]
    allowed_paths_policy: str
    side_effect_class: str
    network_policy: str
    egress_allowlist: tuple[str, ...]
    resource_limits: Mapping[str, int]
    sandbox_requirement: str
    redaction_baseline: tuple[str, ...]

    @property
    def capability_hash(self) -> str:
        return content_hash(self.payload())

    def payload(self) -> dict[str, Any]:
        return {
            "capability_key": self.capability_key,
            "capability_version": self.capability_version,
            "executable_policy": self.executable_policy,
            "executable_ref": self.executable_ref,
            "renderer_key": self.renderer_key,
            "argv_prefix": list(self.argv_prefix),
            "params_schema": dict(self.params_schema),
            "allowed_paths_policy": self.allowed_paths_policy,
            "side_effect_class": self.side_effect_class,
            "network_policy": self.network_policy,
            "egress_allowlist": list(self.egress_allowlist),
            "resource_limits": dict(self.resource_limits),
            "sandbox_requirement": self.sandbox_requirement,
            "redaction_baseline": list(self.redaction_baseline),
        }


def default_validation_capabilities(
    *, platform: str | None = None
) -> tuple[ValidationCapabilityDefinition, ...]:
    current = platform or sys.platform
    sandbox = (
        "seatbelt" if current == "darwin" else ("bwrap" if current.startswith("linux") else "unavailable")
    )
    pytest_schema = {
        "type": "object",
        "additionalProperties": False,
        "required": ["targets"],
        "properties": {
            "targets": {
                "type": "array",
                "minItems": 1,
                "items": {"type": "string", "format": "workspace-test-target"},
            },
            "extra_args": {
                "type": "array",
                "items": {"type": "string", "enum": sorted(_ALLOWED_PYTEST_EXTRA_ARGS)},
            },
        },
    }
    return (
        ValidationCapabilityDefinition(
            capability_key="pytest-suite",
            capability_version="1.0.0",
            executable_policy="project_venv_python",
            executable_ref="project-python",
            renderer_key="pytest-targets-v1",
            argv_prefix=("-m", "pytest", "-p", "no:cacheprovider"),
            params_schema=pytest_schema,
            allowed_paths_policy="workspace_only",
            side_effect_class="temp_write",
            network_policy="deny",
            egress_allowlist=(),
            resource_limits={
                "timeout_seconds": 900,
                "output_bytes": 1024 * 1024,
                "cpu_seconds": 900,
                "memory_mb": 2048,
                "processes": 64,
            },
            sandbox_requirement=sandbox,
            redaction_baseline=(
                r"sk-[A-Za-z0-9_-]{12,}",
                r"(?i)(api[_-]?key|token|authorization)\s*[:=]\s*\S+",
            ),
        ),
    )


class ValidationCapabilityCatalog:
    """Code-owned immutable capability definitions with DB drift detection."""

    def __init__(self, definitions: Sequence[ValidationCapabilityDefinition]) -> None:
        keys = [(item.capability_key, item.capability_version) for item in definitions]
        if len(keys) != len(set(keys)):
            raise ValueError("Validation Capability存在重复key/version")
        self._definitions = {key: value for key, value in zip(keys, definitions, strict=True)}

    def require(self, capability_key: str, capability_version: str) -> ValidationCapabilityDefinition:
        try:
            return self._definitions[(capability_key, capability_version)]
        except KeyError as error:
            raise ValidationCapabilityUnavailable("Validation Capability未注册") from error

    async def seed(self, database: ProductDatabase) -> int:
        seeded = 0
        repository = EvidenceRepository(scope_id="system", principal_id="system")
        for definition in self._definitions.values():
            async with database.sessions.begin() as transaction:
                existing = await transaction.scalar(
                    select(ValidationCapabilityRecord).where(
                        ValidationCapabilityRecord.scope_id == "system",
                        ValidationCapabilityRecord.capability_key == definition.capability_key,
                        ValidationCapabilityRecord.capability_version == definition.capability_version,
                    )
                )
                if existing is not None:
                    if existing.capability_hash != definition.capability_hash:
                        raise EvidenceConflict("Validation Capability定义改变但版本未递增")
                    continue
                await repository.create_validation_capability(
                    transaction,
                    capability_key=definition.capability_key,
                    capability_version=definition.capability_version,
                    capability_hash=definition.capability_hash,
                    executable_policy=definition.executable_policy,
                    executable_ref=definition.executable_ref,
                    renderer_key=definition.renderer_key,
                    argv_prefix_json=list(definition.argv_prefix),
                    params_schema_json=dict(definition.params_schema),
                    allowed_paths_policy=definition.allowed_paths_policy,
                    side_effect_class=definition.side_effect_class,
                    network_policy=definition.network_policy,
                    sandbox_requirement=definition.sandbox_requirement,
                    resource_limits_json=dict(definition.resource_limits),
                    egress_allowlist_json=list(definition.egress_allowlist),
                    redaction_baseline_json=list(definition.redaction_baseline),
                    command_id=(
                        f"seed-validation:{definition.capability_key}:"
                        f"{definition.capability_version}:{definition.capability_hash}"
                    ),
                )
                seeded += 1
        return seeded


@dataclass(frozen=True, slots=True)
class CompiledValidation:
    capability_key: str
    capability_version: str
    capability_hash: str
    executable: Path
    resolved_executable_hash: str
    environment_fingerprint: str
    expanded_argv: tuple[str, ...]
    expanded_argv_hash: str
    expected_exit_code: int
    sandbox_requirement: str
    network_policy: str
    side_effect_class: str
    timeout_seconds: int
    output_bytes: int
    redaction_patterns: tuple[str, ...]


class ValidationCompiler:
    """Compile typed params into exact argv; callers cannot supply executables."""

    def __init__(self, *, project_python: Path) -> None:
        # Preserve the virtual-environment launcher. Resolving this symlink
        # before exec would lose pyvenv.cfg/site-packages even though the
        # executable bytes live in uv's separate Python runtime directory.
        self._project_python = project_python.expanduser().absolute()

    def compile(
        self,
        definition: ValidationCapabilityDefinition,
        *,
        params: Mapping[str, Any],
        workspace: Path,
    ) -> CompiledValidation:
        if definition.renderer_key != "pytest-targets-v1":
            raise ValidationCapabilityUnavailable("Validation renderer未注册")
        if definition.executable_policy != "project_venv_python":
            raise ValidationCapabilityUnavailable("Validation executable policy未实现")
        targets, extra_args = self._validate_pytest_params(params)
        executable = self._project_python
        if not executable.is_file() or not os.access(executable, os.X_OK):
            raise ValidationCapabilityUnavailable("项目虚拟环境Python不可用，禁止回退系统Python")
        executable_hash = _sha256_file(executable)
        argv = (*definition.argv_prefix, *targets, *extra_args)
        return CompiledValidation(
            capability_key=definition.capability_key,
            capability_version=definition.capability_version,
            capability_hash=definition.capability_hash,
            executable=executable,
            resolved_executable_hash=executable_hash,
            environment_fingerprint=self._environment_fingerprint(
                workspace,
                executable_hash=executable_hash,
            ),
            expanded_argv=argv,
            expanded_argv_hash=content_hash(list(argv)),
            expected_exit_code=0,
            sandbox_requirement=definition.sandbox_requirement,
            network_policy=definition.network_policy,
            side_effect_class=definition.side_effect_class,
            timeout_seconds=int(definition.resource_limits["timeout_seconds"]),
            output_bytes=int(definition.resource_limits["output_bytes"]),
            redaction_patterns=definition.redaction_baseline,
        )

    @staticmethod
    def _validate_pytest_params(params: Mapping[str, Any]) -> tuple[tuple[str, ...], tuple[str, ...]]:
        unknown = set(params) - {"targets", "extra_args"}
        if unknown:
            raise EvidenceValidationError("Validation参数包含schema之外字段")
        raw_targets = params.get("targets")
        if not isinstance(raw_targets, list) or not raw_targets:
            raise EvidenceValidationError("Validation targets必须是非空数组")
        if not all(isinstance(value, str) for value in raw_targets):
            raise EvidenceValidationError("Validation targets必须是字符串数组")
        targets = tuple(
            _safe_relative(value, field=f"targets[{index}]") for index, value in enumerate(raw_targets)
        )
        raw_extra = params.get("extra_args", [])
        if not isinstance(raw_extra, list) or not all(isinstance(value, str) for value in raw_extra):
            raise EvidenceValidationError("Validation extra_args必须是字符串数组")
        if any(value not in _ALLOWED_PYTEST_EXTRA_ARGS for value in raw_extra):
            raise EvidenceValidationError("Validation extra_args包含未允许参数")
        return targets, tuple(raw_extra)

    @staticmethod
    def _environment_fingerprint(workspace: Path, *, executable_hash: str) -> str:
        lock_hashes: dict[str, str] = {}
        for name in ("pyproject.toml", "uv.lock"):
            path = workspace / name
            if path.is_file():
                lock_hashes[name] = _sha256_file(path)
        return content_hash(
            {
                "executable_hash": executable_hash,
                "locks": lock_hashes,
                "fingerprint_version": "validation-env-v1",
            }
        )


class ValidationSandbox(Protocol):
    requirement: str

    @property
    def available(self) -> bool: ...

    def wrap(
        self,
        command: Sequence[str],
        *,
        workspace: Path,
        temporary_directory: Path,
    ) -> list[str]: ...


class SeatbeltSandbox:
    requirement = "seatbelt"

    def __init__(self, executable: Path = Path("/usr/bin/sandbox-exec")) -> None:
        self.executable = executable

    @property
    def available(self) -> bool:
        return self.executable.is_file() and os.access(self.executable, os.X_OK)

    def wrap(
        self,
        command: Sequence[str],
        *,
        workspace: Path,
        temporary_directory: Path,
    ) -> list[str]:
        if not self.available:
            raise ValidationCapabilityUnavailable("macOS seatbelt sandbox不可用")
        profile = temporary_directory / "validation.sb"
        launcher = Path(command[0])
        profile.write_text(
            self._profile(
                workspace,
                temporary_directory,
                launcher_root=launcher.parent.parent,
                runtime_root=launcher.resolve().parent.parent,
            ),
            encoding="utf-8",
        )
        return [str(self.executable), "-f", str(profile), *command]

    @staticmethod
    def _profile(
        workspace: Path,
        temporary_directory: Path,
        *,
        launcher_root: Path,
        runtime_root: Path,
    ) -> str:
        def quoted(path: Path) -> str:
            return json.dumps(str(path))

        # Python needs system libraries, but user/project data outside the
        # managed workspace remains unreadable.  Only the per-run temporary
        # directory is writable and all network operations are denied.
        return "\n".join(
            (
                "(version 1)",
                "(deny default)",
                '(import "system.sb")',
                "(allow process*)",
                "(allow sysctl-read)",
                "(allow file-read-metadata)",
                '(allow file-read* (subpath "/System") (subpath "/usr") '
                '(subpath "/Library") (subpath "/private/etc") '
                '(subpath "/private/var/db") (subpath "/dev") '
                f"(subpath {quoted(workspace)}) (subpath {quoted(launcher_root)}) "
                f"(subpath {quoted(runtime_root)}))",
                f"(allow file-write* (subpath {quoted(temporary_directory)}))",
                "(deny network*)",
            )
        )


class BubblewrapSandbox:
    requirement = "bwrap"

    def __init__(self, executable: Path = Path("/usr/bin/bwrap")) -> None:
        self.executable = executable

    @property
    def available(self) -> bool:
        return self.executable.is_file() and os.access(self.executable, os.X_OK)

    def wrap(
        self,
        command: Sequence[str],
        *,
        workspace: Path,
        temporary_directory: Path,
    ) -> list[str]:
        if not self.available:
            raise ValidationCapabilityUnavailable("Linux bwrap sandbox不可用")
        return [
            str(self.executable),
            "--die-with-parent",
            "--unshare-net",
            "--ro-bind",
            "/",
            "/",
            "--bind",
            str(temporary_directory),
            str(temporary_directory),
            "--chdir",
            str(workspace),
            *command,
        ]


class SandboxRegistry:
    def __init__(self, sandboxes: Iterable[ValidationSandbox] | None = None) -> None:
        values = tuple(sandboxes) if sandboxes is not None else (SeatbeltSandbox(), BubblewrapSandbox())
        self._sandboxes = {value.requirement: value for value in values}

    def require(self, requirement: str) -> ValidationSandbox:
        sandbox = self._sandboxes.get(requirement)
        if sandbox is None or not sandbox.available:
            raise ValidationCapabilityUnavailable("Validation所需OS sandbox不可用")
        return sandbox


@dataclass(frozen=True, slots=True)
class ValidationProcessResult:
    status: str
    exit_code: int | None
    duration_ms: int
    stdout_tail: str
    stderr_tail: str
    failure_code: str | None = None


class ValidationProcessRunner:
    """Execute one already-approved, fingerprint-bound validation command."""

    def __init__(self, *, sandboxes: SandboxRegistry | None = None) -> None:
        self._sandboxes = sandboxes or SandboxRegistry()

    async def run(self, compiled: CompiledValidation, *, workspace: Path) -> ValidationProcessResult:
        root = workspace.expanduser().resolve(strict=True)
        self._revalidate_fingerprints(compiled, root)
        if compiled.network_policy != "deny":
            raise ValidationCapabilityUnavailable("SD4-B只允许network_policy=deny")
        sandbox = self._sandboxes.require(compiled.sandbox_requirement)
        started = time.monotonic()
        with tempfile.TemporaryDirectory(prefix=".chat-validation-", dir=root) as raw_temp:
            temporary_directory = Path(raw_temp)
            command = sandbox.wrap(
                [str(compiled.executable), *compiled.expanded_argv],
                workspace=root,
                temporary_directory=temporary_directory,
            )
            process = await asyncio.create_subprocess_exec(
                *command,
                cwd=root,
                env=self._environment(temporary_directory),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                start_new_session=True,
            )
            status, stdout, stderr, failure_code = await self._collect(
                process,
                timeout_seconds=compiled.timeout_seconds,
                output_bytes=compiled.output_bytes,
            )
        duration_ms = int((time.monotonic() - started) * 1000)
        stdout_text = self._redact(stdout.decode("utf-8", errors="replace"), compiled.redaction_patterns)
        stderr_text = self._redact(stderr.decode("utf-8", errors="replace"), compiled.redaction_patterns)
        exit_code = process.returncode if process.returncode is not None and process.returncode >= 0 else None
        if status == "completed":
            status = "passed" if process.returncode == compiled.expected_exit_code else "failed"
        elif status == "signal":
            status = "outcome_unknown"
        return ValidationProcessResult(
            status=status,
            exit_code=exit_code,
            duration_ms=duration_ms,
            stdout_tail=stdout_text,
            stderr_tail=stderr_text,
            failure_code=failure_code,
        )

    @staticmethod
    def _revalidate_fingerprints(compiled: CompiledValidation, workspace: Path) -> None:
        if _sha256_file(compiled.executable) != compiled.resolved_executable_hash:
            raise ValidationCapabilityUnavailable("Validation executable Hash已漂移")
        current = ValidationCompiler._environment_fingerprint(
            workspace,
            executable_hash=compiled.resolved_executable_hash,
        )
        if current != compiled.environment_fingerprint:
            raise ValidationCapabilityUnavailable("Validation environment fingerprint已漂移")
        if content_hash(list(compiled.expanded_argv)) != compiled.expanded_argv_hash:
            raise ValidationCapabilityUnavailable("Validation argv Hash已漂移")

    async def _collect(
        self,
        process: asyncio.subprocess.Process,
        *,
        timeout_seconds: int,
        output_bytes: int,
    ) -> tuple[str, bytes, bytes, str | None]:
        stdout_buffer = bytearray()
        stderr_buffer = bytearray()
        total_bytes = 0
        output_exceeded = False

        async def drain(reader: asyncio.StreamReader | None, target: bytearray) -> None:
            nonlocal total_bytes, output_exceeded
            if reader is None:
                return
            while chunk := await reader.read(64 * 1024):
                total_bytes += len(chunk)
                target.extend(chunk)
                if len(target) > output_bytes:
                    del target[:-output_bytes]
                if total_bytes > output_bytes and not output_exceeded:
                    output_exceeded = True
                    await self._kill_process_group(process)

        drains = (
            asyncio.create_task(drain(process.stdout, stdout_buffer)),
            asyncio.create_task(drain(process.stderr, stderr_buffer)),
        )
        try:
            await asyncio.wait_for(process.wait(), timeout=timeout_seconds)
        except TimeoutError:
            await self._kill_process_group(process)
            await asyncio.gather(*drains)
            return (
                "timeout",
                bytes(stdout_buffer),
                bytes(stderr_buffer),
                "validation_timeout",
            )
        except asyncio.CancelledError:
            await self._kill_process_group(process)
            await asyncio.gather(*drains, return_exceptions=True)
            raise
        await asyncio.gather(*drains)
        stdout = bytes(stdout_buffer)
        stderr = bytes(stderr_buffer)
        if output_exceeded:
            return (
                "error",
                stdout[-output_bytes // 2 :],
                stderr[-output_bytes // 2 :],
                "validation_output_limit_exceeded",
            )
        if process.returncode is not None and process.returncode < 0:
            return "signal", stdout, stderr, "validation_process_signalled"
        return "completed", stdout, stderr, None

    @staticmethod
    async def _kill_process_group(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            return
        await process.wait()

    @staticmethod
    def _environment(temporary_directory: Path) -> dict[str, str]:
        return {
            "HOME": str(temporary_directory),
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            "PYTHONDONTWRITEBYTECODE": "1",
            "TMPDIR": str(temporary_directory),
        }

    @staticmethod
    def _redact(value: str, patterns: Sequence[str]) -> str:
        redacted = value
        for pattern in patterns:
            redacted = re.sub(pattern, "[redacted]", redacted)
        return redacted
