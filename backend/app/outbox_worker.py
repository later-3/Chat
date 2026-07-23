"""Independent process entry point for governed runtime continuation delivery."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
from contextlib import suppress

from fastapi import FastAPI

from .config import Settings
from .governance import GovernanceOutboxWorker
from .main import create_app


logger = logging.getLogger(__name__)


async def run_outbox_worker(
    app: FastAPI,
    *,
    once: bool = False,
    poll_interval_seconds: float = 0.2,
    stop_event: asyncio.Event | None = None,
) -> int:
    """Run the Outbox deployment role using an isolated app composition root.

    The app must be created with ``start_outbox_worker=False`` so only this
    loop owns delivery in the process.  ``once`` drains the currently eligible
    batch and is intentionally exposed for health probes and deterministic
    integration tests.
    """

    if poll_interval_seconds <= 0:
        raise ValueError("poll_interval_seconds必须大于0")
    processed = 0
    async with app.router.lifespan_context(app):
        worker = getattr(app.state, "governance_outbox_worker", None)
        if not isinstance(worker, GovernanceOutboxWorker):
            raise RuntimeError("当前配置没有可用的Governance Outbox Worker")
        logger.info("governance_outbox_worker_started worker_id=%s", worker.worker_id)
        if once:
            processed = await worker.drain()
        else:
            signal = stop_event or asyncio.Event()
            while not signal.is_set():
                try:
                    handled = await worker.run_once()
                except asyncio.CancelledError:
                    raise
                except Exception:
                    # A lost lease or transient database failure must not kill
                    # the long-running deployment role. The row remains
                    # reclaimable; the handler is idempotent by dedupe key.
                    logger.exception(
                        "governance_outbox_worker_cycle_failed worker_id=%s",
                        worker.worker_id,
                    )
                    handled = False
                if handled:
                    processed += 1
                    continue
                with suppress(asyncio.TimeoutError):
                    await asyncio.wait_for(signal.wait(), timeout=poll_interval_seconds)
        logger.info(
            "governance_outbox_worker_stopped worker_id=%s processed=%d",
            worker.worker_id,
            processed,
        )
    return processed


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the Chat governance Outbox Worker")
    parser.add_argument("--once", action="store_true", help="处理当前可领取事件后退出")
    parser.add_argument("--poll-interval", type=float, default=0.2, help="空队列轮询间隔（秒）")
    return parser


def main() -> None:
    args = _parser().parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    worker_id = f"outbox-worker-{os.getpid()}"
    app = create_app(
        Settings.from_file(),
        start_outbox_worker=False,
        outbox_worker_id=worker_id,
        start_execution_worker=False,
    )
    asyncio.run(
        run_outbox_worker(
            app,
            once=args.once,
            poll_interval_seconds=args.poll_interval,
        )
    )


if __name__ == "__main__":
    main()
