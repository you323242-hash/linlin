#!/usr/bin/env bash
set -euo pipefail
umask 077
if [ "${1:-}" != owner ]; then
 exec 9>/var/lib/delta-maintenance/backup.lock
 LOCK_STATUS=0
 flock -n -E 200 9 || LOCK_STATUS=$?
 if [ "$LOCK_STATUS" = 200 ]; then exit 0; fi
 if [ "$LOCK_STATUS" != 0 ]; then
  echo MONITOR_LOCK_ERROR >&2
  exit "$LOCK_STATUS"
 fi
fi
MARKER=/var/lib/delta-maintenance/paused
PENDING=/var/lib/delta-maintenance/monitor-pending
restore_monitor() {
 systemctl start delta-monitor.timer || return $?
 systemctl is-active --quiet delta-monitor.timer || return $?
 rm -f -- "$PENDING"
}
if [ "${1:-}" = monitor-only ]; then
 # A repair may restore the previous monitor intent, never an application.
 if [ ! -e "$PENDING" ]; then exit 0; fi
 if [ -L "$PENDING" ] || [ ! -f "$PENDING" ] || [ "$(stat -c %U "$PENDING")" != root ] || [ "$(stat -c %a "$PENDING")" != 600 ] || [ "$(cat "$PENDING")" != resume-monitor ]; then
  echo INVALID_MONITOR_PENDING
  exit 65
 fi
 AGE=$(( $(date +%s) - $(stat -c %Y "$PENDING") ))
 if [ "$AGE" -lt 0 ] || [ "$AGE" -gt 1800 ]; then
  echo MONITOR_PENDING_EXPIRED
  exit 75
 fi
 if [ -e "$MARKER" ]; then
  echo MONITOR_REPAIR_DEFERRED
  exit 0
 fi
 APP_STATE=$(systemctl show --property=ActiveState --value delta-staging) || {
  STATUS=$?
  echo MONITOR_STATE_QUERY_ERROR >&2
  exit "$STATUS"
 }
 case "$APP_STATE" in
  active) ;;
  inactive|failed|activating|deactivating|reloading|refreshing|maintenance)
   echo MONITOR_REPAIR_DEFERRED
   exit 0 ;;
  *) echo MONITOR_STATE_INVALID >&2; exit 65 ;;
 esac
 restore_monitor
 echo MONITOR_REPAIRED
 exit 0
fi
# Exact root-owned transient marker: don't revive intentionally stopped sites.
if [ ! -f "$MARKER" ]; then exit 0; fi
MODE=$(cat "$MARKER")
if [ $(( $(date +%s) - $(stat -c %Y "$MARKER") )) -gt 1800 ]; then
 echo STALE_BACKUP_RESUME_MARKER
 rm -- "$MARKER"
 exit 0
fi
if [ "$MODE" = resume-monitor ] && [ ! -e "$PENDING" ]; then
 TEMP_PENDING=$(mktemp /var/lib/delta-maintenance/monitor-pending.XXXXXX)
 printf 'resume-monitor\n' >"$TEMP_PENDING"
 mv -T -- "$TEMP_PENDING" "$PENDING"
fi
APP_STATUS=0
systemctl start delta-staging || APP_STATUS=$?
if [ "$APP_STATUS" = 0 ]; then rm -- "$MARKER"; fi
TIMER_STATUS=0
if [ "$MODE" = resume-monitor ]; then restore_monitor || TIMER_STATUS=$?; fi
if [ "$APP_STATUS" != 0 ]; then exit "$APP_STATUS"; fi
HEALTH_STATUS=0
if [ -z "${BETTER_AUTH_URL:-}" ]; then
 echo BACKUP_RESUME_URL_MISSING
 HEALTH_STATUS=64
else
 curl --fail --silent --show-error --max-time 2 --retry 8 --retry-delay 1 --retry-connrefused --cacert /var/lib/caddy/.local/share/caddy/pki/authorities/local/root.crt "$BETTER_AUTH_URL/api/health" >/dev/null || HEALTH_STATUS=$?
fi
if [ "$TIMER_STATUS" != 0 ]; then exit "$TIMER_STATUS"; fi
exit "$HEALTH_STATUS"
