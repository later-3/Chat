"""FastAPI composition root for the independent Chat product."""

from __future__ import annotations

from typing import Any

from agent_framework.ag_ui import add_agent_framework_fastapi_endpoint
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .agents import create_agent
from .config import Settings


def create_app(settings: Settings | None = None) -> FastAPI:
    """Create an isolated app instance suitable for production or contract tests."""

    resolved = settings or Settings.from_env()
    app = FastAPI(
        title="Chat",
        version="0.1.0",
        description="Independent AI collaboration Chat product powered by MAF and AG-UI.",
    )
    app.state.settings = resolved
    app.add_middleware(
        CORSMiddleware,
        allow_origins=list(resolved.frontend_origins),
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "chat",
            "version": "0.1.0",
            "agent_framework": "microsoft-agent-framework",
            "protocol": "ag-ui",
            "runtime_mode": resolved.runtime_mode,
            "model": resolved.model if resolved.runtime_mode == "model" else None,
        }

    agent = create_agent(resolved)
    app.state.agent = agent
    # MAF owns the Agent-to-AG-UI event conversion. Keeping that bridge here
    # avoids a second application-specific streaming protocol or state source.
    add_agent_framework_fastapi_endpoint(
        app,
        agent,
        "/api/agent",
        allow_origins=list(resolved.frontend_origins),
        tags=["agent"],
    )
    return app


app = create_app()
