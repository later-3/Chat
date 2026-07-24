"""Real-Git and filesystem tests for the read-only repository adapter."""

from __future__ import annotations

import hashlib
import os
import subprocess
from pathlib import Path

import pytest

from backend.app.config import WorkspaceRootSettings
from backend.app.project_resources.catalog import WorkspaceRootCatalog
from backend.app.project_resources.contracts import RepositoryInspectionError
from backend.app.project_resources.git_inspector import ReadOnlyGitInspector
from backend.app.project_resources.paths import resolve_repository_path


def _git(cwd: Path, *arguments: str, check: bool = True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", *arguments],
        cwd=cwd,
        check=check,
        text=True,
        capture_output=True,
        env={
            **os.environ,
            "GIT_TERMINAL_PROMPT": "0",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_SYSTEM": os.devnull,
        },
    )


def _init_repository(path: Path, *, commit: bool = True) -> Path:
    path.mkdir(parents=True)
    _git(path, "init", "-q")
    _git(path, "config", "user.name", "Chat Test")
    _git(path, "config", "user.email", "chat-test@example.invalid")
    _git(path, "config", "commit.gpgsign", "false")
    if commit:
        (path / "README.md").write_text("# Test\n", encoding="utf-8")
        _git(path, "add", "README.md")
        _git(path, "commit", "-qm", "initial")
    return path


def _safe_repository(root: Path, relative: str = "repo"):
    catalog = WorkspaceRootCatalog((WorkspaceRootSettings("code", "Code", root),))
    return resolve_repository_path(catalog.require_available("code"), relative)


@pytest.mark.anyio
async def test_clean_repository_snapshot_and_governance_manifest_are_stable(
    tmp_path: Path,
) -> None:
    repository = _init_repository(tmp_path / "repo")
    safe = _safe_repository(tmp_path)
    inspector = ReadOnlyGitInspector()

    first = await inspector.inspect(safe, binding_generation=1)
    second = await inspector.inspect(safe, binding_generation=1)

    assert first.head_oid == _git(repository, "rev-parse", "HEAD").stdout.strip()
    assert first.head_ref and first.head_ref.startswith("refs/heads/")
    assert first.dirty is False
    assert first.change_count == 0
    assert first.fingerprint_complete is True
    assert first.semantic_hash == second.semantic_hash
    assert first.worktree_fingerprint == second.worktree_fingerprint
    assert first.governance_manifest == (
        {
            "path": "README.md",
            "kind": "project_readme",
            "sha256": hashlib.sha256(b"# Test\n").hexdigest(),
            "size_bytes": 7,
        },
    )


@pytest.mark.anyio
async def test_dirty_unicode_newline_and_rename_paths_are_parsed_without_quoting(
    tmp_path: Path,
) -> None:
    repository = _init_repository(tmp_path / "repo")
    original = repository / "旧\n名字.txt"
    original.write_text("old", encoding="utf-8")
    _git(repository, "add", original.name)
    _git(repository, "commit", "-qm", "unicode")
    renamed = repository / "新\n名字.txt"
    _git(repository, "mv", original.name, renamed.name)
    renamed.write_text("new content", encoding="utf-8")
    (repository / "未跟踪 文档.txt").write_text("untracked", encoding="utf-8")

    result = await ReadOnlyGitInspector().inspect(
        _safe_repository(tmp_path),
        binding_generation=1,
    )

    assert result.dirty is True
    assert result.staged_count == 1
    assert result.unstaged_count == 1
    assert result.untracked_count == 1
    paths = {value["path"] for value in result.change_summary}
    assert "新\n名字.txt" in paths
    assert "未跟踪 文档.txt" in paths
    assert any(value["kind"] == "rename" for value in result.change_summary)


@pytest.mark.anyio
async def test_unborn_and_detached_head_are_distinct_supported_states(
    tmp_path: Path,
) -> None:
    unborn = _init_repository(tmp_path / "unborn", commit=False)
    (unborn / "draft.txt").write_text("draft", encoding="utf-8")
    unborn_result = await ReadOnlyGitInspector().inspect(
        _safe_repository(tmp_path, "unborn"),
        binding_generation=1,
    )
    assert unborn_result.head_oid is None
    assert unborn_result.head_ref and unborn_result.head_ref.startswith("refs/heads/")
    assert unborn_result.detached_head is False

    committed = _init_repository(tmp_path / "detached")
    _git(committed, "checkout", "--detach", "-q")
    detached_result = await ReadOnlyGitInspector().inspect(
        _safe_repository(tmp_path, "detached"),
        binding_generation=1,
    )
    assert detached_result.head_oid is not None
    assert detached_result.head_ref is None
    assert detached_result.detached_head is True


@pytest.mark.anyio
@pytest.mark.parametrize("kind", ["non_git", "bare", "child"])
async def test_non_worktree_bare_and_child_bindings_fail_closed(
    tmp_path: Path,
    kind: str,
) -> None:
    if kind == "non_git":
        (tmp_path / "target").mkdir()
        safe = _safe_repository(tmp_path, "target")
        expected = "REPOSITORY_NOT_GIT"
    elif kind == "bare":
        target = tmp_path / "target"
        subprocess.run(["git", "init", "--bare", "-q", str(target)], check=True)
        safe = _safe_repository(tmp_path, "target")
        expected = "REPOSITORY_NOT_GIT"
    else:
        repository = _init_repository(tmp_path / "target")
        (repository / "child").mkdir()
        safe = _safe_repository(tmp_path, "target/child")
        expected = "REPOSITORY_SUBDIRECTORY_REJECTED"

    with pytest.raises(RepositoryInspectionError) as rejected:
        await ReadOnlyGitInspector().inspect(safe, binding_generation=1)
    assert rejected.value.code == expected


