#!/bin/bash
# Pull-based deploy for gaming-box (run by minesweeper-deploy.timer).
# The repo is public, so we don't use a self-hosted runner (fork PRs could
# run code on the box). Instead the box polls origin/main and deploys a
# commit only once GitHub reports its CI check runs all succeeded.
set -euo pipefail

REPO=bufordeeds/minesweeper-mp
SRC=$HOME/apps/minesweeper-mp
STATE=$HOME/.local/state/minesweeper
NAME=minesweeper
PORT=8482
mkdir -p "$STATE"

cd "$SRC"
git fetch -q origin main
target=$(git rev-parse origin/main)
current=$(cat "$STATE/deployed" 2>/dev/null || echo none)
[ "$target" = "$current" ] && exit 0
# A failed smoke test or a manual rollback parks this SHA until a new commit lands.
[ "$target" = "$(cat "$STATE/skip" 2>/dev/null)" ] && exit 0

# Gate on CI: every check run for this SHA must be completed + success.
runs=$(curl -fsS -H "Accept: application/vnd.github+json" \
  "https://api.github.com/repos/$REPO/commits/$target/check-runs")
total=$(jq '.total_count' <<<"$runs")
bad=$(jq '[.check_runs[] | select(.status != "completed" or .conclusion != "success")] | length' <<<"$runs")
if [ "$total" -eq 0 ] || [ "$bad" -ne 0 ]; then
  echo "waiting on CI for ${target:0:7} ($total runs, $bad not green)"
  exit 0
fi

echo "deploying ${target:0:7} (was ${current:0:7})"
git -c advice.detachedHead=false checkout -q "$target"
docker build -q -t "minesweeper-mp:$target" . >/dev/null

run() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --restart unless-stopped -p "$PORT:3456" "minesweeper-mp:$1" >/dev/null
}
smoke() {
  for i in $(seq 1 20); do
    curl -fsS -o /dev/null "http://127.0.0.1:$PORT/" && return 0
    sleep 0.5
  done
  return 1
}

run "$target"
if smoke; then
  [ "$current" != none ] && echo "$current" > "$STATE/previous"
  echo "$target" > "$STATE/deployed"
  rm -f "$STATE/skip"
  docker tag "minesweeper-mp:$target" minesweeper-mp:latest
  echo "deployed ${target:0:7}"
else
  echo "smoke test failed for ${target:0:7}; restoring ${current:0:7}" >&2
  [ "$current" != none ] && run "$current"
  echo "$target" > "$STATE/skip"   # don't retry the same bad SHA every tick
  exit 1
fi
