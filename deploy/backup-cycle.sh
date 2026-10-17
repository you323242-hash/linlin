#!/usr/bin/env bash
set -euo pipefail
cd /opt/delta-staging/current
NODE_BINARY=__NODE_BINARY__
exec 9>/var/lib/delta-maintenance/backup.lock
flock -n 9 || exit 1
# Respect an intentionally stopped application. Never start it merely for a timer.
systemctl is-active --quiet delta-staging || exit 0
MONITOR_WAS_ACTIVE=0
if systemctl is-active --quiet delta-monitor.timer; then MONITOR_WAS_ACTIVE=1; fi
SUCCESS=0
finish() {
 local code=$?
 trap - EXIT
 if ! /usr/bin/bash deploy/backup-resume.sh owner; then code=1; SUCCESS=0; fi
 if [ "$SUCCESS" = 1 ]; then
  "$NODE_BINARY" scripts/backup-status.mjs ok || code=1
 else
  "$NODE_BINARY" scripts/backup-status.mjs failed || code=1
 fi
 chown root:delta-staging /var/lib/delta-monitor/backup-status.json || code=1
 exit "$code"
}
trap finish EXIT
trap 'exit 143' TERM HUP
trap 'exit 130' INT
test "$(stat -c %U /etc/delta/backup.key)" = root
test "$(stat -c %a /etc/delta/backup.key)" = 600
test "$(df -B1 --output=avail /var/backups/delta-staging | tail -n1 | tr -d ' ')" -gt 5368709120
if [ "$MONITOR_WAS_ACTIVE" = 1 ]; then
 printf 'resume-monitor\n' >/var/lib/delta-maintenance/paused
else
 printf 'resume\n' >/var/lib/delta-maintenance/paused
fi
systemctl stop delta-monitor.timer delta-monitor.service
systemctl stop delta-staging
TARGET=/var/backups/delta-staging/nightly-$(date -u +%Y%m%dT%H%M%SZ)-$$
"$NODE_BINARY" scripts/backup.mjs create "$TARGET"
"$NODE_BINARY" scripts/backup.mjs verify "$TARGET"
"$NODE_BINARY" scripts/payment-check.mjs
# Reduce downtime: the restore drill reads the completed encrypted snapshot only.
/usr/bin/bash deploy/backup-resume.sh owner
"$NODE_BINARY" scripts/recovery-check.mjs "$TARGET"
SUCCESS=1