@pytest.mark.anyio
async def test_fingerprint_caps_are_visible_and_never_claim_completeness(
    tmp_path: Path,
) -> None:
    repository = _init_repository(tmp_path / "repo")
    (repository / "one.txt").write_text("123456", encoding="utf-8")
    (repository / "two.txt").write_text("abcdef", encoding="utf-8")

    path_capped = await ReadOnlyGitInspector(max_changed_paths=1).inspect(
        _safe_repository(tmp_path),
        binding_generation=1,
    )
    byte_capped = await ReadOnlyGitInspector(max_dirty_bytes=2).inspect(
        _safe_repository(tmp_path),
        binding_generation=1,
    )

    assert path_capped.change_count == 2
    assert path_capped.fingerprint_complete is False
    assert byte_capped.fingerprint_complete is False
    assert path_capped.semantic_hash != byte_capped.semantic_hash


@pytest.mark.anyio
async def test_governance_manifest_only_adopts_safe_allowlisted_utf8_files(
    tmp_path: Path,
) -> None:
    repository = _init_repository(tmp_path / "repo")
    outside = tmp_path / "outside-secret"
    outside.write_text("must-not-be-read", encoding="utf-8")
    (repository / "AGENTS.md").symlink_to(outside)
    (repository / "PROJECT_STATE.md").write_bytes(b"\xff\xfe")
    (repository / "PROJECT_PLAN.md").write_text(
        "x" * (256 * 1024 + 1),
        encoding="utf-8",
    )
    docs = repository / "docs"
    docs.mkdir()
    standard = docs / "engineering-standards.md"
    standard.write_text("# Standards\n", encoding="utf-8")

    result = await ReadOnlyGitInspector().inspect(
        _safe_repository(tmp_path),
        binding_generation=1,
    )

    paths = {value["path"] for value in result.governance_manifest}
    assert paths == {"README.md", "docs/engineering-standards.md"}
    assert "must-not-be-read" not in repr(result.governance_manifest)


@pytest.mark.anyio
async def test_inspection_does_not_modify_head_index_or_worktree_status(
    tmp_path: Path,
) -> None:
    repository = _init_repository(tmp_path / "repo")
    index = repository / ".git" / "index"
    before_head = _git(repository, "rev-parse", "HEAD").stdout
    before_status = _git(repository, "status", "--porcelain=v2", "-z").stdout
    before_index = index.read_bytes()
    before_mtime = index.stat().st_mtime_ns

    await ReadOnlyGitInspector().inspect(
        _safe_repository(tmp_path),
        binding_generation=1,
    )

    after_index = index.read_bytes()
    after_mtime = index.stat().st_mtime_ns
    assert _git(repository, "rev-parse", "HEAD").stdout == before_head
    assert _git(repository, "status", "--porcelain=v2", "-z").stdout == before_status
    assert after_index == before_index
    assert after_mtime == before_mtime


def _fake_git(path: Path, body: str) -> Path:
    executable = path / "fake-git"
    executable.write_text(f"#!/bin/sh\n{body}\n", encoding="utf-8")
    executable.chmod(0o755)
    return executable


@pytest.mark.anyio
async def test_git_runner_enforces_safe_flags_and_environment(tmp_path: Path) -> None:
    fake = _fake_git(
        tmp_path,
        'printf "%s|%s|%s|%s" "$1 $2 $3" "$GIT_OPTIONAL_LOCKS" "$GIT_TERMINAL_PROMPT" "$GIT_EXTERNAL_DIFF"',
    )
    inspector = ReadOnlyGitInspector(git_executable=str(fake))

    result = await inspector._run_git(tmp_path, "status")

    assert result.stdout == b"--no-optional-locks -c core.fsmonitor=false|0|0|"


@pytest.mark.anyio
async def test_git_runner_kills_timeout_and_output_overflow(tmp_path: Path) -> None:
    sleepy = _fake_git(tmp_path, "sleep 1")
    with pytest.raises(RepositoryInspectionError) as timeout:
        await ReadOnlyGitInspector(
            git_executable=str(sleepy),
            timeout_seconds=0.05,
        )._run_git(tmp_path, "status")
    assert timeout.value.code == "REPOSITORY_INSPECTION_TIMEOUT"

    noisy = _fake_git(tmp_path, "printf '1234567890'")
    with pytest.raises(RepositoryInspectionError) as overflow:
        await ReadOnlyGitInspector(
            git_executable=str(noisy),
            output_limit_bytes=4,
        )._run_git(tmp_path, "status")
    assert overflow.value.code == "REPOSITORY_INSPECTION_TOO_LARGE"

    missing = tmp_path / "missing-git"
    with pytest.raises(RepositoryInspectionError) as unavailable:
        await ReadOnlyGitInspector(git_executable=str(missing))._run_git(
            tmp_path,
            "status",
        )
    assert unavailable.value.code == "REPOSITORY_GIT_UNAVAILABLE"
