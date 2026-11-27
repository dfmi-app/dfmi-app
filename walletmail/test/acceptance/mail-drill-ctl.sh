#!/bin/bash
# Acceptance B/C/D mail drill — instance control on WSL (isolated: drill buckets, drill SES configuration set + Firehose,
# drill IAM user limited to SES simulator recipients; listens on 127.0.0.1 only via drill-faults.cjs).
#   mail-drill-ctl.sh start <legacy|frozen> <mail-bucket> | stop | kill9 | ops <legacy|frozen> <mail-bucket> <outbox-ops args...> | health
# Env: DRILL_DIR (variants, node, deps), DRILL_AWS_ENV (credentials file, 600), DRILL_EVENTS_BUCKET, DRILL_OUT (evidence dir).
set -euo pipefail
D=${DRILL_DIR:?}; NODE=$D/node/node-v24.14.1/bin/node; OUT=${DRILL_OUT:?}; PORT=${DRILL_PORT:-3911}
HERE=$(cd "$(dirname "$0")" && pwd); FAULTS=$HERE/../walletmail/drill-faults.cjs
envs() { set -a; . "${DRILL_AWS_ENV:?}"; set +a; export S3_INCOMING_BUCKET=$1 SES_EVENTS_BUCKET=${DRILL_EVENTS_BUCKET:?} SES_CONFIGURATION_SET=walletmail-drill EMAIL_DOMAIN=dfmi.me \
  PORT DFMI_RPC=http://127.0.0.1:9 ENS_REGISTRY= ENS_RESOLVER= ENS_BOOTSTRAP_NAMES= SIGNATURE_ENFORCE=1 NODE_ENV=production \
  DRILL_CONTROL=$OUT/control.json DRILL_SES_LOG=$OUT/ses-submissions.jsonl; }
log() { echo "$(date -u +%FT%T.%3NZ) $*" | tee -a "$OUT/ctl.log"; }
case "$1" in
  start) envs "$3"; cd "$D/$2"; [ -f "$OUT/control.json" ] || echo '{}' > "$OUT/control.json"
    nohup bash -c "exec $NODE -r $FAULTS server.js" >> "$OUT/server-$2.log" 2>&1 & echo $! > "$OUT/server.pid"
    for i in $(seq 120); do curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health" && break; sleep 0.5; done
    log "start variant=$2 bucket=$3 pid=$(cat "$OUT/server.pid") server_sha256=$(sha256sum server.js | cut -c1-64) health=$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:$PORT/api/health)";;
  stop) P=$(cat "$OUT/server.pid"); kill "$P" 2>/dev/null || true; for i in $(seq 40); do kill -0 "$P" 2>/dev/null || break; sleep 0.25; done; log "stop pid=$P alive=$(kill -0 $P 2>/dev/null && echo yes || echo no)";;
  kill9) P=$(cat "$OUT/server.pid"); kill -9 "$P" 2>/dev/null || true; log "kill -9 pid=$P";;
  dead) P=$(cat "$OUT/server.pid"); kill -0 "$P" 2>/dev/null && { log "pid=$P still alive"; exit 1; } || log "pid=$P is dead (killed by the fault)";;
  ops) envs "$3"; cd "$D/$2"; shift 3; log "ops $*"; $NODE tools/outbox-ops.mjs "$@" 2>&1 | tee -a "$OUT/ops.log";;
  health) curl -s "http://127.0.0.1:$PORT/api/health";;
esac
