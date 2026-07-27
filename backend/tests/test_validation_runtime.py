"""SD4-B tests for deterministic validation compilation and sandbox execution."""

from __future__ import annotations

import asyncio
import hashlib
import os
import sys
from dataclasses import replace
from pathlib import Path

import pytest
from sqlalchemy import func, select

from backend.app.collaboration_intents import models as _ci  # noqa: F401
from backend.app.collaboration_protocols import models as _cp  # noqa: F401
from backend.app.evidence import models as _ev  # noqa: F401
from backend.app.evidence.contracts import (
    EvidenceConflict,
    EvidenceValidationError,
    ValidationCapabilityUnavailable,
    content_hash,
)
from backend.app.evidence.models import ValidationCapabilityRecord
from backend.app.evidence.validation_runtime import (
    CompiledValidation,
    SandboxRegistry,
    ValidationCapabilityCatalog,
    ValidationCompiler,
    ValidationProcessRunner,
    default_validation_capabilities,
)
from backend.app.execution_workspaces import models as _ew  # noqa: F401
from backend.app.governance import models as _gov  # noqa: F401
from backend.app.harness import models as _har  # noqa: F401
from backend.app.product_sessions.database import ProductDatabase
from backend.app.project_resources import models as _pr  # noqa: F401
from backend.app.runtime_execution import models as _re  # noqa: F401
from backend.app.step_inputs import models as _si  # noqa: F401
from backend.app.tool_execution import models as _te  # noqa: F401


class PassthroughSandbox:
    requirement = "test"
    available = True

    def wrap(self, command, *, workspace: Path, temporary_directory: Path) -> list[str]:
        return list(command)


def _run(scenario) -> None:
    asyncio.run(scenario())


def _project_python() -> Path:
    return Path(__file__).resolve().parents[2] / ".venv" / "bin" / "python"


def _raw_compiled(
    workspace: Path,
    *arguments: str,
    timeout_seconds: int = 5,
    output_bytes: int = 4096,
    redaction_patterns: tuple[str, ...] = (),
) -> CompiledValidation:
    executable = _project_python().absolute()
    executable_hash = hashlib.sha256(executable.read_bytes()).hexdigest()
    argv = tuple(arguments)
    return CompiledValidation(
        capability_key="test",
        capability_version="1",
        capability_hash="a" * 64,
        executable=executable,
        resolved_executable_hash=executable_hash,
        environment_fingerprint=ValidationCompiler._environment_fingerprint(
            workspace,
            executable_hash=executable_hash,
        ),
        expanded_argv=argv,
        expanded_argv_hash=content_hash(list(argv)),
        expected_exit_code=0,
        sandbox_requirement="test",
        network_policy="deny",
        side_effect_class="readonly",
        timeout_seconds=timeout_seconds,
        output_bytes=output_bytes,
        redaction_patterns=redaction_patterns,
    )


def test_capability_catalog_seed_is_idempotent_and_detects_version_drift(tmp_path: Path) -> None:
    async def scenario() -> None:
        database = ProductDatabase("sqlite+aiosqlite:///:memory:")
        await database.initialize()
        try:
            definition = default_validation_capabilities(platform="darwin")[0]
            catalog = ValidationCapabilityCatalog((definition,))
            assert await catalog.seed(database) == 1
            assert await catalog.seed(database) == 0
            async with database.sessions() as transaction:
                assert await transaction.scalar(select(func.count(ValidationCapabilityRecord.id))) == 1
                stored = await transaction.scalar(select(ValidationCapabilityRecord))
                assert stored is not None
                assert stored.capability_hash == definition.capability_hash

            changed = replace(definition, network_policy="allowlist")
            with pytest.raises(EvidenceConflict):
                await ValidationCapabilityCatalog((changed,)).seed(database)
        finally:
            await database.close()

    _run(scenario)


