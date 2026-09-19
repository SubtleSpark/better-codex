#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${BETTER_CODEX_PORT:-9347}"
HOST="127.0.0.1"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "BetterCodex currently supports macOS only." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22+ is required." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required." >&2
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if (( NODE_MAJOR < 22 )); then
  echo "Node.js 22+ is required. Current: $(node -v)" >&2
  exit 1
fi

prepare_renderer() {
  if [[ ! -d "$ROOT_DIR/node_modules/@awesome.me/webawesome" || ! -x "$ROOT_DIR/node_modules/.bin/esbuild" ]]; then
    echo "[BetterCodex] Installing pinned UI dependencies for the first run..."
    (cd "$ROOT_DIR" && npm install --no-audit --no-fund --no-package-lock)
  fi

  echo "[BetterCodex] Building renderer bundle..."
  (cd "$ROOT_DIR" && npm run build --silent)
}

find_app() {
  if [[ -n "${BETTER_CODEX_APP:-}" ]]; then
    printf '%s\n' "$BETTER_CODEX_APP"
    return
  fi

  local candidate
  for candidate in "/Applications/ChatGPT.app" "/Applications/Codex.app" "$HOME/Applications/ChatGPT.app" "$HOME/Applications/Codex.app"; do
    if [[ -d "$candidate" ]]; then
      printf '%s\n' "$candidate"
      return
    fi
  done

  return 1
}

prepare_renderer

APP_PATH="$(find_app || true)"
if [[ -z "$APP_PATH" ]]; then
  echo "Could not find ChatGPT.app or Codex.app." >&2
  echo "Set BETTER_CODEX_APP=/path/to/ChatGPT.app and retry." >&2
  exit 1
fi

cdp_ready() {
  curl -fsS --max-time 1 "http://${HOST}:${PORT}/json/version" >/dev/null 2>&1
}

app_running() {
  pgrep -x ChatGPT >/dev/null 2>&1 || pgrep -x Codex >/dev/null 2>&1
}

if ! cdp_ready; then
  if app_running; then
    echo "ChatGPT/Codex is already running without BetterCodex's CDP port (${PORT})."
    printf "Restart it with BetterCodex now? [y/N] "
    read -r answer
    case "$answer" in
      y|Y|yes|YES)
        osascript -e 'tell application id "com.openai.codex" to quit' >/dev/null 2>&1 || true
        for _ in {1..30}; do
          app_running || break
          sleep 0.5
        done
        if app_running; then
          echo "The app is still running, likely because it is waiting for confirmation or has an active task." >&2
          echo "Quit it manually, then run ./better-codex again." >&2
          exit 1
        fi
        ;;
      *)
        echo "Cancelled. Quit ChatGPT/Codex and run ./better-codex again." >&2
        exit 1
        ;;
    esac
  fi

  echo "Launching: $APP_PATH"
  open -n "$APP_PATH" --args \
    --remote-debugging-address="$HOST" \
    --remote-debugging-port="$PORT"

  echo "Waiting for local CDP on ${HOST}:${PORT} ..."
  for _ in {1..40}; do
    if cdp_ready; then
      break
    fi
    sleep 0.5
  done

  if ! cdp_ready; then
    echo "CDP did not become ready on ${HOST}:${PORT}." >&2
    echo "Make sure the previous app instance is fully closed, then retry." >&2
    exit 1
  fi
fi

exec node "$ROOT_DIR/src/injector.mjs" --host "$HOST" --port "$PORT" --watch
