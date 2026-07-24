"""Project-owned repository bindings and immutable read-only observations."""

from .catalog import WorkspaceRootCatalog
from .context import (
    ContextSourceStale,
    RepositoryContextContributor,
    RepositoryContextSourceResolver,
    RepositorySourceFreshnessGuard,
)
from .git_inspector import ReadOnlyGitInspector
from .service import ProjectResourceService

__all__ = [
    "ContextSourceStale",
    "ProjectResourceService",
    "ReadOnlyGitInspector",
    "RepositoryContextContributor",
    "RepositoryContextSourceResolver",
    "RepositorySourceFreshnessGuard",
    "WorkspaceRootCatalog",
]
