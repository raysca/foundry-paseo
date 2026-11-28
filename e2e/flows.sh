#!/bin/bash
# M3 exit test (Task Flows) on a real daemon. A feature's task list puts one task on frontend and one on
# bugfix, and you change one task's loop before approving. The frontend task's page check runs against
# the project's service script and its screenshot shows in review. The bugfix repro fails with the fix
# reverted and passes with it. A project loop in .foundry/loops, copied from backend and edited by hand,
# runs a third task, whose builder goes silent, times out, is retried and then passes. Then a quick task
# ships as its own PR (a fake gh on the daemon's PATH stands in for GitHub).
source "$(dirname "$0")/lib.sh"
rm -rf "$WORK" && mkdir -p "$WORK" "$FOUNDRY_HOME"
trap stop_daemon EXIT
# Six seconds of silence stops a turn; the first retry waits two seconds.
echo '{"questionWindowSeconds": 5, "idleMinutes": 0.1, "retryBackoffSeconds": 2}' > "$FOUNDRY_HOME/config.json"
export PATH="$E2E/fake-gh:$PATH" FAKE_GH_STATE="$WORK/gh-state.json" FAKE_GH_REMOTE="$WORK/remote.git" FAKE_FLOWS=1

start_daemon
install_plugins
wait_for "any(e['kind']=='sdk_attached' for e in d['events'])" 60 "Foundry attached"
fresh_repo
R="$WORK/repo"

log "the project: a web service and its page check script, a bug in shout(), and a project loop"
mkdir -p "$R/site" "$R/.foundry/loops"
echo "<h1>Shout</h1>" > "$R/site/index.html"
cat > "$R/poc/page_check.py" <<'PY'
import os, sys, urllib.request
url = os.environ["FOUNDRY_PAGE_URL"]
pages = [p for p in os.environ.get("FOUNDRY_PAGES", "").split("\n") if p] or ["/"]
bad = 0
for p in pages:
    html = urllib.request.urlopen(url + p, timeout=10).read()
    name = (p.strip("/").replace("/", "-") or "home") + ".png"
    open(os.path.join(os.environ["FOUNDRY_SCREENSHOTS"], name), "wb").write(html)
    if b"<button>Shout</button>" not in html:
        print(f"{p} has no Shout button")
        bad += 1
print(f"checked {len(pages)} page(s) at {url}")
sys.exit(1 if bad else 0)
PY
python3 - "$R/paseo.json" <<'PY'
import json, sys
p = sys.argv[1]
c = json.load(open(p))
c["scripts"]["web"] = {"type": "service", "command": "python3 -m http.server \"$PASEO_PORT\" --bind 127.0.0.1 --directory site"}
c["scripts"]["page-check"] = {"type": "script", "command": "python3 poc/page_check.py"}
json.dump(c, open(p, "w"), indent=2)
PY
printf 'def shout(text):\n    return text.upper()\n' > "$R/shout/core.py"
# Copied from the built-in backend loop, then edited by hand: a prompt for the builder, two reworks.
cat > "$R/.foundry/loops/careful.yaml" <<'YAML'
steps:
  - kind: agent
    name: build
    prompt: Work carefully. Keep the change small and say what you didn't do.
  - kind: check
    name: check
  - kind: review
    name: review
    back_to: build
    max_reworks: 2
YAML
git -C "$R" add -A && git -C "$R" commit -q -m "web service, page check, a careful loop"
git init -q --bare "$FAKE_GH_REMOTE"
git -C "$R" remote add origin "$FAKE_GH_REMOTE"
git -C "$R" push -q origin main
fact project.create "{\"key\":\"SHT\",\"name\":\"Shout\",\"repo\":\"$R\"}" >/dev/null
fact project.loops '{"project":"SHT"}' | python3 -c "import json,sys;r=json.load(sys.stdin);l={x['name']:x['source'] for x in r['loops']};assert l.get('careful')=='project' and not r['invalid'], r;print('loops on base:', l)"

