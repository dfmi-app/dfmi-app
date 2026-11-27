#!/bin/bash
# Acceptance E — memory sampler for the capacity service (runs OUTSIDE the service cgroup): every second,
# UTC time, cgroup memory.current / memory.peak, MainPID VmRSS / VmHWM (KiB), NRestarts, oom_kill count.
U=${1:-walletmail-cap}; OUT=${2:-/var/log/wm-mem.csv}
CG=/sys/fs/cgroup/system.slice/$U.service
echo "utc,memory_current,memory_peak,pid,vmrss_kib,vmhwm_kib,nrestarts,oom_kill" > "$OUT"
while true; do
  P=$(systemctl show $U -p MainPID --value); R=$(systemctl show $U -p NRestarts --value)
  RSS=$(awk '/VmRSS/{print $2}' /proc/$P/status 2>/dev/null); HWM=$(awk '/VmHWM/{print $2}' /proc/$P/status 2>/dev/null)
  OOM=$(awk '/oom_kill /{print $2}' $CG/memory.events 2>/dev/null)
  echo "$(date -u +%FT%T.%3NZ),$(cat $CG/memory.current 2>/dev/null),$(cat $CG/memory.peak 2>/dev/null),$P,$RSS,$HWM,$R,$OOM" >> "$OUT"
  sleep 1
done
