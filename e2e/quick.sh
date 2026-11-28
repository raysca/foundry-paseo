#!/bin/bash
# The Quick flow on a real daemon: one planning turn writes the spec, plan and task list after a
# Clarify round answered late; a spec or plan approval on its own is refused; one approval naming all
# three SHAs moves the feature to Build and its first task starts.
source "$(dirname "$0")/lib.sh"
rm -rf "$WORK" && mkdir -p "$WORK" "$FOUNDRY_HOME"
trap stop_daemon EXIT
echo '{"questionWindowSeconds": 5}' > "$FOUNDRY_HOME/config.json"

start_daemon
install_plugins
wait_for "any(e['kind']=='sdk_attached' for e in d['events'])" 60 "Foundry attached"
fresh_repo
fact project.create "{\"key\":\"SHT\",\"name\":\"Shout\",\"repo\":\"$WORK/repo\"}" >/dev/null

log "create a Quick-flow feature"
FID=$(fact feature.create '{"project":"SHT","idea":"Shout mode\nLet the CLI shout its input.","flow":"quick"}' | python3 -c "import json,sys;r=json.load(sys.stdin);assert 'error' not in r, r;print(r['id'])")
feat() { echo "[f for f in d['features'] if f['id']==$FID][0]"; }
docsha() { q "print([x['head_sha'] for x in d['docs'] if x['feature_id']==$FID and x['kind']=='$1'][0])"; }
ok() { python3 -c "import json,sys;r=json.load(sys.stdin);assert 'error' not in r, r;print('$1')"; }
err() { python3 -c "import json,sys;r=json.load(sys.stdin);assert r.get('error',{}).get('code')=='$1', r;print('$1')"; }

log "one Clarify round; the late answer starts the turn that writes all three docs"
wait_for "any(x['feature_id']==$FID and x['status']=='waiting' for x in d['questions'])" 120 "Clarify question waiting"
fact feature.answer "{\"id\":$FID,\"answers\":{\"short_flag\":\"\"}}" | ok "answered (recommended)"
wait_for "$(feat)['stage']=='tasks' and not $(feat)['planning_busy']" 120 "jumped from Clarify to Tasks"
q "assert all(x['status']=='in_review' for x in d['docs'] if x['feature_id']==$FID), [x for x in d['docs'] if x['feature_id']==$FID]; print('spec, plan and tasks in review')"
q "runs=[r for r in d['runs'] if r['feature_id']==$FID and r['kind']=='plan']; assert len(runs)==2, runs; print('two planning turns: the question, then spec, plan and tasks together')"

log "approving the spec or plan alone is refused; one approval names all three"
fact feature.approve_spec "{\"id\":$FID,\"sha\":\"$(docsha spec)\"}" | err QUICK_FLOW
PROP=$(q "print([p['id'] for p in d['proposals'] if p['feature_id']==$FID and p['status']=='proposed'][0])")
fact feature.approve_tasks "{\"id\":$FID,\"proposal\":$PROP,\"sha\":\"$(docsha tasks)\"}" | err SHA_REQUIRED
fact feature.approve_tasks "{\"id\":$FID,\"proposal\":$PROP,\"sha\":\"$(docsha tasks)\",\"spec_sha\":\"$(docsha spec)\",\"plan_sha\":\"$(docsha plan)\"}" | ok "approved once"
q "f=$(feat); assert f['stage']=='build', f['stage']; print('feature in Build')"
q "assert all(x['status']=='approved' for x in d['docs'] if x['feature_id']==$FID); print('all three docs approved')"
wait_for "[i['status'] for i in d['issues'] if i['key']=='SHT-1'][0]=='In_Review'" 240 "SHT-1 ran through loop 2"
B=$(q "print($(feat)['branch'])")
git -C "$WORK/repo" show "$B:.foundry/features/shout-mode/plan.md" | grep "## Approach" >/dev/null && echo "plan.md on $B"
log "PASS: the Quick flow"
