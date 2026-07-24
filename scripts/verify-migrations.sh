#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
migration_workspace="$(mktemp -d "${TMPDIR:-/tmp}/chat-migrations.XXXXXX")"
trap 'rm -rf "$migration_workspace"' EXIT

database_url="sqlite+aiosqlite:///$migration_workspace/product-store.db"
python="$project_root/.venv/bin/python"

cd "$project_root"
"$python" -m alembic -x "database_url=$database_url" upgrade head
"$python" -m alembic -x "database_url=$database_url" check
"$python" -m alembic -x "database_url=$database_url" downgrade base
"$python" -m alembic -x "database_url=$database_url" upgrade head