def test_compiler_produces_exact_hash_bound_argv_and_rejects_schema_escape(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "pyproject.toml").write_text("[project]\nname='fixture'\n", encoding="utf-8")
    definition = default_validation_capabilities(platform="darwin")[0]
    compiler = ValidationCompiler(project_python=_project_python())
    compiled = compiler.compile(
        definition,
        params={"targets": ["backend/tests/test_app.py::test_health"], "extra_args": ["-x", "-q"]},
        workspace=workspace,
    )
    # Workspace没有受支持pytest配置：显式空配置+固定rootdir/confcutdir，拒绝祖先爬取。
    assert compiled.expanded_argv == (
        "-m",
        "pytest",
        "-p",
        "no:cacheprovider",
        "-c",
        "/dev/null",
        "--rootdir",
        ".",
        "--confcutdir",
        ".",
        "backend/tests/test_app.py::test_health",
        "-x",
        "-q",
    )
    assert compiled.expanded_argv_hash == content_hash(list(compiled.expanded_argv))
    assert compiled.capability_hash == definition.capability_hash

    invalid = (
        {"targets": ["backend/tests"], "environment": {"TOKEN": "x"}},
        {"targets": ["../backend/config.json"]},
        {"targets": ["backend/tests"], "extra_args": ["--collect-only"]},
        {"targets": "backend/tests"},
        {"targets": ["backend/tests"], "config": "pytest.ini"},
    )
    for params in invalid:
        with pytest.raises(EvidenceValidationError):
            compiler.compile(definition, params=params, workspace=workspace)


