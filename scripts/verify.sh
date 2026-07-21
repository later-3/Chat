#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$project_root"
uv run python -m compileall -q backend
uv run pytest

cd "$project_root/frontend"
npm run typecheck
npm run build
