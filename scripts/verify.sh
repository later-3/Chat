#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python="$project_root/.venv/bin/python"

cd "$project_root"
"$python" "$project_root/概念空间/验证概念空间.py"
"$python" "$project_root/scripts/check-project-docs.py"
"$python" "$project_root/scripts/check-tracked-secrets.py"
git diff --check
"$python" -m ruff format --check backend
"$python" -m ruff check backend
"$python" -m pyright
"$python" -m compileall -q backend
"$python" -m pytest --cov=backend.app --cov-report=term-missing --cov-report=xml:coverage.xml
"$project_root/scripts/verify-migrations.sh"

cd "$project_root/frontend"
npm run check
npm run test:coverage
npm run typecheck
npm run build
"$python" "$project_root/scripts/check-frontend-bundle.py"
npm run test:e2e
