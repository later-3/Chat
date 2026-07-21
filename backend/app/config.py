from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parents[2]
BACKEND_ROOT = PROJECT_ROOT / "backend"

# The backend-local file is authoritative for backend secrets. The root file is
# retained as a non-overriding compatibility fallback for early local setups.
load_dotenv(BACKEND_ROOT / ".env", override=False)
load_dotenv(PROJECT_ROOT / ".env", override=False)


def _first_env(*names: str, default: str | None = None) -> str | None:
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    return default


def _origins(value: str | None) -> tuple[str, ...]:
    if not value:
        return ("http://127.0.0.1:5073", "http://localhost:5073")
    parsed = tuple(item.strip() for item in value.split(",") if item.strip())
    return parsed or ("http://127.0.0.1:5073", "http://localhost:5073")


@dataclass(frozen=True, slots=True)
class Settings:
    host: str
    port: int
    frontend_origins: tuple[str, ...]
    model: str
    model_api_key: str | None
    model_base_url: str | None

    @property
    def runtime_mode(self) -> str:
        return "model" if self.model_api_key else "bootstrap"

    @classmethod
    def from_env(cls) -> "Settings":
        return cls(
            host=os.environ.get("CHAT_BACKEND_HOST", "127.0.0.1"),
            port=int(os.environ.get("CHAT_BACKEND_PORT", "8030")),
            frontend_origins=_origins(os.environ.get("CHAT_FRONTEND_ORIGINS")),
            model=_first_env("CHAT_MODEL", "ARK_MODEL", default="gpt-5-mini") or "gpt-5-mini",
            model_api_key=_first_env("CHAT_MODEL_API_KEY", "ARK_API_KEY"),
            model_base_url=_first_env("CHAT_MODEL_BASE_URL", "ARK_BASE_URL"),
        )

    @classmethod
    def for_test(cls) -> "Settings":
        return cls(
            host="127.0.0.1",
            port=8030,
            frontend_origins=("http://testserver",),
            model="test/bootstrap",
            model_api_key=None,
            model_base_url=None,
        )
