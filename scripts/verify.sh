#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$project_root"
"$project_root/.venv/bin/python" "$project_root/概念空间/验证概念空间.py"
uv run python -m compileall -q backend
uv run pytest

cd "$project_root/frontend"
npm run test
npm run typecheck
npm run build
