#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cloud_host="${CHAT_CLOUD_HOST:-121.43.113.236}"
local_port="${CHAT_LOCAL_PORT:-8030}"
remote_port="${CHAT_RELAY_PORT:-4620}"
public_url="${CHAT_PUBLIC_URL:-http://$cloud_host/chat/}"
public_api_url="${CHAT_PUBLIC_API_URL:-http://$cloud_host/chat-api}"
auth_reentry_url="${CHAT_AUTH_REENTRY_URL:-http://$cloud_host/chat/auth-refresh.html}"
state_dir="$project_root/backend/.data/deployment"
password_file="$state_dir/chat-http-access-password"
user_id="$(id -u)"

if [[ ! "$cloud_host" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "invalid cloud host: $cloud_host" >&2
  exit 2
fi
for port in "$local_port" "$remote_port"; do
  if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
    echo "invalid port: $port" >&2
    exit 2
  fi
done
if [[ ! -s "$password_file" ]]; then
  echo "HTTP access password is missing: $password_file" >&2
  exit 2
fi

launchctl print "gui/$user_id/com.later.chat.backend" >/dev/null
launchctl print "gui/$user_id/com.later.chat.cloud-relay" >/dev/null
/usr/bin/curl --fail --silent --show-error \
  "http://127.0.0.1:$local_port/api/ready" >/dev/null
/usr/bin/ssh \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes \
  "root@$cloud_host" \
  "curl --fail --silent --show-error http://127.0.0.1:$remote_port/api/ready >/dev/null"

status_without_credentials="$(
  /usr/bin/curl --silent --output /dev/null --write-out '%{http_code}' "$public_url"
)"
if [[ "$status_without_credentials" != "401" ]]; then
  echo "expected unauthenticated public request to return 401, got $status_without_credentials" >&2
  exit 4
fi
auth_status_without_credentials="$(
  /usr/bin/curl --silent --output /dev/null --write-out '%{http_code}' "$auth_reentry_url"
)"
if [[ "$auth_status_without_credentials" != "401" ]]; then
  echo "expected unauthenticated auth re-entry to return 401, got $auth_status_without_credentials" >&2
  exit 4
fi

/usr/bin/curl --fail --silent --show-error \
  --user "later:$(<"$password_file")" \
  "$public_url" >/dev/null
/usr/bin/curl --fail --silent --show-error \
  --user "later:$(<"$password_file")" \
  "${public_api_url%/}/api/ready" >/dev/null
auth_reentry_headers="$(
  /usr/bin/curl --fail --silent --show-error \
    --dump-header - \
    --output /dev/null \
    --user "later:$(<"$password_file")" \
    "$auth_reentry_url"
)"
if ! /usr/bin/grep -qi '^Cache-Control: no-store' <<<"$auth_reentry_headers"; then
  echo "auth re-entry must be served with Cache-Control: no-store" >&2
  exit 4
fi

echo "Mobile relay verification passed."
