#!/bin/bash
# Page checks on a real daemon: a frontend task's page step starts the project's paseo.json service
# through Paseo (Paseo picks the port), runs the project's page check script against it, keeps the
# screenshot it saves for the review, and stops the service.
source "$(dirname "$0")/lib.sh"
rm -rf "$WORK" && mkdir -p "$WORK" "$FOUNDRY_HOME"
trap stop_daemon EXIT
echo '{"questionWindowSeconds": 5}' > "$FOUNDRY_HOME/config.json"

start_daemon
install_plugins
wait_for "any(e['kind']=='sdk_attached' for e in d['events'])" 60 "Foundry attached"
fresh_repo

log "the project gets a web service and a page check script (it owns the 'browser': here, urllib)"
R="$WORK/repo"
mkdir -p "$R/site"
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
git -C "$R" add -A && git -C "$R" commit -q -m "web service and page check"
fact project.create "{\"key\":\"SHT\",\"name\":\"Shout\",\"repo\":\"$R\"}" >/dev/null
fact dev.seed_feature '{"project":"SHT","slug":"shout-page","title":"Shout page","tasks":[
  {"title":"Add a Shout button to the home page","loop":"frontend","checks":{"pages":["/"]}}]}' >/dev/null

st() { echo "[i['status'] for i in d['issues'] if i['key']=='$1'][0]"; }
log "SHT-1 runs on the frontend loop: checks, then the page step"
wait_for "$(st SHT-1)=='In_Review'" 300 "SHT-1 In_Review"
q "import json
for r in reversed(d['runs']):
  if r['kind']=='check': x=json.loads(r['detail']); print('check', r['status'], x.get('name'), x.get('url'), x.get('screenshots'), repr((x.get('tail') or '')[-160:]))"
q "a=[a for a in d['attempts'] if a['issue_key']=='SHT-1'][0]; assert a['outcome']=='passed', a; print('passed after', a['fix_rounds'], 'fix round(s)')"
RUN=$(q "import json
runs=[r for r in d['runs'] if r['kind']=='check' and json.loads(r['detail']).get('page')]
assert runs and runs[0]['status']=='passed', runs
x=json.loads(runs[0]['detail'])
assert x['url'].startswith('http://127.0.0.1:') and x['screenshots']==['home.png'], x
print(runs[0]['id'])")
log "the page check ran against $(q "import json; print([json.loads(r['detail'])['url'] for r in d['runs'] if r['id']==$RUN][0])")"
fact run.screenshot "{\"id\":$RUN,\"file\":\"home.png\"}" | python3 -c "import json,sys,base64;r=json.load(sys.stdin);assert r['uri'].startswith('data:image/png;base64,'), r;assert b'Shout</button>' in base64.b64decode(r['uri'].split(',',1)[1]);print('screenshot served to the review panel')"
fact run.screenshot "{\"id\":$RUN,\"file\":\"../foundry.db\"}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['error']['code']=='NOT_FOUND', r;print('only listed screenshots are served')"
log "the service was stopped: its port no longer answers"
URL=$(q "import json; print([json.loads(r['detail'])['url'] for r in d['runs'] if r['id']==$RUN][0])")
python3 -c "import urllib.request,sys
try: urllib.request.urlopen('$URL', timeout=3); sys.exit('the service still answers at $URL')
except OSError: print('nothing at $URL')"
log "pages passed"
