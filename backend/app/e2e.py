"""Deterministic ASGI entrypoint used only by browser automation."""

from dataclasses import replace

from .config import Settings
from .main import create_app

app = create_app(
    replace(
        Settings.for_test(),
        frontend_origins=("http://127.0.0.1:5074",),
        database_url="sqlite+aiosqlite:////tmp/chat-product-e2e.db",
    )
)
