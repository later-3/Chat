#!/usr/bin/env python
"""Reject credential-shaped values in Git-tracked text files without echoing them."""

from __future__ import annotations

import re
import subprocess
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SKIP_SUFFIXES = {
    ".gif",
    ".ico",
    ".jpeg",
    ".jpg",
    ".lock",
    ".pdf",
    ".png",
    ".webp",
}
PLACEHOLDERS = (
    "${",
    "<",
    "changeme",
    "example",
    "fake",
    "not-a-real",
    "placeholder",
    "replace",
    "test",
    "your-",
)
KNOWN_TEST_VALUES = {"alpha-secret", "dashscope-secret"}
PATTERNS = {
    "private_key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "openai_style_key": re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    "github_token": re.compile(r"\bgh[opusr]_[A-Za-z0-9]{20,}\b"),
    "bearer_token": re.compile(r"\bBearer\s+([A-Za-z0-9._~-]{24,})\b", re.IGNORECASE),
    "json_api_key": re.compile(
        r"""["'](?:api[_-]?key|access[_-]?token|client[_-]?secret)["']\s*[:=]\s*["']([^"']{12,})["']""",
        re.IGNORECASE,
    ),
}


def tracked_files() -> list[Path]:
    result = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
        cwd=PROJECT_ROOT,
        check=True,
        capture_output=True,
    )
    return [PROJECT_ROOT / value.decode("utf-8") for value in result.stdout.split(b"\0") if value]


def is_placeholder(value: str) -> bool:
    normalized = value.strip().lower()
    return (
        not normalized
        or normalized in KNOWN_TEST_VALUES
        or any(marker in normalized for marker in PLACEHOLDERS)
    )


def main() -> int:
    findings: list[tuple[str, int, str]] = []
    for path in tracked_files():
        if path.suffix.lower() in SKIP_SUFFIXES:
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for line_number, line in enumerate(text.splitlines(), start=1):
            for finding_type, pattern in PATTERNS.items():
                for match in pattern.finditer(line):
                    candidate = match.group(1) if match.lastindex else match.group(0)
                    if not is_placeholder(candidate):
                        findings.append((str(path.relative_to(PROJECT_ROOT)), line_number, finding_type))

    if findings:
        print("Tracked credential scan failed:")
        for path, line_number, finding_type in findings:
            print(f"- {path}:{line_number} ({finding_type})")
        print("Values are intentionally omitted from this report.")
        return 1
    print("Tracked credential scan passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
