#!/usr/bin/env bash
set -euo pipefail

target="${1:-all}"
backend_port="${2:-8030}"
frontend_port="${3:-5073}"
project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

validate_port() {
  local port="$1"
  if ! [[ "$port" =~ ^[0-9]+$ ]] || ((port < 1024 || port > 65535)); then
    echo "Invalid development port: $port" >&2
    exit 2
  fi
}

terminate_pids() {
  local label="$1"
  local pids="$2"
  local alive=""

  if [[ -z "${pids//[[:space:]]/}" ]]; then
    echo "$label: clean"
    return
  fi

  echo "$label: stopping $pids"
  for pid in $pids; do
    kill -TERM "$pid" 2>/dev/null || true
  done

  for _ in {1..10}; do
    alive=""
    for pid in $pids; do
      if kill -0 "$pid" 2>/dev/null; then
        alive="$alive $pid"
      fi
    done
    [[ -z "${alive//[[:space:]]/}" ]] && return
    sleep 0.1
  done

  echo "$label: force stopping$alive"
  for pid in $alive; do
    kill -KILL "$pid" 2>/dev/null || true
  done
}

cleanup_port() {
  local port="$1"
  local pids
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u | tr '\n' ' ' || true)"
  terminate_pids "port $port" "$pids"
}

cleanup_backend_processes() {
  local pattern="$project_root/.venv/bin/python.*(debugpy|uvicorn)"
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null | sort -u | tr '\n' ' ' || true)"
  terminate_pids "Chat backend processes" "$pids"
}

cleanup_frontend_processes() {
  local pattern="$project_root/frontend/(node_modules/.bin/)?vite"
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null | sort -u | tr '\n' ' ' || true)"
  terminate_pids "Chat frontend processes" "$pids"
}

validate_port "$backend_port"
validate_port "$frontend_port"

case "$target" in
  backend)
    cleanup_port "$backend_port"
    cleanup_backend_processes
    ;;
  frontend)
    cleanup_port "$frontend_port"
    cleanup_frontend_processes
    ;;
  all)
    cleanup_port "$backend_port"
    cleanup_port "$frontend_port"
    cleanup_backend_processes
    cleanup_frontend_processes
    ;;
  *)
    echo "Usage: $0 [backend|frontend|all] [backend-port] [frontend-port]" >&2
    exit 2
    ;;
esac
