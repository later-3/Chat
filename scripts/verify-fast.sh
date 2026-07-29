#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python="$project_root/.venv/bin/python"

cd "$project_root"
"$python" "$project_root/概念空间/验证概念空间.py"
"$python" "$project_root/scripts/check-project-mastery.py"
"$python" "$project_root/scripts/check-project-docs.py"
"$python" "$project_root/scripts/check-tracked-secrets.py"
git diff --check
"$python" -m ruff format --check backend
"$python" -m ruff check backend
"$python" -m pyright
"$python" -m compileall -q backend
"$python" -m pytest

cd "$project_root/frontend"
npm run check
npm run test
npm run typecheck
