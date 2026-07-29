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

  # Resolve concrete PIDs before sending signals; never kill by a broad name.
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

  # Verify the port is actually released; SIGTERM/SIGKILL returns before the
  # kernel reclaims the socket, causing "Address already in use" on immediate
  # restart (2026-07-29).
  for _ in {1..20}; do
    if ! lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return
    fi
    sleep 0.1
  done

  # Still occupied — force-kill any remaining holder.
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null | sort -u | tr '\n' ' ' || true)"
  if [[ -n "${pids//[[:space:]]/}" ]]; then
    echo "port $port: still occupied by$pids after grace period, force killing" >&2
    for pid in $pids; do
      kill -KILL "$pid" 2>/dev/null || true
    done
    for _ in {1..20}; do
      if ! lsof -nP -tiTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
        return
      fi
      sleep 0.1
    done
    echo "port $port: FAILED to release" >&2
  fi
}

# Keep only PIDs that belong to this checkout: the command line references the
# project root, or the process cwd is inside it. This scopes module-name
# patterns so they can never kill an identically-named app from another repo.
filter_project_pids() {
  local pids="$1"
  local kept=""
  local pid cmd cwd
  for pid in $pids; do
    cmd="$(ps -o command= -p "$pid" 2>/dev/null || true)"
    [[ -z "$cmd" ]] && continue
    cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -n1 || true)"
    if [[ "$cmd" == *"$project_root"* || "$cwd" == "$project_root" || "$cwd" == "$project_root"/* ]]; then
      kept="$kept $pid"
    fi
  done
  echo "$kept"
}

cleanup_pattern() {
  local label="$1"
  local pattern="$2"
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null | sort -u | tr '\n' ' ' || true)"
  pids="$(filter_project_pids "$pids")"
  terminate_pids "$label" "$pids"
}

cleanup_backend_processes() {
  # Match the app module, not the interpreter path: instances started with a
  # relative `.venv/bin/python` or on a non-default port escaped the previous
  # absolute-path pattern and kept stealing shared-queue work from the
  # debugged instance (2026-07-28). Killing the uvicorn supervisor also stops
  # its --reload children; any orphan still holding the port is caught by
  # cleanup_port.
  cleanup_pattern "Chat backend processes" "uvicorn backend\.app\.(asgi:app|main:create_api_app)"
}

cleanup_execution_worker_processes() {
  cleanup_pattern "Chat execution worker" "backend\.app\.execution_worker"
}

cleanup_outbox_worker_processes() {
  cleanup_pattern "Chat outbox worker" "backend\.app\.outbox_worker"
}

cleanup_frontend_processes() {
  # Match only Vite processes launched from this repository's frontend tree.
  local pattern="$project_root/frontend/(node_modules/.bin/)?vite"
  local pids
  pids="$(pgrep -f "$pattern" 2>/dev/null | sort -u | tr '\n' ' ' || true)"
  terminate_pids "Chat frontend processes" "$pids"
}

cleanup_pi_processes() {
  # pi is spawned as: node .../dist/cli.js --mode rpc --provider chat-governed ...
  # The "--provider chat-governed" flag is unique to Chat-launched pi instances.
  cleanup_pattern "Chat pi subprocesses" "cli\.js --mode rpc --provider chat-governed"
}

validate_port "$backend_port"
validate_port "$frontend_port"

case "$target" in
  backend)
    cleanup_port "$backend_port"
    cleanup_backend_processes
    cleanup_pi_processes
    ;;
  frontend)
    cleanup_port "$frontend_port"
    cleanup_frontend_processes
    ;;
  execution-worker)
    cleanup_execution_worker_processes
    ;;
  outbox-worker)
    cleanup_outbox_worker_processes
    ;;
  all)
    cleanup_port "$backend_port"
    cleanup_port "$frontend_port"
    cleanup_backend_processes
    cleanup_pi_processes
    cleanup_execution_worker_processes
    cleanup_outbox_worker_processes
    cleanup_frontend_processes
    ;;
  *)
    echo "Usage: $0 [backend|frontend|execution-worker|outbox-worker|all] [backend-port] [frontend-port]" >&2
    exit 2
    ;;
esac
