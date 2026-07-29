#!/usr/bin/env bash
set -euo pipefail

# Chat uses the source checkout directly so changes inside pi can be built and
# debugged before publishing an npm package. Override these only when moving the
# local checkout or when the same-version installed package lives elsewhere.
PI_SOURCE_ROOT="${PI_SOURCE_ROOT:-/Users/xulater/Code/opc-os/pi}"
PI_INSTALLED_ROOT="${PI_INSTALLED_ROOT:-/Users/xulater/.local/lib/node_modules/@earendil-works/pi-coding-agent}"

cd "$PI_SOURCE_ROOT"

if ! npm run hydrate:model-data; then
  SOURCE_VERSION="$(node -p "require('./packages/coding-agent/package.json').version")"
  INSTALLED_VERSION="$(node -p "require('$PI_INSTALLED_ROOT/package.json').version")"
  FALLBACK_DATA="$PI_INSTALLED_ROOT/node_modules/@earendil-works/pi-ai/dist/providers/data"
  if [[ "$SOURCE_VERSION" != "$INSTALLED_VERSION" || ! -f "$FALLBACK_DATA/.manifest.json" ]]; then
    echo "pi模型数据在线水合失败，且没有同版本本地数据可回退。" >&2
    exit 1
  fi
  mkdir -p packages/ai/src/providers/data
  cp -R "$FALLBACK_DATA"/. packages/ai/src/providers/data/
fi

npm run build:offline

CLI="$PI_SOURCE_ROOT/packages/coding-agent/dist/cli.js"
SOURCE_MAP="$CLI.map"
test -x "$CLI"
test -f "$SOURCE_MAP"
node "$CLI" --version