log "plan a feature: the planner proposes three tasks"
FID=$(fact feature.create '{"project":"SHT","idea":"Shout mode\nA Shout button, shout() fixed, and docs."}' | python3 -c "import json,sys;r=json.load(sys.stdin);assert 'error' not in r, r;print(r['id'])")
feat() { echo "[f for f in d['features'] if f['id']==$FID][0]"; }
docsha() { q "print([x['head_sha'] for x in d['docs'] if x['feature_id']==$FID and x['kind']=='$1'][0])"; }
ok() { python3 -c "import json,sys;r=json.load(sys.stdin);assert 'error' not in r, r;print('$1')"; }
wait_for "any(x['feature_id']==$FID and x['status']=='waiting' for x in d['questions'])" 120 "Clarify question waiting"
fact feature.answer "{\"id\":$FID,\"answers\":{\"short_flag\":\"\"}}" | ok "answered (recommended)"
wait_for "$(feat)['stage']=='spec'" 120 "spec ready"
fact feature.approve_spec "{\"id\":$FID,\"sha\":\"$(docsha spec)\"}" | ok "spec approved"
wait_for "any(x['feature_id']==$FID and x['kind']=='plan' and x['status']=='in_review' for x in d['docs'])" 120 "plan ready"
fact feature.approve_plan "{\"id\":$FID,\"sha\":\"$(docsha plan)\"}" | ok "plan approved"
wait_for "any(x['feature_id']==$FID and x['kind']=='tasks' and x['status']=='in_review' for x in d['docs'])" 120 "task list ready"
prop() { echo "[p for p in d['proposals'] if p['feature_id']==$FID and p['status']=='proposed'][0]"; }
loops() { q "import json; print({t['ref']: t.get('loop') for t in json.loads($(prop)['tasks'])})"; }
log "proposed loops: $(loops)"

log "change T1's loop to frontend before approving (an unknown loop is refused)"
fact feature.edit_slices "{\"id\":$FID,\"op\":{\"kind\":\"set_loop\",\"ref\":\"T1\",\"loop\":\"nope\"}}" \
  | python3 -c "import json,sys;r=json.load(sys.stdin);assert 'error' in r, r;print(r['error']['code'])"
fact feature.edit_slices "{\"id\":$FID,\"op\":{\"kind\":\"set_loop\",\"ref\":\"T1\",\"loop\":\"frontend\"}}" | ok "T1 on frontend"
q "import json; l={t['ref']: t.get('loop') for t in json.loads($(prop)['tasks'])}; assert l=={'T1':'frontend','T2':'bugfix','T3':'careful'}, l; print('loops now', l)"
PROP=$(q "print($(prop)['id'])")
fact feature.approve_tasks "{\"id\":$FID,\"proposal\":$PROP,\"sha\":\"$(docsha tasks)\"}" | ok "task list approved"

key() { q "print([i['key'] for i in d['issues'] if i['feature_id']==$FID and i['title'].startswith('$1')][0])"; }
PAGE=$(key "Add a Shout button"); BUG=$(key "Fix shout()"); DOC=$(key "Document the CLI")
log "tasks: $PAGE (frontend), $BUG (bugfix), $DOC (careful)"
q "l={i['key']: i['loop'] for i in d['issues'] if i['feature_id']==$FID}; assert l=={'$PAGE':'frontend','$BUG':'bugfix','$DOC':'careful'}, l; print('issue loops', l)"
st() { echo "[i['status'] for i in d['issues'] if i['key']=='$1'][0]"; }
att() { echo "[a for a in d['attempts'] if a['issue_key']=='$1'][0]"; }
ev() { echo "[e for e in d['events'] if e['issue_key']=='$1' and e['kind']=='$2']"; }

