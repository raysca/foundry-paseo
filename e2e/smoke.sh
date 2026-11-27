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
c["daemon"]["agentProfiles"].append({"id": "users-own", "name": "Mine", "provider": "claude", "model": "keep-me"})
json.dump(c, open(p, "w"), indent=2)
PY
P daemon restart >/dev/null 2>&1 || (stop_daemon; P start --timeout 300 >/dev/null)
wait_for "True" 30 "daemon back" || true
sleep 3
fsetup | python3 -c "import json,sys;d=json.load(sys.stdin);f=d['findings'];assert any(x['code']=='PROFILE_MISSING' and 'foundry-reviewer' in x['message'] for x in f), f;print('missing profile reported')"

log "onboarding creates the missing profile and keeps the others"
fact setup.harnesses | python3 -c "import json,sys;d=json.load(sys.stdin);print('harnesses:', [(h['id'], h['status'], len(h['models'])) for h in d]);assert isinstance(d, list) and d, d"
fact setup.create_profiles '{"choices":[{"role":"reviewer","harness":"claude","model":"claude-sonnet-5-5"}]}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('added'));assert any('foundry-reviewer' in a for a in d['added']), d;assert not [x for x in d['setup']['findings'] if x['level']=='error'], d['setup']"
python3 - "$PHOME/config.json" <<'PY'
import json, sys
ps = {x["id"]: x for x in json.load(open(sys.argv[1]))["daemon"]["agentProfiles"]}
assert ps["users-own"]["model"] == "keep-me", ps
assert "foundry-reviewer" in ps and "foundry-builder" in ps, ps
print("profiles:", sorted(ps))
PY
fact setup.create_profiles '{"choices":[{"role":"reviewer","harness":"claude","model":"other"}]}' | python3 -c "import json,sys;d=json.load(sys.stdin);assert d['added']==[], d;print('second run adds nothing')"
fact project.adopt "{\"repo\":\"$WORK/repo\"}" | python3 -c "import json,sys;d=json.load(sys.stdin);assert d['error']['code']=='ACK_REQUIRED', d;print('adopt without the notice refused')"

log "install is recorded, and a dev reset brings back a fresh install"
q "o=d['onboarding'];assert o['installed_version']==o['version'], o;print('installed', o['version'])"
fact dev.reset_plan | python3 -c "import json,sys;d=json.load(sys.stdin);print(d);assert 'foundry-builder' in d['profiles'], d"
fact dev.reset '{"confirm":"reset"}' | python3 -c "import json,sys;d=json.load(sys.stdin);print(d);assert 'foundry-builder' in d['removed'], d"
sleep 4
wait_for "d['projects']==[] and d['onboarding']['welcome_dismissed']==False and d['onboarding']['installed_version'] is not None" 60 "Foundry reloaded empty, as a first install"
python3 - "$PHOME/config.json" <<'PY'
import json, sys
ps = [x["id"] for x in json.load(open(sys.argv[1]))["daemon"]["agentProfiles"]]
assert ps == ["users-own"], ps
print("profiles left:", ps)
PY
log "smoke passed"
