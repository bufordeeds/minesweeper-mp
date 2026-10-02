#!/bin/bash
# Swap back to the previously deployed image (seconds — no rebuild).
# Usage: deploy/rollback.sh [sha]   (default: the deploy before the current one)
set -euo pipefail
STATE=$HOME/.local/state/minesweeper
sha=${1:-$(cat "$STATE/previous")}
docker image inspect "minesweeper-mp:$sha" >/dev/null
docker rm -f minesweeper >/dev/null 2>&1 || true
docker run -d --name minesweeper --restart unless-stopped -p 8482:3456 "minesweeper-mp:$sha" >/dev/null
bad=$(cat "$STATE/deployed")
echo "$bad" > "$STATE/skip"       # park it so the timer doesn't redeploy it
echo "$bad" > "$STATE/previous"
echo "$sha" > "$STATE/deployed"
echo "rolled back to ${sha:0:7} — note: ${bad:0:7} is parked; the timer resumes on the next commit to main"
