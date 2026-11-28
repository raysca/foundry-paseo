#!/bin/bash
# Supervision on a real daemon: a builder that goes silent is interrupted after the idle timeout (and
# stopped if it ignores that), the task is retried after a backoff, and the retry passes review.
source "$(dirname "$0")/lib.sh"
rm -rf "$WORK" && mkdir -p "$WORK" "$FOUNDRY_HOME"
trap stop_daemon EXIT
# Six seconds of silence stops a turn; the first retry waits two seconds.
echo '{"questionWindowSeconds": 5, "idleMinutes": 0.1, "retryBackoffSeconds": 2}' > "$FOUNDRY_HOME/config.json"

start_daemon
install_plugins
wait_for "any(e['kind']=='sdk_attached' for e in d['events'])" 60 "Foundry attached"
fresh_repo
fact project.create "{\"key\":\"SHT\",\"name\":\"Shout\",\"repo\":\"$WORK/repo\"}" >/dev/null
fact dev.seed_feature '{"project":"SHT","slug":"shout-mode","title":"Shout mode","tasks":[
  {"title":"Add shout() to shout/core.py with tests (silent once)"}]}' >/dev/null

st() { echo "[i['status'] for i in d['issues'] if i['key']=='$1'][0]"; }
ev() { echo "[e for e in d['events'] if e['issue_key']=='SHT-1' and e['kind']=='$1']"; }
log "the first builder goes silent; Foundry stops its turn"
wait_for "len($(ev turn_timeout))>0" 120 "turn stopped for silence"
q "import json; e=$(ev turn_timeout)[0]; print('turn_timeout:', json.loads(e['detail'])['why'])"
wait_for "len($(ev retry_scheduled))>0" 120 "retry scheduled"
q "import json; a=[a for a in d['attempts'] if a['issue_key']=='SHT-1'][-1]; assert a['outcome']=='failed' and a['reason']=='TIMEOUT', a; print('attempt 1: failed, TIMEOUT')"
q "import json; k=$(ev agent_killed); print('stopped the agent too' if k else 'the turn ended when interrupted')"
log "the retry passes"
wait_for "$(st SHT-1)=='In_Review'" 240 "SHT-1 In_Review after a retry"
q "a=[a for a in d['attempts'] if a['issue_key']=='SHT-1']; assert len(a)==2 and a[0]['outcome']=='passed', a; print('attempt 2 passed')"
q "i=[i for i in d['issues'] if i['key']=='SHT-1'][0]; assert i['retries']==0 and i['retry_at'] is None, i; print('retries reset')"
log "supervision passed"