log "$PAGE: the page step checks the home page against the web service"
wait_for "$(st "$PAGE")=='In_Review'" 300 "$PAGE In_Review"
q "import json; a=$(att "$PAGE"); assert [s['kind'] for s in json.loads(a['loop'])['steps']]==['agent','check','page','review'], a['loop']; print('frozen loop: frontend')"
RUN=$(q "import json
runs=[r for r in d['runs'] if r['attempt_id'] in [a['id'] for a in d['attempts'] if a['issue_key']=='$PAGE'] and r['kind']=='check' and json.loads(r['detail']).get('page')]
assert runs and runs[0]['status']=='passed', runs
x=json.loads(runs[0]['detail'])
assert x['url'].startswith('http://127.0.0.1:') and x['screenshots']==['home.png'], x
print(runs[0]['id'])")
fact issue.review "{\"key\":\"$PAGE\"}" | python3 -c "import json,sys;r=json.dumps(json.load(sys.stdin));assert 'home.png' in r, r[:400];print('review lists the screenshot')"
fact run.screenshot "{\"id\":$RUN,\"file\":\"home.png\"}" | python3 -c "import json,sys,base64;r=json.load(sys.stdin);assert b'Shout</button>' in base64.b64decode(r['uri'].split(',',1)[1]);print('screenshot served to the review panel')"

log "$BUG: the repro fails with the fix reverted and passes with it"
wait_for "$(st "$BUG")=='In_Review'" 300 "$BUG In_Review"
q "import json
runs=[(json.loads(r['detail']).get('name'), r['status']) for r in reversed(d['runs']) if r['attempt_id'] in [a['id'] for a in d['attempts'] if a['issue_key']=='$BUG'] and r['kind']=='check']
print(runs)
assert ('repro: without the fix (expected to fail)','passed') in runs and ('repro: with the fix','passed') in runs, runs"
q "import json; x=[json.loads(r['detail']) for r in d['runs'] if r['attempt_id'] in [a['id'] for a in d['attempts'] if a['issue_key']=='$BUG'] and json.loads(r['detail']).get('name','').startswith('repro: without')][0]; print('without the fix:', repr((x.get('tail') or '')[-120:]))"

log "$DOC: the careful loop; its first builder goes silent, is stopped and retried, and the retry passes"
wait_for "len($(ev "$DOC" turn_timeout))>0" 180 "$DOC turn stopped for silence"
wait_for "len($(ev "$DOC" retry_scheduled))>0" 120 "$DOC retry scheduled"
wait_for "$(st "$DOC")=='In_Review'" 300 "$DOC In_Review after a retry"
q "a=[a for a in d['attempts'] if a['issue_key']=='$DOC']; assert len(a)==2 and a[0]['outcome']=='passed' and a[1]['reason']=='TIMEOUT', a; print('attempt 1 TIMEOUT, attempt 2 passed')"
q "import json; l=json.loads($(att "$DOC")['loop']); assert l['name']=='careful' and l['source']=='project' and l['steps'][0]['prompt'].startswith('Work carefully') and l['steps'][2]['max_reworks']==2, l; print('frozen loop: careful (project)')"

log "a quick task ships as its own PR"
QK=$(fact issue.create_quick '{"project":"SHT","title":"Document the --loud alias","description":"A short doc page."}' | python3 -c "import json,sys;r=json.load(sys.stdin);assert r.get('origin')=='quick' and r.get('feature_id') is None, r;print(r['key'])")
wait_for "$(st "$QK")=='In_Review'" 300 "$QK In_Review"
BR=$(q "print($(att "$QK")['branch'])")
ARGS=$(q "a=$(att "$QK"); import json; print(json.dumps({'key':'$QK','head_sha':a['head_sha'],'tree_sha':a['tree_sha']}))")
fact issue.accept "$ARGS" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r.get('pr',{}).get('number')==1, r;print('PR', r['pr']['url'])"
python3 -c "import json;s=json.load(open('$FAKE_GH_STATE'));assert len(s['prs'])==1;p=s['prs'][0];assert p['base']=='main' and p['head']=='$BR' and p['title'].startswith('$QK: '), p;print('PR', p['title'], p['head'], '->', p['base'])"
python3 -c "import json;p='$FAKE_GH_STATE';s=json.load(open(p));s['prs'][0]['state']='MERGED';json.dump(s,open(p,'w'))"
fact issue.refresh_pr "{\"key\":\"$QK\"}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['results']==[{'issue':'$QK','result':'merged'}], r;print('merged')"
q "assert $(st "$QK")=='Done'; print('$QK Done')"
log "flows passed"
