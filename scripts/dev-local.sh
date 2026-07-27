#!/usr/bin/env bash
set -euo pipefail

# Runs the rating microservice + this app together locally, so you can
# iterate on either one without pushing to git and waiting on a Render or
# Vercel deploy to test it.
#
# NOTE: Supabase is NOT run locally by this script. NEXT_PUBLIC_SUPABASE_URL
# / SUPABASE_SERVICE_ROLE_KEY still come from .env, which today point at
# your LIVE Supabase project -- "Add player" / "Apply match result" while
# this is running writes real rows there. Ask if you also want a fully
# local Supabase (via the Supabase CLI's `supabase start`, needs Docker).

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_DIR="$APP_DIR/../pickleballq-rating-service"
RATING_PORT=4000
APP_PORT=3000
LOCAL_API_KEY="local-dev-key"

if [[ ! -d "$SERVICE_DIR" ]]; then
  echo "ERROR: expected pickleballq-rating-service at $SERVICE_DIR (sibling of this repo)." >&2
  exit 1
fi

if [[ ! -d "$SERVICE_DIR/.venv" ]]; then
  echo "ERROR: no .venv in $SERVICE_DIR -- run this once first:" >&2
  echo "  cd \"$SERVICE_DIR\" && python3 -m venv .venv && source .venv/bin/activate && pip install -r requirements-dev.txt" >&2
  exit 1
fi

cleanup() {
  echo ""
  echo "Stopping rating service..."
  [[ -n "${SERVICE_PID:-}" ]] && kill "$SERVICE_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Free the ports in case a previous run didn't shut down cleanly.
lsof -ti:$RATING_PORT -sTCP:LISTEN | xargs -r kill 2>/dev/null || true
lsof -ti:$APP_PORT -sTCP:LISTEN | xargs -r kill 2>/dev/null || true

echo "Starting rating service on :$RATING_PORT (logs: /tmp/pickleballq-rating-service.log) ..."
(
  cd "$SERVICE_DIR"
  source .venv/bin/activate
  exec env API_KEY="$LOCAL_API_KEY" PORT=$RATING_PORT uvicorn app.main:app --host 0.0.0.0 --port "$RATING_PORT"
) > /tmp/pickleballq-rating-service.log 2>&1 &
SERVICE_PID=$!

echo "Waiting for the rating service to come up..."
for _ in $(seq 1 30); do
  curl -sf "http://localhost:$RATING_PORT/health" >/dev/null 2>&1 && break
  sleep 1
done
if ! curl -sf "http://localhost:$RATING_PORT/health" >/dev/null 2>&1; then
  echo "ERROR: rating service didn't come up in time -- check /tmp/pickleballq-rating-service.log" >&2
  exit 1
fi
echo "Rating service is up."

# Point the app's local dev at the local rating service. Supabase vars are
# left alone -- they still come from .env (your live project).
cat > "$APP_DIR/.env.local" <<EOF
RATING_SERVICE_URL=http://localhost:$RATING_PORT
RATING_SERVICE_API_KEY=$LOCAL_API_KEY
EOF
echo "Wrote .env.local pointing RATING_SERVICE_URL at the local service."

echo "Starting the app on :$APP_PORT (Ctrl+C stops both) ..."
cd "$APP_DIR"
npm run dev
