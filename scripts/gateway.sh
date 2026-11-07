#!/bin/sh
# Starts Bifrost from bifrost/config.json. Pass --fresh to drop the local
# database so config.json changes are picked up from scratch.
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a
# config.json is generated: the MCP server needs absolute paths, which differ per machine.
THRIFT_ROOT="$(pwd)"
sed "s|\${THRIFT_ROOT}|$THRIFT_ROOT|g" bifrost/config.template.json > bifrost/config.json
pkill -f bifrost-http 2>/dev/null && sleep 1
[ "$1" = "--fresh" ] && rm -f bifrost/config.db bifrost/logs.db
nohup npx -y @maximhq/bifrost -app-dir ./bifrost -port 8080 > bifrost/run.log 2>&1 &
for i in $(seq 1 60); do grep -q 'Connected to MCP' bifrost/run.log && break; sleep 1; done
# The complexity classifier embeds its reference phrases on startup.
sleep 12
echo "gateway up on http://localhost:8080"
