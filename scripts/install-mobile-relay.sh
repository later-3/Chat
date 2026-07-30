#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cloud_host="${CHAT_CLOUD_HOST:-121.43.113.236}"
local_port="${CHAT_LOCAL_PORT:-18030}"
remote_port="${CHAT_RELAY_PORT:-4620}"
user_name="$(id -un)"
user_id="$(id -u)"
user_home="$(/usr/bin/dscl . -read "/Users/$user_name" NFSHomeDirectory | /usr/bin/awk '{print $2}')"
launch_agents_dir="$user_home/Library/LaunchAgents"
state_dir="$project_root/backend/.data/deployment"
log_dir="$project_root/backend/.data/logs/mobile-relay"
backend_plist="$launch_agents_dir/com.later.chat.backend.plist"
relay_plist="$launch_agents_dir/com.later.chat.cloud-relay.plist"
backend_label="com.later.chat.backend"
relay_label="com.later.chat.cloud-relay"
launch_domain="gui/$user_id"

usage() {
  echo "usage: $0 [--cloud-host HOST] [--local-port PORT] [--remote-port PORT]" >&2
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --cloud-host)
      cloud_host="${2:-}"
      shift 2
      ;;
    --local-port)
      local_port="${2:-}"
      shift 2
      ;;
    --remote-port)
      remote_port="${2:-}"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [[ ! "$cloud_host" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "invalid cloud host: $cloud_host" >&2
  exit 2
fi
for port in "$local_port" "$remote_port"; do
  if [[ ! "$port" =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
    echo "invalid unprivileged port: $port" >&2
    exit 2
  fi
done
if [[ ! -x "$project_root/.venv/bin/python" ]]; then
  echo "project virtual environment is missing: $project_root/.venv/bin/python" >&2
  exit 2
fi
if [[ ! -s "$project_root/backend/config.json" ]]; then
  echo "private backend config is missing: $project_root/backend/config.json" >&2
  exit 2
fi

mkdir -p "$launch_agents_dir" "$state_dir" "$log_dir"
chmod 700 "$state_dir" "$log_dir"

# Stop only the two exact Chat jobs before replacing their definitions.
launchctl bootout "$launch_domain/$relay_label" 2>/dev/null || true
launchctl bootout "$launch_domain/$backend_label" 2>/dev/null || true

if ! /usr/bin/ssh \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes \
  "root@$cloud_host" true; then
  echo "passwordless SSH or the pinned host key is unavailable for root@$cloud_host" >&2
  exit 3
fi

if /usr/bin/ssh \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes \
  "root@$cloud_host" \
  "ss -ltnH 'sport = :$remote_port' | grep -q ."; then
  echo "remote loopback port is already in use: $remote_port" >&2
  exit 3
fi

escape_sed_replacement() {
  printf '%s' "$1" | /usr/bin/sed 's/[&|\\]/\\&/g'
}

escaped_project_root="$(escape_sed_replacement "$project_root")"
escaped_log_dir="$(escape_sed_replacement "$log_dir")"
escaped_cloud_host="$(escape_sed_replacement "$cloud_host")"

/usr/bin/sed \
  -e "s|__PROJECT_ROOT__|$escaped_project_root|g" \
  -e "s|__LOG_DIR__|$escaped_log_dir|g" \
  -e "s|__LOCAL_PORT__|$local_port|g" \
  "$project_root/deploy/macos/com.later.chat.backend.plist.in" >"$backend_plist"

/usr/bin/sed \
  -e "s|__LOG_DIR__|$escaped_log_dir|g" \
  -e "s|__CLOUD_HOST__|$escaped_cloud_host|g" \
  -e "s|__LOCAL_PORT__|$local_port|g" \
  -e "s|__REMOTE_PORT__|$remote_port|g" \
  "$project_root/deploy/macos/com.later.chat.cloud-relay.plist.in" >"$relay_plist"

chmod 600 "$backend_plist" "$relay_plist"
/usr/bin/plutil -lint "$backend_plist" >/dev/null
/usr/bin/plutil -lint "$relay_plist" >/dev/null

launchctl bootstrap "$launch_domain" "$backend_plist"

backend_ready="false"
for _attempt in {1..30}; do
  if /usr/bin/curl --fail --silent \
    "http://127.0.0.1:$local_port/api/ready" >/dev/null; then
    backend_ready="true"
    break
  fi
  sleep 1
done
if [[ "$backend_ready" != "true" ]]; then
  echo "Chat backend did not become ready; inspect $log_dir/backend.stderr.log" >&2
  exit 4
fi

launchctl bootstrap "$launch_domain" "$relay_plist"

relay_ready="false"
for _attempt in {1..20}; do
  if /usr/bin/ssh \
    -o BatchMode=yes \
    -o ConnectTimeout=10 \
    -o StrictHostKeyChecking=yes \
    "root@$cloud_host" \
    "curl --fail --silent http://127.0.0.1:$remote_port/api/ready >/dev/null"; then
    relay_ready="true"
    break
  fi
  sleep 1
done
if [[ "$relay_ready" != "true" ]]; then
  echo "reverse relay did not become ready; inspect $log_dir/cloud-relay.stderr.log" >&2
  exit 4
fi

{
  printf 'cloud_host=%s\n' "$cloud_host"
  printf 'local_port=%s\n' "$local_port"
  printf 'remote_port=%s\n' "$remote_port"
  printf 'installed_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$state_dir/mobile-relay.env"
chmod 600 "$state_dir/mobile-relay.env"

echo "Chat backend and cloud relay are ready."
echo "Local readiness: http://127.0.0.1:$local_port/api/ready"
echo "Cloud loopback readiness: http://127.0.0.1:$remote_port/api/ready"
