#!/bin/bash
# Shared helpers for Foundry's e2e suite. Runs a SEPARATE Paseo daemon home and port, so a normal
# Paseo setup on the same machine is untouched.
set -euo pipefail
export E2E="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export ROOT="$(cd "$E2E/.." && pwd)"
export WORK="${WORK:-${TMPDIR:-/tmp}/foundry-e2e}"
export PHOME="$WORK/paseo-home"
export FOUNDRY_HOME="$WORK/foundry-home"
export PORT="${PORT:-6790}"
export FOUNDRY_DAEMON_URL="ws://127.0.0.1:${PORT}/ws"
export FOUNDRY_SCRIPTED_LOG="$WORK/scripted.log"
# Paseo reports script exit codes only under zsh (scorecard: upstream ask).
export SHELL="$(command -v zsh)"
PASEO_BIN="${PASEO_BIN:-$E2E/node_modules/.bin/paseo}"
HARNESS="${HARNESS:-scripted}"   # scripted (CI) or claude (Mac)

P() { "$PASEO_BIN" --home "$PHOME" "$@"; }
log() { echo "[$(date +%H:%M:%S)] $*"; }
fstate() { node "$ROOT/plugin/bin/foundry.mjs" state; }
fsetup() { node "$ROOT/plugin/bin/foundry.mjs" setup; }
fact() { node "$ROOT/plugin/bin/foundry.mjs" act "$1" "${2:-{\}}"; }
# q 'python expression using d (the state)'
q() { fstate | python3 -c "import json,sys;d=json.load(sys.stdin);$1"; }
wait_for() {
  local expr="$1" t="${2:-120}" label="${3:-$1}" i=0
  while [ "$i" -lt "$t" ]; do
    if [ "$(q "print(bool($expr))" 2>/dev/null)" = "True" ]; then log "ok: $label (${i}s)"; return 0; fi
    sleep 2; i=$((i + 2))
  done
  log "TIMEOUT: $label after ${t}s"; return 1
}

# Write the test daemon's config: MCP injection on, plugins on, Foundry's providers with Paseo's
# orchestration tools disabled, and the four foundry-* role profiles.
write_daemon_config() {
  mkdir -p "$PHOME"
  python3 - "$PHOME/config.json" "$PORT" "$HARNESS" "$E2E/paseo-tools.json" <<'PY'
import json, sys, os
path, port, harness, tools_path = sys.argv[1:5]
tools = json.load(open(tools_path))
c = json.load(open(path)) if os.path.exists(path) else {"version": 1}
d = c.setdefault("daemon", {})
d["listen"] = f"127.0.0.1:{port}"
d["relay"] = {"enabled": False}
d["mcp"] = {"enabled": True, "injectIntoAgents": True}
c["pluginsEnabled"] = True
prov = c.setdefault("agents", {}).setdefault("providers", {})
if harness == "scripted":
    # `extends` doesn't work for plugin providers (scorecard), so the tools are disabled on "scripted" itself.
    prov["scripted"] = {"paseoTools": {"disabledTools": tools}}
    provider, model = "scripted", "script-1"
else:
    prov[f"foundry-{harness}"] = {"extends": harness, "label": f"Foundry {harness}", "paseoTools": {"disabledTools": tools}}
    provider, model = f"foundry-{harness}", os.environ.get("FOUNDRY_MODEL", "claude-sonnet-5-5")
d["agentProfiles"] = [
    {"id": f"foundry-{r}", "name": f"Foundry {r}", "provider": provider, "model": model}
    for r in ("builder", "reviewer", "planner", "pm")
]
json.dump(c, open(path, "w"), indent=2)
PY
}

start_daemon() {
  write_daemon_config
  P daemon status >/dev/null 2>&1 && P daemon stop >/dev/null 2>&1 || true
  P start --timeout 300 >/dev/null
  for _ in $(seq 1 60); do P daemon status >/dev/null 2>&1 && return 0; sleep 1; done
  log "daemon did not start"; return 1
}

install_plugins() {
  if [ "$HARNESS" = "scripted" ]; then
    P plugin ls 2>/dev/null | grep -q foundry-scripted || P plugin install "$E2E/scripted-harness"
  fi
  P plugin ls 2>/dev/null | grep -qE '^foundry[[:space:]]' || P plugin install "$ROOT/plugin"
  P plugin reload foundry >/dev/null 2>&1 || true
}

fresh_repo() {
  rm -rf "$WORK/repo" && git clone -q "$E2E/fixture/shout.bundle" "$WORK/repo" -b main
  git -C "$WORK/repo" remote remove origin 2>/dev/null || true
}

stop_daemon() { P daemon stop >/dev/null 2>&1 || true; }
