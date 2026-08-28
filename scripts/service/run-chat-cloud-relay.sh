#!/usr/bin/env bash
# 把云服务器loopback端口转发到本机Chat生产端口。
# Cloudflare的云端连接器经Nginx访问33051；Chat数据仍只保存在Mac。

set -euo pipefail

cloud_target="later-cloud-admin"
remote_port="33051"
local_port="43110"

usage() {
  echo "Usage: $0 [--cloud-target SSH_ALIAS] [--remote-port PORT] [--local-port PORT]" >&2
  exit 2
}

while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --cloud-target) [[ "$#" -ge 2 ]] || usage; cloud_target="$2"; shift 2 ;;
    --remote-port) [[ "$#" -ge 2 ]] || usage; remote_port="$2"; shift 2 ;;
    --local-port) [[ "$#" -ge 2 ]] || usage; local_port="$2"; shift 2 ;;
    -h|--help) usage ;;
    *) usage ;;
  esac
done

[[ "$cloud_target" =~ ^[A-Za-z0-9._-]+$ ]] || usage
[[ "$remote_port" =~ ^[0-9]+$ && "$remote_port" -ge 1024 && "$remote_port" -le 65535 ]] || usage
[[ "$local_port" =~ ^[0-9]+$ && "$local_port" -ge 1024 && "$local_port" -le 65535 ]] || usage

# 没有健康的Chat进程时不在云端建立一个必然返回502的转发。
/usr/bin/curl --fail --silent --max-time 3 \
  "http://127.0.0.1:${local_port}/api/health" >/dev/null

exec /usr/bin/ssh -NT \
  -o BatchMode=yes \
  -o ConnectTimeout=10 \
  -o ConnectionAttempts=3 \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=10 \
  -o ServerAliveCountMax=3 \
  -o StrictHostKeyChecking=yes \
  -R "127.0.0.1:${remote_port}:127.0.0.1:${local_port}" \
  "$cloud_target"
