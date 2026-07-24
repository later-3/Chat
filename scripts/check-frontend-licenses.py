#!/usr/bin/env python
"""Validate frontend dependency licenses from the lockfile.

Packages without lockfile license metadata fail closed unless they are a
reviewed exception. Exceptions identify packages, not license-shaped strings,
so a newly introduced package cannot inherit an unrelated waiver.
"""

from __future__ import annotations

import json
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LOCKFILE = PROJECT_ROOT / "frontend" / "package-lock.json"

ALLOWED_LICENSES = {
    "0BSD",
    "Apache-2.0",
    "BSD-2-Clause",
    "BSD-3-Clause",
    # SPDX identifies BlueOak-1.0.0 as a permissive license granting broad
    # copyright and patent permissions. Redistributors must preserve the
    # license text or its canonical link.
    "BlueOak-1.0.0",
    "ISC",
    "MIT",
    "MPL-2.0",
    "(Apache-2.0 AND BSD-3-Clause)",
    "MIT OR Apache-2.0",
}

# AG-UI 0.0.57 packages omit the license field from their published package
# metadata. Their pinned upstream repository is MIT licensed; keep this
# exception narrow and re-review it on dependency upgrade.
MISSING_METADATA_EXCEPTIONS = {
    "@ag-ui/client",
    "@ag-ui/core",
    "@ag-ui/encoder",
    "@ag-ui/proto",
}


def package_name(path: str, metadata: dict[str, object]) -> str:
    explicit = metadata.get("name")
    if isinstance(explicit, str) and explicit:
        return explicit
    return path.rsplit("node_modules/", maxsplit=1)[-1]


def main() -> int:
    lock = json.loads(LOCKFILE.read_text(encoding="utf-8"))
    violations: list[str] = []
    for path, raw_metadata in lock.get("packages", {}).items():
        if not path or not isinstance(raw_metadata, dict):
            continue
        name = package_name(path, raw_metadata)
        license_name = raw_metadata.get("license")
        if not isinstance(license_name, str) or not license_name:
            if name not in MISSING_METADATA_EXCEPTIONS:
                violations.append(f"{name}: missing license metadata")
            continue
        if license_name not in ALLOWED_LICENSES:
            violations.append(f"{name}: unreviewed license {license_name}")

    if violations:
        print("Frontend license policy failed:")
        for violation in sorted(violations):
            print(f"- {violation}")
        return 1
    print("Frontend license policy passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
