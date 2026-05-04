#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PID_FILE="$ROOT_DIR/.uae-threat-monitor.pid"
LOG_FILE="$ROOT_DIR/.uae-threat-monitor.log"
APP_CMD=(node server.js)
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3000}"
APP_URL="http://$HOST:$PORT"

is_running() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 1
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

start_app() {
  if is_running; then
    echo "UAE Threat Monitor is already running."
    echo "URL: $APP_URL"
    echo "PID: $(cat "$PID_FILE")"
    echo "Log: $LOG_FILE"
    return 0
  fi

  cd "$ROOT_DIR"
  nohup "${APP_CMD[@]}" >>"$LOG_FILE" 2>&1 &
  echo $! >"$PID_FILE"
  echo "UAE Threat Monitor started successfully."
  echo "URL: $APP_URL"
  echo "PID: $(cat "$PID_FILE")"
  echo "Log: $LOG_FILE"
}

stop_app() {
  if ! is_running; then
    rm -f "$PID_FILE"
    echo "UAE Threat Monitor is not running."
    return 0
  fi

  local pid
  pid="$(cat "$PID_FILE")"
  kill "$pid"

  for _ in {1..20}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "UAE Threat Monitor stopped successfully."
      return 0
    fi
    sleep 0.25
  done

  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "UAE Threat Monitor was force-stopped."
}

status_app() {
  if is_running; then
    echo "UAE Threat Monitor is running."
    echo "URL: $APP_URL"
    echo "PID: $(cat "$PID_FILE")"
    echo "Log: $LOG_FILE"
  else
    echo "UAE Threat Monitor is not running."
    echo "Expected URL when started: $APP_URL"
    echo "Log: $LOG_FILE"
  fi
}

case "${1:-}" in
  start)
    start_app
    ;;
  stop)
    stop_app
    ;;
  restart)
    stop_app
    start_app
    ;;
  status)
    status_app
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status}"
    exit 1
    ;;
esac
