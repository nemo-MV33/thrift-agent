#!/bin/sh
# Pass --fresh to rebuild Bifrost's local databases, or --config-only
# to refresh the generated paths without restarting the gateway.
cd "$(dirname "$0")/.." || exit 1
set -a; . ./.env || exit 1; set +a
node <<'JS' || exit 1
const fs = require("node:fs");
const path = require("node:path");
const root = process.cwd();
const workspace = path.resolve(root, process.env.THRIFT_WORKSPACE ?? "sandbox/demo-app");
const vars = { THRIFT_ROOT: root, THRIFT_WORKSPACE: workspace };
const config = JSON.parse(fs.readFileSync("bifrost/config.template.json", "utf8"), (_, value) =>
  typeof value === "string"
    ? value.replace(/\$\{(THRIFT_ROOT|THRIFT_WORKSPACE)\}/g, (_, key) => vars[key])
    : value,
);
fs.writeFileSync("bifrost/config.json", JSON.stringify(config, null, 2) + "\n");
JS
[ "$1" = "--config-only" ] && exit 0
pkill -f bifrost-http 2>/dev/null && sleep 1
[ "$1" = "--fresh" ] && rm -f bifrost/config.db bifrost/logs.db
node <<'JS' || exit 1
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const log = fs.openSync("bifrost/run.log", "w");
spawn("npx", ["-y", "@maximhq/bifrost", "-app-dir", "./bifrost", "-port", "8080"], {
  detached: true,
  stdio: ["ignore", log, log],
}).unref();
fs.closeSync(log);
JS
for i in $(seq 1 120); do
  if grep -q 'Connected to MCP' bifrost/run.log && curl -fsS --max-time 2 http://localhost:8080/health >/dev/null 2>&1; then
    echo "gateway up on http://localhost:8080"
    exit 0
  fi
  sleep 1
done
echo "gateway did not become ready. Check bifrost/run.log." >&2
exit 1
