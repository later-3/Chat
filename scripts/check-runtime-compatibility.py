#!/usr/bin/env python3
"""Fail CI/startup rehearsal when the installed MAF/AG-UI contract drifts."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))


def main() -> int:
    from backend.app.runtime_adapters import (  # noqa: PLC0415
        MAF_REFERENCE_COMMIT,
        assert_runtime_compatibility,
    )

    versions = assert_runtime_compatibility()
    print(
        json.dumps(
            {
                "status": "compatible",
                "installed_versions": versions,
                "maf_reference_commit": MAF_REFERENCE_COMMIT,
            },
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
