#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python="$project_root/.venv/bin/python"

cd "$project_root"
"$python" -m pip_audit --local --progress-spinner=off
"$python" -m piplicenses \
  --partial-match \
  --fail-on "GNU General Public License;GNU Affero General Public License;GPL;AGPL;SSPL;Business Source License" \
  >/dev/null
"$python" "$project_root/scripts/check-frontend-licenses.py"

cd "$project_root/frontend"
npm audit --audit-level=high
