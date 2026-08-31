#!/usr/bin/env bash
# 一起启动 Chat 开发后端 (默认 127.0.0.1:43112) 和前端 (默认 127.0.0.1:30145)。
# 用法: scripts/dev-start.sh [--backend-port <port>] [--frontend-port <port>] [--kill]
# --kill: 端口被占用时，终止占用进程后继续启动（默认行为是报错退出）。
# 停止: 在前台按 Ctrl+C，两个进程同时退出。
# 日志: .data/dev-backend.log 与 .data/dev-frontend.log

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND_PORT=43112
FRONTEND_PORT=30145
KILL_OCCUPANTS=0

usage() {
  echo "用法: $(basename "$0") [--backend-port <port>] [--frontend-port <port>] [--kill]" >&2
  echo "默认端口: 后端 43112，前端 30145" >&2
  echo "--kill: 端口被占用时，终止占用进程后继续启动" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --backend-port)
      [ $# -ge 2 ] || { echo "错误: $1 需要一个端口号参数" >&2; usage; exit 1; }
      BACKEND_PORT="$2"
      shift 2
      ;;
    --frontend-port)
      [ $# -ge 2 ] || { echo "错误: $1 需要一个端口号参数" >&2; usage; exit 1; }
      FRONTEND_PORT="$2"
      shift 2
      ;;
    --kill)
      KILL_OCCUPANTS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "错误: 未知参数 $1" >&2
      usage
      exit 1
      ;;
  esac
done

for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  case "$port" in
    ''|*[!0-9]*)
      echo "错误: 端口必须是数字，收到 '$port'" >&2
      usage
      exit 1
      ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    echo "错误: 端口必须在 1-65535 之间，收到 '$port'" >&2
    usage
    exit 1
  fi
done

BACKEND_URL="http://127.0.0.1:${BACKEND_PORT}"
FRONTEND_URL="http://127.0.0.1:${FRONTEND_PORT}"

if [ "$BACKEND_PORT" = "$FRONTEND_PORT" ]; then
  echo "错误: 后端和前端不能使用同一个端口 $BACKEND_PORT" >&2
  exit 1
fi

mkdir -p "$ROOT/.data"
BACKEND_LOG="$ROOT/.data/dev-backend.log"
FRONTEND_LOG="$ROOT/.data/dev-frontend.log"

port_busy() {
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

port_occupant_pids() {
  lsof -t -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null
}

kill_port_occupants() {
  local port="$1"
  local pids
  pids="$(port_occupant_pids "$port")" || return 0
  if [ -z "$pids" ]; then
    return 0
  fi
  echo "终止占用端口 $port 的进程: PID $(echo "$pids" | tr '\n' ' ')"
  # shellcheck disable=SC2086
  kill $pids 2>/dev/null || true
  # 给进程时间退出并释放端口，最多等 5 秒。
  for _ in $(seq 1 10); do
    port_busy "$port" || return 0
    sleep 0.5
  done
  echo "错误: 端口 $port 在 SIGTERM 后仍未释放，为安全起见不升级强制杀死。" >&2
  lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2
  return 1
}

for port in "$BACKEND_PORT" "$FRONTEND_PORT"; do
  if port_busy "$port"; then
    if [ "$KILL_OCCUPANTS" -eq 1 ]; then
      kill_port_occupants "$port"
    else
      echo "错误: 端口 $port 已被占用，先停止占用它的进程再运行本脚本，或使用 --kill 选项自动终止占用进程。" >&2
      lsof -nP -iTCP:"$port" -sTCP:LISTEN >&2
      exit 1
    fi
  fi
done

BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  trap - EXIT INT TERM
  [ -n "$FRONTEND_PID" ] && kill "$FRONTEND_PID" 2>/dev/null || true
  [ -n "$BACKEND_PID" ] && kill "$BACKEND_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

cd "$ROOT"

echo "启动后端 (nitro dev, $BACKEND_URL)…"
: > "$BACKEND_LOG"
# 直接以环境变量拉起 nitro dev，等价于 pnpm dev，但端口可由本脚本覆盖。
HOST=127.0.0.1 PORT="$BACKEND_PORT" \
  WORKFLOW_TARGET_WORLD=local \
  WORKFLOW_LOCAL_DATA_DIR="${CHAT_HOME:-$HOME/.chat}/runtime/workflow-data" \
  pnpm exec nitro dev >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

echo "等待后端健康检查…"
for _ in $(seq 1 60); do
  if curl --fail --silent --output /dev/null "$BACKEND_URL/api/health"; then
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "错误: 后端进程已退出，最近日志如下:" >&2
    tail -n 40 "$BACKEND_LOG" >&2
    exit 1
  fi
  sleep 1
done

if ! curl --fail --silent --output /dev/null "$BACKEND_URL/api/health"; then
  echo "错误: 后端健康检查超时 (60s)，最近日志如下:" >&2
  tail -n 40 "$BACKEND_LOG" >&2
  exit 1
fi
echo "后端就绪。"

echo "启动前端 (vite, $FRONTEND_URL)…"
: > "$FRONTEND_LOG"
# 直接以 CLI 端口拉起 vite，等价于 pnpm --dir frontend dev，但端口可由本脚本覆盖。
CHAT_BACKEND_URL="$BACKEND_URL" pnpm --dir frontend exec vite \
  --host 127.0.0.1 --port "$FRONTEND_PORT" >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

sleep 3
if ! kill -0 "$FRONTEND_PID" 2>/dev/null; then
  echo "错误: 前端进程已退出，最近日志如下:" >&2
  tail -n 40 "$FRONTEND_LOG" >&2
  exit 1
fi

echo ""
echo "Chat 开发环境已启动:"
echo "  前端:   $FRONTEND_URL"
echo "  后端:   $BACKEND_URL/api/health"
echo "  日志:   $BACKEND_LOG"
echo "          $FRONTEND_LOG"
echo "按 Ctrl+C 停止全部进程并跟踪日志输出。"
echo ""

tail -n 40 -f "$BACKEND_LOG" "$FRONTEND_LOG"
