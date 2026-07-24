#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cloud_host="${CHAT_CLOUD_HOST:-121.43.113.236}"
nginx_site="${CHAT_NGINX_SITE:-/etc/nginx/sites-available/audittraceai-demo}"
state_dir="$project_root/backend/.data/deployment"
password_file="$state_dir/chat-http-access-password"
release_id="$(date -u +%Y%m%dT%H%M%SZ)"
archive="$(mktemp "/tmp/chat-web-$release_id.XXXXXX.tar.gz")"
htpasswd="$(mktemp "/tmp/chat-htpasswd-$release_id.XXXXXX")"
remote_archive="/tmp/chat-web-$release_id.tar.gz"
remote_snippet="/tmp/chat-locations-$release_id.conf"
remote_htpasswd="/tmp/chat-htpasswd-$release_id"

cleanup() {
  rm -f "$archive" "$htpasswd"
}
trap cleanup EXIT

if [[ ! "$cloud_host" =~ ^[A-Za-z0-9.-]+$ ]]; then
  echo "invalid cloud host: $cloud_host" >&2
  exit 2
fi
if [[ ! "$nginx_site" =~ ^/etc/nginx/sites-available/[A-Za-z0-9._-]+$ ]]; then
  echo "invalid nginx site path: $nginx_site" >&2
  exit 2
fi
if [[ ! -x "$project_root/.venv/bin/python" ]]; then
  echo "project virtual environment is missing" >&2
  exit 2
fi

mkdir -p "$state_dir"
chmod 700 "$state_dir"
if [[ ! -s "$password_file" ]]; then
  (
    umask 077
    /usr/bin/openssl rand -base64 24 | tr -d '\n' >"$password_file"
    printf '\n' >>"$password_file"
  )
  chmod 600 "$password_file"
fi

password_hash="$(/usr/bin/openssl passwd -apr1 -stdin <"$password_file")"
printf 'later:%s\n' "$password_hash" >"$htpasswd"
chmod 600 "$htpasswd"

(
  cd "$project_root/frontend"
  VITE_WEB_BASE_PATH=/chat/ VITE_API_BASE_URL=/chat-api npm run build
)
"$project_root/.venv/bin/python" "$project_root/scripts/check-frontend-bundle.py"
COPYFILE_DISABLE=1 tar --no-xattrs -czf "$archive" -C "$project_root/frontend/dist" .

/usr/bin/scp \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes \
  "$archive" "root@$cloud_host:$remote_archive"
/usr/bin/scp \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes \
  "$project_root/deploy/nginx/chat-locations.conf" \
  "root@$cloud_host:$remote_snippet"
/usr/bin/scp \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes \
  "$htpasswd" "root@$cloud_host:$remote_htpasswd"

/usr/bin/ssh \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o StrictHostKeyChecking=yes \
  "root@$cloud_host" \
  "bash -s -- '$release_id' '$nginx_site'" \
  <"$project_root/deploy/server/install-chat-relay.sh"

printf '%s\n' "$release_id" >"$state_dir/mobile-web-release"
chmod 600 "$state_dir/mobile-web-release"

echo "Chat web release deployed: $release_id"
echo "Public entry: http://$cloud_host/chat/"
