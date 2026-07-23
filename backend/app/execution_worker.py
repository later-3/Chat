"""Independent process entry point for generic MAF/AG-UI execution jobs."""

from __future__ import annotations

import argparse
import asyncio
import logging
import os
from contextlib import suppress

from fastapi import FastAPI

from .config import Settings
from .main import create_app
from .runtime_execution import ExecutionWorker


logger = logging.getLogger(__name__)


async def run_execution_worker(
    app: FastAPI,
    *,
    once: bool = False,
    poll_interval_seconds: float = 0.08,
    stop_event: asyncio.Event | None = None,
) -> int:
    """Run the Worker deployment role against the shared Product Store."""

    if poll_interval_seconds <= 0:
        raise ValueError("poll_interval_seconds必须大于0")
    processed = 0
    async with app.router.lifespan_context(app):
        worker = getattr(app.state, "execution_worker", None)
        if not isinstance(worker, ExecutionWorker):
            raise RuntimeError("当前应用没有Execution Worker")
        await worker.register()
        logger.info("execution_worker_started worker_id=%s", worker.worker_id)
        try:
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
                        logger.exception(
                            "execution_worker_cycle_failed worker_id=%s",
                            worker.worker_id,
                        )
                        handled = False
                    if handled:
                        processed += 1
                        continue
                    with suppress(asyncio.TimeoutError):
                        await asyncio.wait_for(signal.wait(), timeout=poll_interval_seconds)
        finally:
            await worker.stop()
        logger.info("execution_worker_stopped worker_id=%s processed=%d", worker.worker_id, processed)
    return processed


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the Chat generic Execution Worker")
    parser.add_argument("--once", action="store_true", help="处理当前可领取Job后退出")
    parser.add_argument("--poll-interval", type=float, default=0.08, help="空队列轮询间隔（秒）")
    return parser


def main() -> None:
    args = _parser().parse_args()
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    app = create_app(
        Settings.from_file(),
        start_execution_worker=False,
        execution_worker_id=f"execution-worker-{os.getpid()}",
        start_outbox_worker=False,
    )
    asyncio.run(
        run_execution_worker(
            app,
            once=args.once,
            poll_interval_seconds=args.poll_interval,
        )
    )


if __name__ == "__main__":
    main()
