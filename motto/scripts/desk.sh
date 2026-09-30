#!/usr/bin/env bash
# The Motto desk behind the Tailscale Funnel: https://motto.tail039d5c.ts.net proxies 127.0.0.1:8787.
#
#   scripts/desk.sh restart   replace whatever listens on the port with `node --watch src/server.js`
#                             from this checkout, so edits to src/ restart the desk and the public URL
#                             always serves the repo; public/ and bench/results.json are read per request
#   scripts/desk.sh status    repo HEAD next to the commit the local and public URLs report
#   scripts/desk.sh pair      create a five-minute browser pairing link for the public console
#   scripts/desk.sh stop      stop the desk (the Funnel stays on and answers 502 until restart)
#
# Environment passes through to the server (NETWORK, OPERATOR_KEY, ...). Default is the Devnet desk; set NETWORK=localnet for the sandbox.
set -euo pipefail

MOTTO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PORT:-8787}"
PUBLIC_URL="${PUBLIC_URL:-https://motto.tail039d5c.ts.net}"
LOG="$MOTTO_DIR/data/server.log"
PIDFILE="$MOTTO_DIR/data/desk.pid"
TAILSCALE="$(command -v tailscale || echo /Applications/Tailscale.app/Contents/MacOS/Tailscale)"

listener_pids() { lsof -nP -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true; }
health() { curl -s -m "${2:-5}" "$1/healthz" 2>/dev/null || true; }
repo_head() {
  local sha; sha="$(git -C "$MOTTO_DIR" rev-parse --short HEAD)"
  if [ -n "$(git -C "$MOTTO_DIR" status --porcelain -- src public)" ]; then echo "$sha-dirty"; else echo "$sha"; fi
}

stop() {
  local pid ppid
  # A `node --watch` parent respawns its child on the next file change, so stop the parent first.
  if [ -f "$PIDFILE" ]; then
    pid="$(cat "$PIDFILE")"
    kill "$pid" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  for pid in $(listener_pids); do
    ppid="$(ps -o ppid= -p "$pid" | tr -d ' ')"
    if ps -o command= -p "$ppid" 2>/dev/null | grep -q -- '--watch'; then kill "$ppid" 2>/dev/null || true; fi
    kill "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 50); do
    [ -z "$(listener_pids)" ] && { echo "stopped, :$PORT free"; return 0; }
    sleep 0.1
  done
  echo "port $PORT still busy: $(listener_pids | tr '\n' ' ')" >&2
  return 1
}

start() {
  cd "$MOTTO_DIR"
  mkdir -p data
  node scripts/motto.mjs setup
  if [ -n "$(listener_pids)" ]; then
    echo "something already listens on :$PORT (pid $(listener_pids | tr '\n' ' ')); run stop or restart" >&2
    return 1
  fi
  echo "--- desk.sh start $(date '+%Y-%m-%d %H:%M:%S') repo $(repo_head)" >> "$LOG"
  nohup node --watch src/server.js >> "$LOG" 2>&1 &
  echo $! > "$PIDFILE"
  for _ in $(seq 1 100); do
    if [ -n "$(health "http://127.0.0.1:$PORT" 2)" ]; then
      echo "desk up (watcher pid $(cat "$PIDFILE"), log $LOG)"
      return 0
    fi
    sleep 0.1
  done
  echo "desk did not answer /healthz within 10s; last log lines:" >&2
  tail -n 20 "$LOG" >&2
  return 1
}

pair() {
  cd "$MOTTO_DIR"
  node scripts/motto.mjs pair --url "$PUBLIC_URL" --open
}

funnel() {
  if "$TAILSCALE" funnel status 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
    echo "funnel on: $PUBLIC_URL -> 127.0.0.1:$PORT"
  else
    echo "funnel off, enabling: $PUBLIC_URL -> 127.0.0.1:$PORT"
    "$TAILSCALE" funnel --bg "$PORT"
  fi
}

status() {
  local pid
  echo "repo    $(repo_head)  ($MOTTO_DIR)"
  if [ -z "$(listener_pids)" ]; then
    echo "desk    not running on :$PORT"
  else
    for pid in $(listener_pids); do
      echo "desk    pid $pid since $(ps -o lstart= -p "$pid" | sed 's/  */ /g'): $(ps -o command= -p "$pid")"
    done
  fi
  local local_health public_health
  local_health="$(health "http://127.0.0.1:$PORT")"
  echo "local   ${local_health:-no answer}"
  if "$TAILSCALE" funnel status 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
    echo "funnel  on: $PUBLIC_URL -> 127.0.0.1:$PORT"
  else
    echo "funnel  off (scripts/desk.sh restart turns it on)"
  fi
  public_health="$(health "$PUBLIC_URL" 15)"
  echo "public  ${public_health:-no answer}"
}

case "${1:-restart}" in
  restart) stop; start; funnel ;;
  start)   start; funnel ;;
  pair)    pair ;;
  stop)    stop ;;
  status)  status ;;
  *) echo "usage: scripts/desk.sh [restart|start|pair|stop|status]" >&2; exit 2 ;;
esac
