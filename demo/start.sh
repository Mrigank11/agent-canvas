#!/usr/bin/env bash
# Start the demo agents on the ISOLATED daemon only. Refuses to run against the default ~/.paseo home.
set -euo pipefail
HOME_DIR="${CANVAS_DEMO_HOME:-$HOME/.paseo-canvas-demo}"
case "$HOME_DIR" in "$HOME/.paseo"|"$HOME/.paseo/") echo "refusing: that is the live daemon home" >&2; exit 1;; esac
HERE="$(cd "$(dirname "$0")" && pwd)"
P() { paseo --home "$HOME_DIR" "$@"; }
MODEL="${CANVAS_DEMO_MODEL:-claude-sonnet-5-5}"
run() { # title promptfile canvas(on|off)
  local dir="/tmp/canvas-demo-work/$(echo "$1" | tr 'A-Z' 'a-z' | tr -cs 'a-z0-9' '-' | sed 's/^-//; s/-$//')"
  mkdir -p "$dir"
  local envarg=(); [ "$3" = on ] && envarg=(--env AGENT_CANVAS=on)
  P run --no-wait --quiet --provider claude --model "$MODEL" --mode bypassPermissions --title "$1" --cwd "$dir" "${envarg[@]}" "$(cat "$HERE/$2")" >/dev/null
  echo "started: $1"
}
case "${1:-all}" in
  reset) # archive every agent on the isolated daemon, then start fresh
    for id in $(P ls -q 2>/dev/null); do P stop "$id" >/dev/null 2>&1 || true; P archive "$id" >/dev/null 2>&1 || true; done
    exec "$0" all;;
  deploy) run "Ship build 1.0.10" deploy.md on;;
  decision) run "Pick a database" decision.md on;;
  overconfident) run "Migration (says it's done)" overconfident.md on;;
  silent) run "Indexing (forgot to update)" silent.md on;;
  showcase) run "Block showcase" showcase.md on;;
  plain) run "Plain worker (no canvas)" plain.md off;;
  all)
    run "Ship build 1.0.10" deploy.md on
    run "Pick a database" decision.md on
    run "Migration (says it's done)" overconfident.md on
    run "Indexing (forgot to update)" silent.md on
    run "Block showcase" showcase.md on
    run "Plain worker (no canvas)" plain.md off;;
  *) echo "usage: start.sh [reset|all|deploy|decision|overconfident|silent|showcase|plain]" >&2; exit 2;;
esac
