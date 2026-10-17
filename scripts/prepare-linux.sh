#!/usr/bin/env sh
# Run as the application user inside the reviewed release checkout. No sudo/cloud/DNS changes.
set -eu
cd "$(dirname "$0")/.."
test -f package-lock.json
node -e 'if (Number(process.versions.node.split(".")[0]) !== 24) { console.error("Use the verified Node 24 runtime."); process.exit(1); }'
npm ci --omit=dev
printf '%s\n' 'Dependencies ready. No service started and no public port opened.'
