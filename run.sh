#!/bin/bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT_DIR"

ensure_deps() {
  local dir="$1"
  if [ ! -d "$dir/node_modules" ]; then
    cd "$dir"
    npm install
    cd "$ROOT_DIR"
  fi
}

ensure_deps "$ROOT_DIR"
ensure_deps "$ROOT_DIR/backend"
ensure_deps "$ROOT_DIR/frontend"

HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-4000}"
HEALTH_URL="http://${HOST}:${PORT}/api/health"

if command -v curl >/dev/null 2>&1 && curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
  echo "Backend allaqachon ishga tushgan: $HEALTH_URL"
  echo "Frontend dev server ishga tushirilmoqda..."
  cd frontend
  npm run dev
  exit 0
fi

if command -v ss >/dev/null 2>&1 && ss -ltn "( sport = :$PORT )" | grep -q ":$PORT"; then
  echo "Port $PORT boshqa jarayon tomonidan band."
  echo "Eski node jarayonini to'xtating yoki .env faylda PORT ni o'zgartiring."
  exit 1
fi

npm run dev:all
