from __future__ import annotations

import pytest

from backend.app.execution_dispatch.contracts import RepositoryFence
from backend.app.execution_dispatch.drafts import recommends_pi_workspace_edit


def _fence() -> RepositoryFence:
    return RepositoryFence(
        project_id="project-1",
        binding_id="binding-1",
        snapshot_id="snapshot-1",
        binding_generation=1,
        snapshot_sequence=1,
        semantic_hash="a" * 64,
        governance_manifest_hash="b" * 64,
        head_oid="c" * 40,
        worktree_fingerprint="d" * 64,
        root_key="workspace",
        relative_path="Chat",
    )


def test_workspace_edit_allows_isolated_write_while_protecting_active_repository() -> None:
    assert recommends_pi_workspace_edit(
        prompt=(
            "先用 read 读取 README.md，再精确修改标题。只允许隔离 Execution Workspace "
            "的 edit，不修改活动仓库，不提交、不推送。"
        ),
        selected_project_id="project-1",
        repository_fence=_fence(),
        pi_available=True,
    )


@pytest.mark.parametrize(
    "prompt",
    [
        "只读检查仓库，不修改任何文件。",
        "请 review code，禁止写入。",
        "Use read-only tools and do not modify any files.",
    ],
)
def test_workspace_edit_fails_closed_for_true_write_opt_out(prompt: str) -> None:
    assert not recommends_pi_workspace_edit(
        prompt=prompt,
        selected_project_id="project-1",
        repository_fence=_fence(),
        pi_available=True,
    )
