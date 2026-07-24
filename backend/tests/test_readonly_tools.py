from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest

from backend.app.execution_dispatch.contracts import RepositoryFence
from backend.app.readonly_tools import ReadonlyToolService, ReadonlyToolValidationError
from backend.app.readonly_tools.service import MAX_TOOL_RESULT_BYTES


class StubRepositoryContext:
    def __init__(self, root: Path) -> None:
        self.root = root
        self.fences: list[RepositoryFence] = []

    async def resolve_private_path(self, fence: RepositoryFence) -> Path:
        self.fences.append(fence)
        return self.root


@pytest.fixture
def fence() -> RepositoryFence:
    return RepositoryFence(
        project_id="project-1",
        binding_id="binding-1",
        snapshot_id="snapshot-1",
        binding_generation=1,
        snapshot_sequence=1,
        semantic_hash="a" * 64,
        governance_manifest_hash="b" * 64,
        head_oid=None,
        worktree_fingerprint="c" * 64,
        root_key="workspace",
        relative_path="repo",
    )


@pytest.fixture
def repository(tmp_path: Path) -> Path:
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "app.py").write_text("alpha\\nbeta target\\ngamma\\n", encoding="utf-8")
    (tmp_path / "README.md").write_text("# Demo\\ntarget\\n", encoding="utf-8")
    (tmp_path / ".git").mkdir()
    return tmp_path


@pytest.mark.parametrize(
    ("tool_name", "arguments", "expected_key"),
    [
        ("read", {"path": "src/app.py", "offset": 2, "limit": 1}, "lines"),
        ("grep", {"path": ".", "pattern": "target"}, "matches"),
        ("find", {"path": ".", "pattern": "*.py"}, "matches"),
        ("ls", {"path": "."}, "entries"),
    ],
)
def test_readonly_tools_are_bounded_and_revalidate_fence(
    repository: Path,
    fence: RepositoryFence,
    tool_name: str,
    arguments: dict[str, Any],
    expected_key: str,
) -> None:
    context = StubRepositoryContext(repository)
    service = ReadonlyToolService(context)  # type: ignore[arg-type]

    result = asyncio.run(
        service.execute(
            fence=fence,
            tool_name=tool_name,
            arguments=arguments,
        )
    )

    assert result["repository_snapshot_id"] == fence.snapshot_id
    assert expected_key in result["result"]
    assert context.fences == [fence]


def test_readonly_tools_reject_write_capabilities(
    repository: Path,
    fence: RepositoryFence,
) -> None:
    service = ReadonlyToolService(StubRepositoryContext(repository))  # type: ignore[arg-type]

    with pytest.raises(ReadonlyToolValidationError) as captured:
        asyncio.run(service.execute(fence=fence, tool_name="write", arguments={"path": "x"}))

    assert captured.value.code == "READ_TOOL_NOT_ALLOWED"


def test_readonly_tools_reject_traversal_and_symlinks(
    repository: Path,
    fence: RepositoryFence,
) -> None:
    service = ReadonlyToolService(StubRepositoryContext(repository))  # type: ignore[arg-type]
    with pytest.raises(ReadonlyToolValidationError) as traversal:
        asyncio.run(
            service.execute(
                fence=fence,
                tool_name="read",
                arguments={"path": "../secret"},
            )
        )
    assert traversal.value.code == "READ_TOOL_PATH_INVALID"

    link = repository / "outside-link"
    try:
        link.symlink_to(repository.parent)
    except OSError:
        pytest.skip("当前平台不允许创建符号链接")
    with pytest.raises(ReadonlyToolValidationError) as symlink:
        asyncio.run(
            service.execute(
                fence=fence,
                tool_name="ls",
                arguments={"path": "outside-link"},
            )
        )
    assert symlink.value.code == "READ_TOOL_SYMLINK_REJECTED"


def test_readonly_tools_reject_protected_sources(
    repository: Path,
    fence: RepositoryFence,
) -> None:
    (repository / "backend").mkdir()
    (repository / "backend" / "config.json").write_text('{"api_key":"secret"}', encoding="utf-8")
    service = ReadonlyToolService(StubRepositoryContext(repository))  # type: ignore[arg-type]

    with pytest.raises(ReadonlyToolValidationError) as captured:
        asyncio.run(
            service.execute(
                fence=fence,
                tool_name="read",
                arguments={"path": "backend/config.json"},
            )
        )

    assert captured.value.code == "READ_TOOL_SOURCE_PROTECTED"

    grep_result = asyncio.run(
        service.execute(
            fence=fence,
            tool_name="grep",
            arguments={"path": ".", "pattern": "secret"},
        )
    )
    assert grep_result["result"]["matches"] == []


def test_readonly_tool_result_is_bounded_after_json_encoding(
    repository: Path,
    fence: RepositoryFence,
) -> None:
    (repository / "large.txt").write_text("界" * 100_000, encoding="utf-8")
    service = ReadonlyToolService(StubRepositoryContext(repository))  # type: ignore[arg-type]

    result = asyncio.run(
        service.execute(
            fence=fence,
            tool_name="read",
            arguments={"path": "large.txt", "limit": 1},
        )
    )

    encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode()
    assert len(encoded) <= MAX_TOOL_RESULT_BYTES
    assert result["result"]["truncated"] is True
