#!/bin/bash
# Foundry's screens in Paseo's web app: the Shout scenario clicked through end to end (feature, Clarify,
# spec, plan and task approvals, two reviews, Verify, Ship, the PM chat) with the scripted harness.
# Needs Playwright with Chromium (require('playwright') must resolve). Screenshots go to $WORK/ui.
source "$(dirname "$0")/lib.sh"
export WEB_UI=1
stop_daemon; rm -rf "$WORK" && mkdir -p "$WORK" "$FOUNDRY_HOME"
trap stop_daemon EXIT
echo '{"questionWindowSeconds": 5}' > "$FOUNDRY_HOME/config.json"

start_daemon
install_plugins
wait_for "any(e['kind']=='sdk_attached' for e in d['events'])" 60 "Foundry attached"
fresh_repo
fact project.create "{\"key\":\"SHT\",\"name\":\"Shout\",\"repo\":\"$WORK/repo\"}" >/dev/null

node "$E2E/ui/flow.cjs" "http://127.0.0.1:${PORT}/" "$WORK/ui"
q "f=d['features'][0]; assert f['stage']=='done', f['stage']; print('feature Done')"
git -C "$WORK/repo" log --oneline -1 main
