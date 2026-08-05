#!/usr/bin/env python3
"""Archive every page in OMIMO's official Simplified Chinese sitemap.

The script delegates page extraction and media localization to the project's
configured baoyu-url-to-markdown reader. It then rewrites links between archived
Chinese pages to local relative paths and emits a checksum manifest.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from urllib.parse import urldefrag, urlparse

SITEMAP_URL = "https://omimo.org/zh-hans/sitemap.xml"
SITE_PREFIX = "https://omimo.org/zh-hans/"
FIRST_PARTY_ASSET_URLS = (
    "https://omimo.org/zh-hans/modules/p3.express/manual/v2/project-description.odt",
    "https://omimo.org/zh-hans/modules/p3.express/manual/v2/follow-up-register.ods",
    "https://omimo.org/zh-hans/modules/p3.express/manual/v2/health-register.ods",
)
DEFAULT_READER = (
    Path.home()
    / ".codex/skills/baoyu-url-to-markdown/scripts/baoyu-fetch"
)
FAILURE_MARKERS = (
    "application error",
    "this page could not be found",
    "sign in to continue",
    "verify you are human",
)


@dataclass(frozen=True)
class CaptureTarget:
    url: str
    output_path: Path


@dataclass(frozen=True)
class AssetTarget:
    url: str
    output_path: Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output-root",
        type=Path,
        default=Path("docs/references/omimo/omimo.org"),
        help="Mirror root inside the current repository",
    )
    parser.add_argument(
        "--reader",
        type=Path,
        default=DEFAULT_READER,
        help="Path to the baoyu-fetch launcher",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=3,
        help="Maximum concurrent page captures",
    )
    parser.add_argument(
        "--force",
        action="store_true",
        help="Recapture pages that already pass the quality gate",
    )
    return parser.parse_args()


def fetch_sitemap() -> tuple[bytes, list[str]]:
    request = urllib.request.Request(
        SITEMAP_URL,
        headers={"User-Agent": "Chat-OMIMO-Archiver/1.0"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read()
    root = ET.fromstring(payload)
    urls = [
        element.text.strip()
        for element in root.iter()
        if element.tag.endswith("loc") and element.text
    ]
    invalid = [url for url in urls if not url.startswith(SITE_PREFIX)]
    if invalid:
        raise RuntimeError(f"Sitemap contains URLs outside {SITE_PREFIX}: {invalid}")
    if not urls:
        raise RuntimeError("Simplified Chinese sitemap contains no URLs")
    if len(urls) != len(set(urls)):
        raise RuntimeError("Simplified Chinese sitemap contains duplicate URLs")
    return payload, urls


def output_path_for_url(output_root: Path, url: str) -> Path:
    path = urlparse(url).path.strip("/")
    if path == "zh-hans":
        return output_root / "zh-hans/index/index.md"
    return output_root / path / "index.md"


def asset_path_for_url(output_root: Path, url: str) -> Path:
    return output_root / urlparse(url).path.strip("/")


def split_frontmatter(markdown: str) -> tuple[str, str]:
    if not markdown.startswith("---\n"):
        return "", markdown
    closing = markdown.find("\n---\n", 4)
    if closing == -1:
        return "", markdown
    boundary = closing + len("\n---\n")
    return markdown[:boundary], markdown[boundary:]


def frontmatter_value(markdown: str, key: str) -> str | None:
    header, _ = split_frontmatter(markdown)
    match = re.search(rf'^{re.escape(key)}:\s*"?(.*?)"?\s*$', header, re.MULTILINE)
    return match.group(1).rstrip('"') if match else None


def validate_markdown(target: CaptureTarget) -> tuple[bool, str]:
    if not target.output_path.is_file():
        return False, "output file is missing"
    markdown = target.output_path.read_text(encoding="utf-8")
    title = frontmatter_value(markdown, "title")
    requested_url = frontmatter_value(markdown, "requestedUrl")
    _, body = split_frontmatter(markdown)
    if not title:
        return False, "frontmatter title is missing"
    if requested_url != target.url:
        return False, f"requestedUrl mismatch: {requested_url!r}"
    # Some legitimate OMIMO activity pages are deliberately concise. F05
    # ("庆祝！") is 297 characters after extraction, so 250 catches shells while
    # preserving that complete short chapter.
    if len(body.strip()) < 250:
        return False, f"body is suspiciously short ({len(body.strip())} chars)"
    if not re.search(r"[\u3400-\u9fff]", body):
        return False, "body contains no CJK text"
    lowered = body.lower()
    marker = next((item for item in FAILURE_MARKERS if item in lowered), None)
    if marker:
        return False, f"body contains failure marker: {marker}"
    return True, "ok"


def capture_page(target: CaptureTarget, reader: Path, force: bool) -> dict[str, str]:
    valid, reason = validate_markdown(target)
    if valid and not force:
        return {"url": target.url, "status": "skipped", "detail": reason}

    target.output_path.parent.mkdir(parents=True, exist_ok=True)
    command = [
        "sh",
        str(reader),
        target.url,
        "--adapter",
        "generic",
        "--output",
        str(target.output_path.resolve()),
        "--download-media",
    ]
    completed = subprocess.run(
        command,
        cwd=Path.cwd(),
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )
    valid, reason = validate_markdown(target)
    if completed.returncode != 0 or not valid:
        diagnostic = (completed.stderr or completed.stdout)[-4000:]
        return {
            "url": target.url,
            "status": "failed",
            "detail": f"exit={completed.returncode}; {reason}; {diagnostic}",
        }
    return {"url": target.url, "status": "captured", "detail": reason}


def canonical_url(url: str) -> str:
    parsed = urlparse(url)
    path = parsed.path
    if not path.endswith("/"):
        path += "/"
    return f"{parsed.scheme}://{parsed.netloc}{path}"


def download_assets(assets: list[AssetTarget]) -> None:
    for asset in assets:
        if asset.output_path.is_file() and asset.output_path.stat().st_size > 0:
            continue
        asset.output_path.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(
            asset.url,
            headers={"User-Agent": "Chat-OMIMO-Archiver/1.0"},
        )
        temporary_path = asset.output_path.with_suffix(asset.output_path.suffix + ".part")
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = response.read()
        if not payload:
            raise RuntimeError(f"Downloaded asset is empty: {asset.url}")
        temporary_path.write_bytes(payload)
        temporary_path.replace(asset.output_path)


def localize_internal_links(
    targets: list[CaptureTarget],
    assets: list[AssetTarget],
) -> None:
    path_by_url = {canonical_url(target.url): target.output_path for target in targets}
    asset_path_by_url = {asset.url: asset.output_path for asset in assets}

    def replace_url(raw_url: str, current_path: Path) -> str:
        base_url, fragment = urldefrag(raw_url)
        target_path = asset_path_by_url.get(base_url)
        if target_path is None:
            target_path = path_by_url.get(canonical_url(base_url))
        if target_path is None:
            return raw_url
        relative = os.path.relpath(target_path, current_path.parent)
        return f"{relative}#{fragment}" if fragment else relative

    markdown_link = re.compile(r"\((https://omimo\.org/zh-hans/[^\s)]+)\)")
    html_link = re.compile(r'href="(https://omimo\.org/zh-hans/[^"]+)"')

    for target in targets:
        markdown = target.output_path.read_text(encoding="utf-8")
        header, body = split_frontmatter(markdown)
        current_path = target.output_path
        body = markdown_link.sub(
            lambda match, path=current_path: f"({replace_url(match.group(1), path)})",
            body,
        )
        body = html_link.sub(
            lambda match, path=current_path: (
                f'href="{replace_url(match.group(1), path)}"'
            ),
            body,
        )
        updated = header + body
        if updated != markdown:
            target.output_path.write_text(updated, encoding="utf-8")


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_manifest(
    archive_root: Path,
    sitemap_payload: bytes,
    targets: list[CaptureTarget],
    assets: list[AssetTarget],
) -> dict[str, object]:
    pages = []
    for target in targets:
        markdown = target.output_path.read_text(encoding="utf-8")
        media = [
            path
            for directory_name in ("imgs", "videos")
            for path in (target.output_path.parent / directory_name).glob("**/*")
            if path.is_file()
        ]
        pages.append(
            {
                "url": target.url,
                "path": target.output_path.relative_to(archive_root).as_posix(),
                "title": frontmatter_value(markdown, "title"),
                "captured_at": frontmatter_value(markdown, "capturedAt"),
                "bytes": target.output_path.stat().st_size,
                "sha256": sha256_file(target.output_path),
                "media_files": len(media),
                "cjk_characters": len(re.findall(r"[\u3400-\u9fff]", markdown)),
            }
        )
    asset_entries = [
        {
            "url": asset.url,
            "path": asset.output_path.relative_to(archive_root).as_posix(),
            "bytes": asset.output_path.stat().st_size,
            "sha256": sha256_file(asset.output_path),
        }
        for asset in assets
    ]
    return {
        "schema_version": 1,
        "generated_at": datetime.now(UTC).isoformat(),
        "source_language": "zh-hans",
        "sitemap_url": SITEMAP_URL,
        "sitemap_sha256": hashlib.sha256(sitemap_payload).hexdigest(),
        "page_count": len(pages),
        "asset_count": len(asset_entries),
        "pages": pages,
        "assets": asset_entries,
    }


def write_markdown_index(archive_root: Path, manifest: dict[str, object]) -> None:
    grouped_pages: dict[str, list[dict[str, object]]] = {
        "站点首页": [],
        "项目方法全景": [],
        "NUPP 六项通用原则": [],
        "P3.express 项目管理方法": [],
    }
    for page in manifest["pages"]:  # type: ignore[index]
        url = str(page["url"])
        if url == SITE_PREFIX:
            group = "站点首页"
        elif "/modules/landscape/" in url:
            group = "项目方法全景"
        elif "/modules/nupp/" in url:
            group = "NUPP 六项通用原则"
        else:
            group = "P3.express 项目管理方法"
        grouped_pages[group].append(page)

    lines = [
        "# OMIMO 简体中文归档索引",
        "",
        "> 本文件由 `scripts/archive_omimo_zh_hans.py` 根据官方简体中文 Sitemap 自动生成。",
        "",
        f"- 官方 Sitemap：<{SITEMAP_URL}>",
        f"- 页面：{manifest['page_count']} 个",
        f"- 第一方附件：{manifest['asset_count']} 个",
        f"- 清单生成时间：`{manifest['generated_at']}`",
        "- 每页 frontmatter 保留原始 URL 与抓取时间；站内简体中文链接已改为本地相对链接。",
        "",
    ]
    for group_name, pages in grouped_pages.items():
        lines.extend([f"## {group_name}", ""])
        for page in pages:
            lines.append(f"- [{page['title']}]({page['path']})")
        lines.append("")

    lines.extend(
        [
            "## 第一方附件",
            "",
            *[
                f"- [{Path(str(asset['path'])).name}]({asset['path']})"
                for asset in manifest["assets"]  # type: ignore[index]
            ],
            "",
        ]
    )
    (archive_root / "archive-index.md").write_text(
        "\n".join(lines),
        encoding="utf-8",
    )


def main() -> int:
    args = parse_args()
    if args.workers < 1:
        raise SystemExit("--workers must be at least 1")
    if not args.reader.is_file():
        raise SystemExit(f"baoyu-fetch launcher not found: {args.reader}")

    sitemap_payload, urls = fetch_sitemap()
    output_root = args.output_root.resolve()
    targets = [
        CaptureTarget(url=url, output_path=output_path_for_url(output_root, url))
        for url in urls
    ]
    assets = [
        AssetTarget(url=url, output_path=asset_path_for_url(output_root, url))
        for url in FIRST_PARTY_ASSET_URLS
    ]

    results: list[dict[str, str]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(capture_page, target, args.reader, args.force): target
            for target in targets
        }
        for completed_count, future in enumerate(
            concurrent.futures.as_completed(futures), start=1
        ):
            result = future.result()
            results.append(result)
            print(
                f"[{completed_count:02d}/{len(targets):02d}] "
                f"{result['status']:8s} {result['url']}",
                flush=True,
            )

    failures = [result for result in results if result["status"] == "failed"]
    if failures:
        for failure in failures:
            print(f"FAILED {failure['url']}: {failure['detail']}", file=sys.stderr)
        return 1

    download_assets(assets)
    localize_internal_links(targets, assets)
    for target in targets:
        valid, reason = validate_markdown(target)
        if not valid:
            print(f"FAILED quality gate {target.url}: {reason}", file=sys.stderr)
            return 1

    archive_root = output_root.parent
    manifest = build_manifest(archive_root, sitemap_payload, targets, assets)
    manifest_path = archive_root / "archive-manifest.json"
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    write_markdown_index(archive_root, manifest)
    print(
        f"Archived {len(targets)} pages and {len(assets)} assets; "
        f"manifest: {manifest_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
