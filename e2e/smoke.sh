#!/bin/bash
# Foundations smoke test: a real Paseo daemon loads Foundry, Foundry attaches with no client open,
# and its setup check passes on a correctly configured daemon and names what's wrong on a broken one.
source "$(dirname "$0")/lib.sh"
rm -rf "$WORK" && mkdir -p "$WORK"
trap stop_daemon EXIT

log "start daemon on $PORT ($HARNESS)"
start_daemon
install_plugins
wait_for "any(e['kind']=='sdk_attached' for e in d['events'])" 60 "Foundry attached with no client open"

log "setup check on a good daemon"
fsetup | python3 -c "import json,sys;d=json.load(sys.stdin);f=d['findings'];print('\n'.join(x['level']+' '+x['code'] for x in f));assert not [x for x in f if x['level']=='error'], 'setup has errors'"

log "project create"
fresh_repo
fact project.create "{\"key\":\"SHT\",\"name\":\"Shout\",\"repo\":\"$WORK/repo\"}" >/dev/null
q "assert d['projects'][0]['key']=='SHT'; print('project ok')"

log "setup check names a missing profile"
python3 - "$PHOME/config.json" <<'PY'
import json, sys
p = sys.argv[1]; c = json.load(open(p))
c["daemon"]["agentProfiles"] = [x for x in c["daemon"]["agentProfiles"] if x["id"] != "foundry-reviewer"]
json.dump(c, open(p, "w"), indent=2)
PY
P daemon restart >/dev/null 2>&1 || (stop_daemon; P start --timeout 300 >/dev/null)
wait_for "True" 30 "daemon back" || true
sleep 3
fsetup | python3 -c "import json,sys;d=json.load(sys.stdin);f=d['findings'];assert any(x['code']=='PROFILE_MISSING' and 'foundry-reviewer' in x['message'] for x in f), f;print('missing profile reported')"
log "smoke passed"
