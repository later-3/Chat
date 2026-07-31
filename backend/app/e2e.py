"""Deterministic ASGI entrypoint used only by browser automation.

The fixture owns only a disposable ``/tmp`` database and Git worktree. It
never reads the developer's private configuration or real repositories.
"""

import os
import shutil
import subprocess
import tempfile
from dataclasses import replace
from pathlib import Path

from .config import Settings, WorkspaceRootSettings
from .main import create_app


def _prepare_repository_workspace() -> Path:
    root = Path(tempfile.gettempdir()) / "chat-product-e2e-workspaces"
    repository = root / "chat-e2e-repository"
    repository.mkdir(parents=True, exist_ok=True)
    environment = {
        **os.environ,
        "GIT_TERMINAL_PROMPT": "0",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
    }

    def git(*arguments: str) -> str:
        result = subprocess.run(
            ["git", *arguments],
            cwd=repository,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
            env=environment,
        )
        return result.stdout.strip()

    if (repository / ".git").is_dir():
        try:
            if git("rev-parse", "--is-inside-work-tree") == "true":
                return root
        except subprocess.CalledProcessError:
            pass
        # This exact path is owned by the E2E fixture. A partial ``.git`` must
        # not be accepted as evidence or leak a prior failed run into the next.
        shutil.rmtree(repository)
        repository.mkdir(parents=True)

    git("init", "-q")
    git("config", "user.name", "Chat Browser E2E")
    git("config", "user.email", "chat-browser-e2e@example.invalid")
    git("config", "commit.gpgsign", "false")
    (repository / "README.md").write_text(
        "# Chat browser E2E repository\n",
        encoding="utf-8",
    )
    git("add", "README.md")
    git("commit", "-qm", "initial fixture")
    return root


_WORKSPACE_ROOT = _prepare_repository_workspace()
_DATABASE_PATH = Path(tempfile.gettempdir()) / "chat-product-e2e.db"
for suffix in ("", "-shm", "-wal"):
    _DATABASE_PATH.with_name(f"{_DATABASE_PATH.name}{suffix}").unlink(missing_ok=True)

app = create_app(
    replace(
        Settings.for_test(),
        frontend_origins=("http://127.0.0.1:5074",),
        database_url=f"sqlite+aiosqlite:///{_DATABASE_PATH}",
        workspace_roots=(
            WorkspaceRootSettings(
                key="e2e-code",
                label="E2E代码",
                path=_WORKSPACE_ROOT,
            ),
        ),
    )
)
