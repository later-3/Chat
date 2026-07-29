#!/usr/bin/env python3
"""Safely toggle pi's private Node debugger settings without printing config.

The backend owns one startup snapshot from ``backend/config.json``.  VS Code
uses this helper before/after the dedicated compound so ordinary Chat launches
do not remain blocked on ``--inspect-brk`` after a debugging session.
"""

from __future__ import annotations

import argparse
import json
import os
import stat
import tempfile
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[1]
CONFIG_PATH = PROJECT_ROOT / "backend" / "config.json"


def _load_config() -> dict[str, Any]:
    try:
        payload = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise SystemExit("backend/config.json不存在，无法配置pi调试") from error
    except json.JSONDecodeError as error:
        raise SystemExit("backend/config.json不是有效JSON，未做任何修改") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("pi_agent"), dict):
        raise SystemExit("backend/config.json缺少pi_agent对象，未做任何修改")
    return payload


def _write_config(payload: dict[str, Any]) -> None:
    """Atomically replace the secret-bearing file while preserving its mode."""

    original_mode = stat.S_IMODE(CONFIG_PATH.stat().st_mode)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix="config.json.",
        suffix=".tmp",
        dir=CONFIG_PATH.parent,
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(original_mode)
        os.replace(temporary, CONFIG_PATH)
    finally:
        if temporary.exists():
            temporary.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(description="切换Chat调用pi时的Node源码调试开关")
    parser.add_argument("mode", choices=("enable", "disable"))
    parser.add_argument("--port", type=int, default=9230)
    arguments = parser.parse_args()
    if not 1 <= arguments.port <= 65535:
        raise SystemExit("调试端口必须在1到65535之间")

    payload = _load_config()
    pi_agent = payload["pi_agent"]
    if arguments.mode == "enable":
        pi_agent["node_debug_port"] = arguments.port
        pi_agent["node_debug_break"] = True
        result = f"pi源码调试已临时启用：inspect-brk 127.0.0.1:{arguments.port}"
    else:
        pi_agent["node_debug_port"] = None
        pi_agent["node_debug_break"] = False
        result = "pi源码调试已关闭：普通Chat调用不会等待调试器"
    _write_config(payload)
    print(result)


if __name__ == "__main__":
    main()
