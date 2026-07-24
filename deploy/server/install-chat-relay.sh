#!/usr/bin/env bash
set -euo pipefail

# Runs as root on the relay server. The caller uploads all three staging files
# before invoking this script:
#   /tmp/chat-web-<release>.tar.gz
#   /tmp/chat-locations-<release>.conf
#   /tmp/chat-htpasswd-<release>

if [[ "$#" -ne 2 ]]; then
  echo "usage: install-chat-relay.sh <release-id> <nginx-site-path>" >&2
  exit 2
fi

release_id="$1"
nginx_site="$2"

if [[ ! "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
  echo "invalid release id: $release_id" >&2
  exit 2
fi
if [[ ! "$nginx_site" =~ ^/etc/nginx/sites-available/[A-Za-z0-9._-]+$ ]]; then
  echo "invalid nginx site path: $nginx_site" >&2
  exit 2
fi
if [[ ! -f "$nginx_site" ]]; then
  echo "nginx site does not exist: $nginx_site" >&2
  exit 2
fi

archive="/tmp/chat-web-$release_id.tar.gz"
staged_snippet="/tmp/chat-locations-$release_id.conf"
staged_htpasswd="/tmp/chat-htpasswd-$release_id"
release_dir="/opt/chat/releases/$release_id"
current_link="/opt/chat/current"
snippet="/etc/nginx/snippets/chat-locations.conf"
htpasswd="/etc/nginx/chat.htpasswd"
backup_dir="/var/backups/chat/$release_id"
include_line="    include /etc/nginx/snippets/chat-locations.conf;"

for staged_file in "$archive" "$staged_snippet" "$staged_htpasswd"; do
  if [[ ! -s "$staged_file" ]]; then
    echo "missing or empty staging file: $staged_file" >&2
    exit 2
  fi
done
if [[ -e "$release_dir" ]]; then
  echo "release already exists: $release_dir" >&2
  exit 2
fi

mkdir -p /opt/chat/releases "$backup_dir"
install -m 0600 "$nginx_site" "$backup_dir/nginx-site.before"
if [[ -e "$snippet" ]]; then
  install -m 0600 "$snippet" "$backup_dir/chat-locations.before"
  touch "$backup_dir/snippet-existed"
fi
if [[ -e "$htpasswd" ]]; then
  install -m 0600 "$htpasswd" "$backup_dir/chat.htpasswd.before"
  touch "$backup_dir/htpasswd-existed"
fi
if [[ -L "$current_link" ]]; then
  readlink "$current_link" >"$backup_dir/current-target.before"
fi

rollback() {
  install -m 0644 "$backup_dir/nginx-site.before" "$nginx_site"
  if [[ -e "$backup_dir/snippet-existed" ]]; then
    install -m 0644 "$backup_dir/chat-locations.before" "$snippet"
  else
    rm -f "$snippet"
  fi
  if [[ -e "$backup_dir/htpasswd-existed" ]]; then
    install -o root -g www-data -m 0640 "$backup_dir/chat.htpasswd.before" "$htpasswd"
  else
    rm -f "$htpasswd"
  fi
  if [[ -s "$backup_dir/current-target.before" ]]; then
    ln -sfn "$(cat "$backup_dir/current-target.before")" "$current_link"
  else
    rm -f "$current_link"
  fi
}

trap 'rollback' ERR

mkdir -p "$release_dir/web"
tar -xzf "$archive" -C "$release_dir/web"
test -s "$release_dir/web/index.html"
chown -R root:root "$release_dir"
find "$release_dir" -type d -exec chmod 0755 {} +
find "$release_dir/web" -type f -exec chmod 0644 {} +

install -o root -g root -m 0644 "$staged_snippet" "$snippet"
# Nginx workers run as www-data and must be able to read the credential file.
install -o root -g www-data -m 0640 "$staged_htpasswd" "$htpasswd"

if ! grep -Fq "$include_line" "$nginx_site"; then
  if [[ "$(tail -n 1 "$nginx_site" | tr -d '[:space:]')" != "}" ]]; then
    echo "refusing to edit nginx site without a final server brace" >&2
    exit 3
  fi
  edited_site="$(mktemp /etc/nginx/sites-available/chat-site.XXXXXX)"
  sed "\$i\\
$include_line" "$nginx_site" >"$edited_site"
  install -o root -g root -m 0644 "$edited_site" "$nginx_site"
  rm -f "$edited_site"
fi

ln -sfn "$release_dir" "$current_link.next"
mv -Tf "$current_link.next" "$current_link"

nginx -t
systemctl reload nginx

trap - ERR
rm -f "$archive" "$staged_snippet" "$staged_htpasswd"

echo "chat_release=$release_id"
echo "chat_current=$(readlink -f "$current_link")"
