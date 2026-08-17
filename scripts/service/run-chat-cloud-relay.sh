#!/usr/bin/env bash
# Chat 云端反向隧道（拓扑A）：把云端 127.0.0.1:<remote-port> 转发到本机
# 127.0.0.1:<local-port> 的 Chat Web 网关。语义与 pi-web relay 一致：
# 预检本地健康 → 保留仍健康的云端 listener → 只回收 sshd 持有的失效 listener
# → ExitOnForwardFailure 建立新隧道。绝不终止未知属主进程。

set -euo pipefail

cloud_host="121.43.113.236"
remote_port="33051"
local_port="43110"
health_path="/healthz"

usage() {
  echo "Usage: $0 [--cloud-host HOST] [--remote-port PORT] [--local-port PORT]" >&2
  exit 2
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --cloud-host) [[ "$#" -ge 2 ]] || usage; cloud_host="$2"; shift 2 ;;
    --remote-port) [[ "$#" -ge 2 ]] || usage; remote_port="$2"; shift 2 ;;
    --local-port) [[ "$#" -ge 2 ]] || usage; local_port="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[[ "$cloud_host" =~ ^[A-Za-z0-9.-]+$ ]] || usage
[[ "$remote_port" =~ ^[0-9]+$ && "$remote_port" -ge 1 && "$remote_port" -le 65535 ]] || usage
[[ "$local_port" =~ ^[0-9]+$ && "$local_port" -ge 1 && "$local_port" -le 65535 ]] || usage

ssh_options=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=10
  -o ServerAliveCountMax=2
  -o StrictHostKeyChecking=yes
  -o TCPKeepAlive=yes
)
ssh_target="root@$cloud_host"
preflight_timeout_seconds=35

# 本地 Chat 网关不健康时不占用云端 listener。
/usr/bin/curl --fail --silent --max-time 3 \
  "http://127.0.0.1:$local_port$health_path" >/dev/null

# 网络切换可能让云端 sshd 子进程残留占用反向 listener；只在 owner=sshd 时
# 定向回收，再建立新隧道。
set +e
/usr/bin/ssh "${ssh_options[@]}" "$ssh_target" "
  set -eu
  port=$remote_port
  for attempt in 1 2 3; do
    # 云端侧只验证“listener 能把 HTTP 送达 Mac 网关”。Chat 网关对非公开
    # Host 一律 4xx，这是预期的健康信号，不能用 --fail。
    if curl --silent --max-time 2 -o /dev/null http://127.0.0.1:\$port$health_path 2>/dev/null; then
      exit 10
    fi
    sleep 1
  done
  if ! ss -ltnH \"sport = :\$port\" 2>/dev/null | grep -q .; then
    exit 0
  fi
  pid=\$(ss -ltnp \"sport = :\$port\" 2>/dev/null | sed -n 's/.*pid=\\([0-9][0-9]*\\).*/\\1/p' | head -n 1)
  test -n \"\$pid\" || { echo \"relay port \$port owner is unknown\" >&2; exit 3; }
  comm=\$(ps -o comm= -p \"\$pid\" | tr -d '[:space:]')
  test \"\$comm\" = sshd || { echo \"relay port \$port owner is not sshd\" >&2; exit 3; }
  kill \"\$pid\"
  for attempt in 1 2 3 4 5; do
    if ! ss -ltnH \"sport = :\$port\" 2>/dev/null | grep -q .; then
      exit 0
    fi
    sleep 1
  done
  exit 4
" &
preflight_pid="$!"
(
  sleep "$preflight_timeout_seconds"
  kill -TERM "$preflight_pid" 2>/dev/null || exit 0
  sleep 2
  kill -KILL "$preflight_pid" 2>/dev/null || true
) &
watchdog_pid="$!"
wait "$preflight_pid"
preflight_status="$?"
kill "$watchdog_pid" 2>/dev/null || true
wait "$watchdog_pid" 2>/dev/null || true
set -e

if [[ "$preflight_status" -eq 10 ]]; then
  # 另一个仍健康的连接持有 listener；交给 launchd 稍后重试，不打扰它。
  sleep 30
  exit 0
fi
[[ "$preflight_status" -eq 0 ]] || exit "$preflight_status"

exec /usr/bin/ssh -NT \
  "${ssh_options[@]}" \
  -o ConnectionAttempts=3 \
  -o ExitOnForwardFailure=yes \
  -R "127.0.0.1:$remote_port:127.0.0.1:$local_port" \
  "$ssh_target"
