#!/usr/bin/env bash
# 一起启动 Chat 开发后端 (默认 127.0.0.1:43112) 和前端 (默认 127.0.0.1:30145)。
# 用法: scripts/dev-start.sh [--backend-port <port>] [--frontend-port <port>] [--kill]
# --kill: 端口被占用时，终止占用进程后继续启动（默认行为是报错退出）。
# 停止: 在前台按 Ctrl+C，两个进程同时退出。
# 默认使用隔离的 .data/dev/chat-home；设置 CHAT_HOME 可显式使用其他数据目录。
# 日志按启动保留在 .data/dev-logs/，不覆盖上一轮诊断证据。

set -euo pipefail
# 为本脚本启动的每个任务建立独立进程组，退出时连同 pnpm 的子进程一起清理。
set -m
umask 077

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export CHAT_HOME="${CHAT_HOME:-$ROOT/.data/dev/chat-home}"
BACKEND_PORT=43112
FRONTEND_PORT=30145
KILL_OCCUPANTS=0

usage() {
  echo "用法: $(basename "$0") [--backend-port <port>] [--frontend-port <port>] [--kill]" >&2
  echo "默认端口: 后端 43112，前端 30145" >&2
  echo "默认数据: $ROOT/.data/dev/chat-home；可显式设置 CHAT_HOME" >&2
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

LOG_DIR="$ROOT/.data/dev-logs/$(date +%Y%m%d-%H%M%S)-$$"
mkdir -p "$LOG_DIR" "$CHAT_HOME"
BACKEND_LOG="$LOG_DIR/backend.log"
FRONTEND_LOG="$LOG_DIR/frontend.log"

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
TAIL_PID=""

cleanup() {
  trap - EXIT INT TERM
  for pid in "$TAIL_PID" "$FRONTEND_PID" "$BACKEND_PID"; do
    [ -n "$pid" ] && kill -TERM -- "-$pid" 2>/dev/null || true
  done
  # 仅限本脚本拥有的进程组。端口占用者仍只在显式 --kill 下发送 SIGTERM。
  for _ in $(seq 1 25); do
    alive=0
    for pid in "$TAIL_PID" "$FRONTEND_PID" "$BACKEND_PID"; do
      if [ -n "$pid" ] && kill -0 -- "-$pid" 2>/dev/null; then alive=1; fi
    done
    [ "$alive" -eq 0 ] && break
    sleep 0.2
  done
  for pid in "$TAIL_PID" "$FRONTEND_PID" "$BACKEND_PID"; do
    [ -n "$pid" ] && kill -KILL -- "-$pid" 2>/dev/null || true
  done
  wait 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

cd "$ROOT"

echo "启动后端 (nitro dev, $BACKEND_URL)…"
: > "$BACKEND_LOG"
# 直接以环境变量拉起 nitro dev，等价于 pnpm dev，但端口可由本脚本覆盖。
HOST=127.0.0.1 PORT="$BACKEND_PORT" \
  WORKFLOW_TARGET_WORLD=local \
  WORKFLOW_LOCAL_DATA_DIR="$CHAT_HOME/runtime/workflow-data" \
  pnpm exec nitro dev >"$BACKEND_LOG" 2>&1 &
BACKEND_PID=$!

echo "等待后端健康检查…"
for _ in $(seq 1 60); do
  if curl --max-time 2 --fail --silent --output /dev/null "$BACKEND_URL/api/health"; then
    break
  fi
  if ! kill -0 "$BACKEND_PID" 2>/dev/null; then
    echo "错误: 后端进程已退出，最近日志如下:" >&2
    tail -n 40 "$BACKEND_LOG" >&2
    exit 1
  fi
  sleep 1
done

if ! curl --max-time 2 --fail --silent --output /dev/null "$BACKEND_URL/api/health"; then
  echo "错误: 后端健康检查超过60次重试，最近日志如下:" >&2
  tail -n 40 "$BACKEND_LOG" >&2
  exit 1
fi
echo "后端就绪。"

echo "启动前端 (vite, $FRONTEND_URL)…"
: > "$FRONTEND_LOG"
# 统一入口注入产品版本；strictPort 避免 Vite 自动换端口导致代理/调试地址失配。
CHAT_BACKEND_URL="$BACKEND_URL" node scripts/run-frontend.mjs exec vite \
  --host 127.0.0.1 --port "$FRONTEND_PORT" --strictPort >"$FRONTEND_LOG" 2>&1 &
FRONTEND_PID=$!

for _ in $(seq 1 30); do
  curl --max-time 2 --fail --silent --output /dev/null "$FRONTEND_URL" && break
  kill -0 "$FRONTEND_PID" 2>/dev/null || break
  sleep 1
done
if ! curl --max-time 2 --fail --silent --output /dev/null "$FRONTEND_URL"; then
  echo "错误: 前端未就绪，最近日志如下:" >&2
  tail -n 40 "$FRONTEND_LOG" >&2
  exit 1
fi

echo ""
echo "Chat 开发环境已启动:"
echo "  前端:   $FRONTEND_URL"
echo "  后端:   $BACKEND_URL/api/health"
echo "  数据:   $CHAT_HOME"
echo "  日志:   $BACKEND_LOG"
echo "          $FRONTEND_LOG"
echo "按 Ctrl+C 停止全部进程并跟踪日志输出。"
echo ""

tail -n 40 -f "$BACKEND_LOG" "$FRONTEND_LOG" &
TAIL_PID=$!
while kill -0 "$BACKEND_PID" 2>/dev/null && kill -0 "$FRONTEND_PID" 2>/dev/null; do
  sleep 1
done
echo "错误: 开发服务意外退出，停止另一服务；日志保留在 $LOG_DIR" >&2
exit 1
