#!/usr/bin/env bash
# 安装/卸载 Chat 的 Mac 常驻服务（拓扑A）：
#   com.later.chat.production   Chat 完整栈（Workbench 关闭）
#   com.later.chat.cloud-relay  云端反向隧道
# 只渲染 plist 模板并 bootstrap/botstrap LaunchAgent；不读取或打印任何凭据。

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cloud_host="121.43.113.236"
remote_port="33051"
local_port="43110"
log_dir="$HOME/Library/Logs/chat"
launch_agents="$HOME/Library/LaunchAgents"
uid="$(id -u)"

usage() {
  cat >&2 <<'USAGE'
Usage: install-chat-production.sh <install|uninstall|status> [--cloud-host H] [--remote-port P] [--local-port P]
USAGE
  exit 2
}

action="${1:-}"; shift || true
case "$action" in install|uninstall|status) ;; *) usage ;; esac
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --cloud-host) cloud_host="$2"; shift 2 ;;
    --remote-port) remote_port="$2"; shift 2 ;;
    --local-port) local_port="$2"; shift 2 ;;
    *) usage ;;
  esac
done

node_bin="$(command -v node)" || { echo "node 不在 PATH" >&2; exit 1; }
node_dir="$(dirname "$node_bin")"

render() {
  local template="$1" target="$2"
  sed \
    -e "s|__PROJECT_ROOT__|$repo_root|g" \
    -e "s|__NODE_BIN__|$node_bin|g" \
    -e "s|__NODE_DIR__|$node_dir|g" \
    -e "s|__USER_HOME__|$HOME|g" \
    -e "s|__LOG_DIR__|$log_dir|g" \
    -e "s|__CLOUD_HOST__|$cloud_host|g" \
    -e "s|__REMOTE_PORT__|$remote_port|g" \
    -e "s|__LOCAL_PORT__|$local_port|g" \
    "$template" > "$target"
}

labels=(com.later.chat.production com.later.chat.cloud-relay)

case "$action" in
  install)
    # 前置防线：.env 必须具备服务器模式配置，认证文件必须存在。
    grep -q "^CHAT_PUBLIC_WEB_HOSTNAME=" "$repo_root/.env" \
      || { echo ".env 缺少 CHAT_PUBLIC_WEB_HOSTNAME" >&2; exit 1; }
    grep -q "^CHAT_WEB_AUTH_REQUIRED=1" "$repo_root/.env" \
      || { echo ".env 缺少 CHAT_WEB_AUTH_REQUIRED=1" >&2; exit 1; }
    [[ -f "$repo_root/.data/web-auth/credentials.json" ]] \
      || { echo "缺少 .data/web-auth/credentials.json，先运行 init-chat-web-auth.mjs" >&2; exit 1; }
    [[ -f "$repo_root/.data/web-auth/session-secret" ]] \
      || { echo "缺少 .data/web-auth/session-secret，先运行 init-chat-web-auth.mjs" >&2; exit 1; }
    mkdir -p "$log_dir" "$launch_agents"
    chmod +x "$repo_root/scripts/service/run-chat-cloud-relay.sh"
    for label in "${labels[@]}"; do
      render "$repo_root/deploy/macos/$label.plist.in" "$launch_agents/$label.plist"
      launchctl bootstrap "gui/$uid" "$launch_agents/$label.plist" 2>/dev/null \
        || launchctl kickstart -k "gui/$uid/$label"
      echo "已安装并启动 $label"
    done
    ;;
  uninstall)
    for label in "${labels[@]}"; do
      launchctl bootout "gui/$uid/$label" 2>/dev/null && echo "已停止 $label" || true
      rm -f "$launch_agents/$label.plist"
    done
    ;;
  status)
    for label in "${labels[@]}"; do
      if launchctl print "gui/$uid/$label" >/dev/null 2>&1; then
        echo "$label: loaded"
      else
        echo "$label: not-loaded"
      fi
    done
    /usr/bin/curl --fail --silent --max-time 3 "http://127.0.0.1:$local_port/healthz" \
      && echo " <- gateway healthz" || echo "gateway healthz: unreachable"
    ;;
esac