def test_compiler_pins_workspace_pytest_config_into_argv_and_fingerprint(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    config = workspace / "pytest.ini"
    config.write_text("[pytest]\naddopts = -q\n", encoding="utf-8")
    definition = default_validation_capabilities(platform="darwin")[0]
    compiler = ValidationCompiler(project_python=_project_python())
    compiled = compiler.compile(
        definition,
        params={"targets": ["tests"]},
        workspace=workspace,
    )
    assert compiled.expanded_argv[:6] == ("-m", "pytest", "-p", "no:cacheprovider", "-c", "pytest.ini")
    assert "--rootdir" in compiled.expanded_argv
    fingerprint = ValidationCompiler._environment_fingerprint(
        workspace,
        executable_hash=compiled.resolved_executable_hash,
    )
    assert fingerprint == compiled.environment_fingerprint
    config.unlink()
    assert (
        ValidationCompiler._environment_fingerprint(
            workspace,
            executable_hash=compiled.resolved_executable_hash,
        )
        != fingerprint
    )


def test_runner_ignores_ancestor_pyproject_when_workspace_has_no_config(tmp_path: Path) -> None:
    """父目录存在pyproject配置时，无配置的Workspace仍只运行自身tests。"""

    async def scenario() -> None:
        parent = tmp_path / "parent"
        workspace = parent / "managed-workspaces" / "ws-target"
        workspace.mkdir(parents=True)
        # 祖先配置一旦被继承就必然失败：引用不存在的插件与目标外testpaths。
        (parent / "pyproject.toml").write_text(
            "[tool.pytest.ini_options]\n"
            "addopts = '-p no_such_plugin_for_sd4c'\n"
            "testpaths = ['../../Chat/backend/tests']\n",
            encoding="utf-8",
        )
        tests_dir = workspace / "tests"
        tests_dir.mkdir()
        (tests_dir / "test_workspace_only.py").write_text(
            "def test_workspace_only():\n    assert True\n",
            encoding="utf-8",
        )
        definition = default_validation_capabilities(platform="darwin")[0]
        compiled = ValidationCompiler(project_python=_project_python()).compile(
            definition,
            params={"targets": ["tests"], "extra_args": ["-q"]},
            workspace=workspace,
        )
        result = await ValidationProcessRunner().run(compiled, workspace=workspace)
        assert result.status == "passed", result.stdout_tail + result.stderr_tail
        assert "no_such_plugin_for_sd4c" not in result.stderr_tail

    _run(scenario)


def test_compiler_never_falls_back_to_system_python(tmp_path: Path) -> None:
    definition = default_validation_capabilities(platform="darwin")[0]
    compiler = ValidationCompiler(project_python=tmp_path / "missing-venv" / "bin" / "python")
    with pytest.raises(ValidationCapabilityUnavailable):
        compiler.compile(definition, params={"targets": ["backend/tests"]}, workspace=tmp_path)


def test_runner_fails_before_spawn_when_environment_or_sandbox_drift(tmp_path: Path) -> None:
    async def scenario() -> None:
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        lock = workspace / "pyproject.toml"
        lock.write_text("[project]\nname = 'fixture-a'\n", encoding="utf-8")
        compiled = _raw_compiled(workspace, "-c", "print('ok')")
        lock.write_text("[project]\nname = 'fixture-b'\n", encoding="utf-8")
        runner = ValidationProcessRunner(sandboxes=SandboxRegistry((PassthroughSandbox(),)))
        with pytest.raises(ValidationCapabilityUnavailable):
            await runner.run(compiled, workspace=workspace)

        fresh = _raw_compiled(workspace, "-c", "print('ok')")
        with pytest.raises(ValidationCapabilityUnavailable):
            await ValidationProcessRunner(sandboxes=SandboxRegistry(())).run(
                fresh,
                workspace=workspace,
            )

    _run(scenario)


def test_compiler_fails_closed_on_malformed_workspace_config(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    (workspace / "pyproject.toml").write_text("[project\nname = 'broken'\n", encoding="utf-8")
    definition = default_validation_capabilities(platform="darwin")[0]
    compiler = ValidationCompiler(project_python=_project_python())
    with pytest.raises(EvidenceValidationError, match="无法解析"):
        compiler.compile(definition, params={"targets": ["tests"]}, workspace=workspace)
    (workspace / "pyproject.toml").unlink()
    (workspace / "tox.ini").write_text("[pytest\naddopts", encoding="utf-8")
    with pytest.raises(EvidenceValidationError, match="无法解析"):
        compiler.compile(definition, params={"targets": ["tests"]}, workspace=workspace)
    (workspace / "tox.ini").unlink()
    (workspace / "setup.cfg").write_text("[tool:pytest\naddopts", encoding="utf-8")
    with pytest.raises(EvidenceValidationError, match="无法解析"):
        compiler.compile(definition, params={"targets": ["tests"]}, workspace=workspace)


def test_runner_bounds_output_redacts_secrets_and_classifies_process_terminal_states(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        runner = ValidationProcessRunner(sandboxes=SandboxRegistry((PassthroughSandbox(),)))

        redacted = await runner.run(
            _raw_compiled(
                workspace,
                "-c",
                "print('sensitive-value-123456789')",
                redaction_patterns=(r"sensitive-value-[0-9]+",),
            ),
            workspace=workspace,
        )
        assert redacted.status == "passed"
        assert redacted.stdout_tail.strip() == "[redacted]"

        bounded = await runner.run(
            _raw_compiled(
                workspace,
                "-c",
                "print('x' * 100000)",
                output_bytes=1024,
            ),
            workspace=workspace,
        )
        assert bounded.status == "error"
        assert bounded.failure_code == "validation_output_limit_exceeded"
        assert len(bounded.stdout_tail.encode()) <= 512

        timed_out = await runner.run(
            _raw_compiled(
                workspace,
                "-c",
                "import time; time.sleep(3)",
                timeout_seconds=1,
            ),
            workspace=workspace,
        )
        assert timed_out.status == "timeout"
        assert timed_out.failure_code == "validation_timeout"

        signalled = await runner.run(
            _raw_compiled(
                workspace,
                "-c",
                "import os, signal; os.kill(os.getpid(), signal.SIGKILL)",
            ),
            workspace=workspace,
        )
        assert signalled.status == "outcome_unknown"
        assert signalled.failure_code == "validation_process_signalled"

    _run(scenario)


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS seatbelt contract")
def test_real_seatbelt_allows_workspace_tests_but_denies_network_and_outside_reads(
    tmp_path: Path,
) -> None:
    async def scenario() -> None:
        workspace = tmp_path / "workspace"
        workspace.mkdir()
        outside = tmp_path / "outside-secret.txt"
        outside.write_text("must-not-be-readable", encoding="utf-8")
        test_file = workspace / "test_sandbox_contract.py"
        test_file.write_text(
            "\n".join(
                (
                    "import socket",
                    "from pathlib import Path",
                    "import pytest",
                    "",
                    "def test_sandbox_contract():",
                    "    with pytest.raises(PermissionError):",
                    "        (Path.cwd().parent / 'outside-secret.txt').read_text()",
                    "    sock = socket.socket()",
                    "    try:",
                    "        with pytest.raises(PermissionError):",
                    "            sock.connect(('127.0.0.1', 9))",
                    "    finally:",
                    "        sock.close()",
                )
            ),
            encoding="utf-8",
        )
        definition = default_validation_capabilities(platform="darwin")[0]
        compiled = ValidationCompiler(project_python=_project_python()).compile(
            definition,
            params={"targets": [test_file.name], "extra_args": ["-q"]},
            workspace=workspace,
        )
        result = await ValidationProcessRunner().run(compiled, workspace=workspace)
        assert result.status == "passed", result.stdout_tail + result.stderr_tail
        assert not list(workspace.glob(".chat-validation-*"))

    _run(scenario)


def test_default_capability_hash_includes_platform_sandbox_contract() -> None:
    darwin = default_validation_capabilities(platform="darwin")[0]
    linux = default_validation_capabilities(platform="linux")[0]
    assert darwin.sandbox_requirement == "seatbelt"
    assert linux.sandbox_requirement == "bwrap"
    assert darwin.capability_hash != linux.capability_hash
    assert os.path.isabs(str(_project_python()))
