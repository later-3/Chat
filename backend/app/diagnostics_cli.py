"""Emit a redacted operational snapshot for local debugging."""

from __future__ import annotations

import argparse
import asyncio
import json
from typing import Any

from .config import Settings
from .observability.diagnostics import DiagnosticsService
from .observability.logging import configure_observability
from .product_sessions.database import ProductDatabase


async def collect(run_id: str | None = None) -> dict[str, Any]:
    settings = Settings.from_file()
    configure_observability(settings.observability)
    database = ProductDatabase(settings.database_url)
    diagnostics = DiagnosticsService(database)
    try:
        result: dict[str, Any] = {
            "readiness": await diagnostics.readiness(),
            "operations": await diagnostics.operations(),
        }
        if run_id is not None:
            result["run_timeline"] = await diagnostics.run_timeline(run_id)
        return result
    finally:
        await database.close()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Export redacted Chat health/backlog/run lifecycle diagnostics"
    )
    parser.add_argument(
        "--run-id",
        help="可选Product Run ID；只输出生命周期元数据，不输出消息或Payload",
    )
    return parser


def main() -> None:
    args = _parser().parse_args()
    print(
        json.dumps(
            asyncio.run(collect(args.run_id)),
            ensure_ascii=False,
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
