#!/usr/bin/env python3
"""Verify the OMIMO archive manifest, local links, and first-party assets."""

from __future__ import annotations

import hashlib
import json
import re
import sys
import zipfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

ARCHIVE_ROOT = Path("docs/references/omimo")
MIRROR_ROOT = ARCHIVE_ROOT / "omimo.org/zh-hans"
MANIFEST_PATH = ARCHIVE_ROOT / "archive-manifest.json"
EXPECTED_PAGE_COUNT = 49
EXPECTED_ASSET_COUNT = 3
EXPECTED_MIME_TYPES = {
    ".odt": "application/vnd.oasis.opendocument.text",
    ".ods": "application/vnd.oasis.opendocument.spreadsheet",
}
MARKDOWN_LINK = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
HTML_LINK = re.compile(r'href="([^"]+)"')


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def split_frontmatter(markdown: str) -> tuple[str, str]:
    if not markdown.startswith("---\n"):
        return "", markdown
    closing = markdown.find("\n---\n", 4)
    if closing == -1:
        return "", markdown
    boundary = closing + len("\n---\n")
    return markdown[:boundary], markdown[boundary:]


def verify_manifest() -> list[str]:
    errors: list[str] = []
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    pages = manifest.get("pages", [])
    assets = manifest.get("assets", [])
    if manifest.get("page_count") != EXPECTED_PAGE_COUNT or len(pages) != EXPECTED_PAGE_COUNT:
        errors.append(
            f"Expected {EXPECTED_PAGE_COUNT} pages, got "
            f"manifest={manifest.get('page_count')} entries={len(pages)}"
        )
    if manifest.get("asset_count") != EXPECTED_ASSET_COUNT or len(assets) != EXPECTED_ASSET_COUNT:
        errors.append(
            f"Expected {EXPECTED_ASSET_COUNT} assets, got "
            f"manifest={manifest.get('asset_count')} entries={len(assets)}"
        )

    recorded_paths: set[str] = set()
    for entry in [*pages, *assets]:
        relative_path = str(entry["path"])
        if relative_path in recorded_paths:
            errors.append(f"Duplicate manifest path: {relative_path}")
            continue
        recorded_paths.add(relative_path)
        path = ARCHIVE_ROOT / relative_path
        if not path.is_file():
            errors.append(f"Manifest file is missing: {path}")
            continue
        actual_size = path.stat().st_size
        if actual_size != entry["bytes"]:
            errors.append(
                f"Size mismatch for {path}: expected {entry['bytes']}, got {actual_size}"
            )
        actual_hash = sha256_file(path)
        if actual_hash != entry["sha256"]:
            errors.append(
                f"SHA-256 mismatch for {path}: expected {entry['sha256']}, got {actual_hash}"
            )

    actual_pages = sorted(MIRROR_ROOT.glob("**/index.md"))
    if len(actual_pages) != EXPECTED_PAGE_COUNT:
        errors.append(
            f"Mirror contains {len(actual_pages)} index.md files, "
            f"expected {EXPECTED_PAGE_COUNT}"
        )
    return errors


def verify_open_document_assets() -> list[str]:
    errors: list[str] = []
    for suffix, expected_mimetype in EXPECTED_MIME_TYPES.items():
        for path in MIRROR_ROOT.glob(f"**/*{suffix}"):
            if not zipfile.is_zipfile(path):
                errors.append(f"OpenDocument asset is not a ZIP container: {path}")
                continue
            with zipfile.ZipFile(path) as archive:
                try:
                    mimetype = archive.read("mimetype").decode("ascii")
                except KeyError:
                    errors.append(f"OpenDocument mimetype entry is missing: {path}")
                    continue
            if mimetype != expected_mimetype:
                errors.append(
                    f"Unexpected mimetype for {path}: {mimetype!r}, "
                    f"expected {expected_mimetype!r}"
                )
    asset_count = sum(1 for suffix in EXPECTED_MIME_TYPES for _ in MIRROR_ROOT.glob(f"**/*{suffix}"))
    if asset_count != EXPECTED_ASSET_COUNT:
        errors.append(
            f"Found {asset_count} OpenDocument assets, expected {EXPECTED_ASSET_COUNT}"
        )
    return errors


def local_path_from_target(markdown_path: Path, raw_target: str) -> Path | None:
    target = raw_target.strip()
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1]
    if " \"" in target:
        target = target.split(" \"", 1)[0]
    parsed = urlsplit(target)
    if parsed.scheme or parsed.netloc or not parsed.path:
        return None
    return (markdown_path.parent / unquote(parsed.path)).resolve()


def verify_markdown_links() -> list[str]:
    errors: list[str] = []
    repository_root = Path.cwd().resolve()
    for markdown_path in sorted(ARCHIVE_ROOT.glob("**/*.md")):
        markdown = markdown_path.read_text(encoding="utf-8")
        link_targets = [
            match.group(1)
            for pattern in (MARKDOWN_LINK, HTML_LINK)
            for match in pattern.finditer(markdown)
        ]
        for target in link_targets:
            local_path = local_path_from_target(markdown_path, target)
            if local_path is None:
                continue
            try:
                local_path.relative_to(repository_root)
            except ValueError:
                errors.append(
                    f"Local link escapes repository: {markdown_path} -> {target}"
                )
                continue
            if not local_path.exists():
                errors.append(f"Broken local link: {markdown_path} -> {target}")

        if markdown_path.is_relative_to(MIRROR_ROOT):
            _, body = split_frontmatter(markdown)
            if "https://omimo.org/zh-hans/" in body:
                errors.append(
                    f"Archived page still contains a remote zh-hans link: {markdown_path}"
                )
    return errors


def main() -> int:
    if not MANIFEST_PATH.is_file():
        print(f"Missing manifest: {MANIFEST_PATH}", file=sys.stderr)
        return 1
    errors = [
        *verify_manifest(),
        *verify_open_document_assets(),
        *verify_markdown_links(),
    ]
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        print(f"OMIMO archive verification failed with {len(errors)} error(s).")
        return 1
    print(
        "OMIMO archive verified: "
        f"{EXPECTED_PAGE_COUNT} pages, {EXPECTED_ASSET_COUNT} assets, "
        "checksums valid, local links intact."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
