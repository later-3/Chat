"""Chat backend package.

The FastAPI composition root is loaded lazily so importing persistence models
for Alembic or isolated domain tests does not construct the entire runtime.
"""

from __future__ import annotations

from typing import Any

__all__ = ["app", "create_app"]


def __getattr__(name: str) -> Any:
    if name not in __all__:
        raise AttributeError(name)
    from .main import app, create_app

    return {"app": app, "create_app": create_app}[name]
