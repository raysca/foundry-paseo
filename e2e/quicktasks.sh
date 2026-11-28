#!/bin/bash
# Quick tasks on a real daemon: a quick task created from the board builds on its own branch from base,
# its builder reports discovered work (it lands in Backlog), you accept it and it ships as its own PR
# (a fake gh on the daemon's PATH stands in for GitHub), and merging the PR moves it to Done.
source "$(dirname "$0")/lib.sh"
rm -rf "$WORK" && mkdir -p "$WORK" "$FOUNDRY_HOME"
trap stop_daemon EXIT
echo '{"questionWindowSeconds": 5}' > "$FOUNDRY_HOME/config.json"
export PATH="$E2E/fake-gh:$PATH" FAKE_GH_STATE="$WORK/gh-state.json" FAKE_GH_REMOTE="$WORK/remote.git"

start_daemon
install_plugins
wait_for "any(e['kind']=='sdk_attached' for e in d['events'])" 60 "Foundry attached"
fresh_repo
git init -q --bare "$FAKE_GH_REMOTE"
git -C "$WORK/repo" remote add origin "$FAKE_GH_REMOTE"
git -C "$WORK/repo" push -q origin main
fact project.create "{\"key\":\"SHT\",\"name\":\"Shout\",\"repo\":\"$WORK/repo\"}" >/dev/null

st() { echo "[i['status'] for i in d['issues'] if i['key']=='$1'][0]"; }
att() { echo "[a for a in d['attempts'] if a['issue_key']=='$1'][0]"; }

log "create a quick task from the board; it starts at once"
KEY=$(fact issue.create_quick '{"project":"SHT","title":"Add shout() to shout/core.py with tests (report discovered work)","description":"shout() upper-cases and adds !"}' | python3 -c "import json,sys;r=json.load(sys.stdin);assert r.get('origin')=='quick' and r.get('feature_id') is None, r;print(r['key'])")
wait_for "$(st "$KEY")=='In_Review'" 240 "$KEY In_Review"
BR=$(q "print($(att "$KEY")['branch'])")
H=$(q "print($(att "$KEY")['head_sha'])")
[ "$(git -C "$WORK/repo" merge-base "$H" main)" = "$(git -C "$WORK/repo" rev-parse main)" ] && log "$KEY built on $BR from main"

log "its builder reported discovered work: a Backlog task, not started"
q "x=[i for i in d['issues'] if i['origin']=='discovered']; assert len(x)==1 and x[0]['status']=='Backlog' and x[0]['found_in']=='$KEY', x; print('discovered', x[0]['key'], x[0]['title'])"

log "accept: the branch is pushed and its own PR opened"
ARGS=$(q "a=$(att "$KEY"); import json; print(json.dumps({'key':'$KEY','head_sha':a['head_sha'],'tree_sha':a['tree_sha']}))")
fact issue.accept "$ARGS" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r.get('pr',{}).get('number')==1, r;print('PR', r['pr']['url'])"
python3 -c "import json;s=json.load(open('$FAKE_GH_STATE'));p=s['prs'][0];assert p['base']=='main' and p['head']=='$BR' and p['title'].startswith('$KEY: '), p;print('PR', p['title'], p['head'], '->', p['base'])"
[ "$(git -C "$FAKE_GH_REMOTE" rev-parse "$BR")" = "$H" ] && log "the remote has $BR at the accepted head"
q "assert $(st "$KEY")=='In_Review'; print('waiting for the PR')"

log "the PR merges on GitHub; Foundry moves the task to Done"
python3 -c "import json;p='$FAKE_GH_STATE';s=json.load(open(p));s['prs'][0]['state']='MERGED';json.dump(s,open(p,'w'))"
fact issue.refresh_pr "{\"key\":\"$KEY\"}" | python3 -c "import json,sys;r=json.load(sys.stdin);assert r['results']==[{'issue':'$KEY','result':'merged'}], r;print('merged')"
q "assert $(st "$KEY")=='Done'; print('$KEY Done')"
log "quicktasks passed"
