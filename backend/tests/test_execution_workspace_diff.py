"""第四/五轮复审P1-6：公开diff_text必须禁用外部diff/textconv且stderr脱敏。"""

from __future__ import annotations

import asyncio
from pathlib import Path

from backend.app.execution_workspaces.service import _redact_git_stderr
from backend.tests.test_tool_operation_workspaces import _git, _runtime


def test_public_diff_text_never_executes_repo_configured_drivers(tmp_path: Path) -> None:
    async def scenario() -> None:
        database, workspaces, _, ownership, fence, _ = await _runtime(tmp_path)
        try:
            workspace = await workspaces.create(ownership=ownership, fence=fence)
            root = await workspaces.private_path(workspace["id"])
            sentinel_diff = tmp_path / "sentinel-ext-diff"
            sentinel_textconv = tmp_path / "sentinel-textconv"
            _git(root, "config", "diff.poison.driver", f"touch {sentinel_diff}; cat")
            _git(root, "config", "diff.poison.textconv", f"touch {sentinel_textconv}; cat")
            (root / ".gitattributes").write_text("*.py diff=poison\n", encoding="utf-8")
            (root / "app.py").write_text("value = 'after'\n", encoding="utf-8")
            raw = await workspaces.diff_text(workspace["id"])
            text = raw.decode("utf-8", errors="replace")
            assert "-value = 'before'" in text
            assert "+value = 'after'" in text
            assert not sentinel_diff.exists()
            assert not sentinel_textconv.exists()
        finally:
            await database.close()

    asyncio.run(scenario())


def test_public_diff_text_arguments_pin_no_ext_diff_and_no_textconv(tmp_path: Path) -> None:
    """diff_text自身必须使用加固参数（不是测试里重复参数列表）。"""

    async def scenario() -> None:
        database, workspaces, _, ownership, fence, _ = await _runtime(tmp_path)
        try:
            workspace = await workspaces.create(ownership=ownership, fence=fence)
            calls: list[tuple[str, ...]] = []
            original = workspaces._run_git_bytes  # noqa: SLF001

            async def spy(cwd: Path, *arguments: str) -> bytes:
                calls.append(arguments)
                return await original(cwd, *arguments)

            workspaces._run_git_bytes = spy  # type: ignore[method-assign]  # noqa: SLF001
            (root := await workspaces.private_path(workspace["id"]))
            (root / "app.py").write_text("value = 'after'\n", encoding="utf-8")
            raw = await workspaces.diff_text(workspace["id"])
            assert raw
            assert len(calls) == 1
            arguments = calls[0]
            assert arguments[:3] == ("diff", "--no-ext-diff", "--no-textconv")
            assert "--binary" in arguments
            assert arguments[-1] == "--"
        finally:
            await database.close()

    asyncio.run(scenario())


def test_git_failure_message_never_echoes_stderr_or_paths(tmp_path: Path) -> None:
    """公开失败入口：损坏仓库的错误消息不含stderr原文或任何绝对路径。"""

    async def scenario() -> None:
        import shutil

        from backend.app.execution_workspaces.service import ExecutionWorkspaceError

        database, workspaces, _, ownership, fence, _ = await _runtime(tmp_path)
        try:
            workspace = await workspaces.create(ownership=ownership, fence=fence)
            root = await workspaces.private_path(workspace["id"])
            (root / "app.py").write_text("value = 'after'\n", encoding="utf-8")
            shutil.move(str(root / ".git"), str(root / ".git-disabled"))
            try:
                await workspaces.diff_text(workspace["id"])
                raise AssertionError("损坏仓库必须失败")
            except ExecutionWorkspaceError as error:
                message = str(error)
                assert str(root) not in message
                assert "/Users/" not in message
                assert "/private/" not in message
                assert "/tmp/" not in message
                assert ".git-disabled" not in message
                assert "not a git repository" not in message
                assert error.code == "EXECUTION_WORKSPACE_GIT_FAILED"
        finally:
            await database.close()

    asyncio.run(scenario())


def test_git_stderr_redaction_strips_workspace_and_absolute_paths() -> None:
    cwd = Path("/private/var/managed/ws-123")
    text = (
        "fatal: /private/var/managed/ws-123/README.md: cannot read /Users/xulater/private/config.json: denied"
    )
    redacted = _redact_git_stderr(text, cwd)
    assert "/private/var/managed" not in redacted
    assert "/Users/" not in redacted
    assert "<workspace>" in redacted
    assert "<path>" in redacted
    assert "denied" in redacted


def test_git_stderr_redaction_strips_tokens_and_long_secrets_before_cap() -> None:
    cwd = Path("/repo")
    secret = "sk-" + "x" * 64
    long_text = "pad " * 200 + f"token={secret} api_key={secret} at /Users/xulater/private/repo"
    redacted = _redact_git_stderr(long_text, cwd)
    capped = redacted[:300]
    assert secret not in redacted
    assert secret not in capped
    assert "/Users/" not in redacted
    assert "[redacted]" in redacted
