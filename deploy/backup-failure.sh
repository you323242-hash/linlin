#!/usr/bin/env bash
set -euo pipefail
case "${SERVICE_RESULT:-}" in
 timeout|signal|core-dump|watchdog|oom-kill)
  cd /opt/delta-staging/current
  __NODE_BINARY__ scripts/backup-status.mjs failed
  ;;
esac
