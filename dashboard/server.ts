// Local event hub for the Thrift dashboard.
// The agent posts events here, the server enriches steps with gateway log data
// and streams everything to the browser over SSE. Secrets never leave this process.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const dataDir = path.join(here, "data");
const eventsFile = path.join(dataDir, "events.jsonl");
const benchDir = path.join(root, "bench", "results");
const PORT = 5199;

function loadEnv(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // no .env, gateway features stay offline
  }
  return out;
}

const env = { ...loadEnv(path.join(root, ".env")), ...process.env } as Record<string, string | undefined>;
const BIFROST_URL = (env.BIFROST_URL || "http://localhost:8080").replace(/\/$/, "");
const TOKEN = env.BIFROST_SETUP_TOKEN || "";

type Ev = { runId: string; type: string; mode?: string; at: number; [k: string]: unknown };
type Run = { runId: string; events: Ev[]; updatedAt: number };

const runs = new Map<string, Run>();
const clients = new Set<http.ServerResponse>();

fs.mkdirSync(dataDir, { recursive: true });

function addToMemory(ev: Ev) {
  let run = runs.get(ev.runId);
  if (!run) {
    run = { runId: ev.runId, events: [], updatedAt: ev.at };
    runs.set(ev.runId, run);
  }
  run.events.push(ev);
  run.updatedAt = Math.max(run.updatedAt, ev.at);
}

// Replay history on boot so past runs survive restarts.
try {
  for (const line of fs.readFileSync(eventsFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line) as Ev;
      if (ev.runId && ev.type) addToMemory(ev);
    } catch {
      // skip a broken line
    }
  }
} catch {
  // first boot
}

function broadcast(kind: string, payload: unknown) {
  const msg = `event: ${kind}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of clients) c.write(msg);
}

// ---------- Gateway ----------

type LogEntry = Record<string, unknown>;
let gatewayOnline = false;
let feed: FeedItem[] = [];

type FeedItem = {
  id: string;
  at: string;
  provider: string;
  model: string;
  key: string | null;
  status: string;
  latency: number | null;
  cost: number | null;
  tokens: number | null;
  tier: string | null;
  rule: string | null;
  fallbackIndex: number;
};

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};
const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

async function fetchLogs(limit = 100): Promise<LogEntry[] | null> {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BIFROST_URL}/api/logs?limit=${limit}`, {
      headers: { "X-Bifrost-Setup-Token": TOKEN },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { logs?: LogEntry[] };
    return body.logs ?? [];
  } catch {
    return null;
  }
}

function toFeed(e: LogEntry): FeedItem {
  const usage = (e.token_usage ?? {}) as Record<string, unknown>;
  return {
    id: String(e.id),
    at: String(e.timestamp ?? e.created_at ?? ""),
    provider: String(e.provider ?? ""),
    model: String(e.model ?? ""),
    key: str(e.virtual_key_name),
    status: String(e.status ?? "unknown"),
    latency: num(e.latency),
    cost: num(e.cost),
    tokens: num(usage.total_tokens),
    tier: str(e.complexity_tier),
    rule: str(e.routing_rule_name),
    fallbackIndex: num(e.fallback_index) ?? 0,
  };
}

async function pollFeed() {
  const logs = await fetchLogs(40);
  const online = logs !== null;
  if (online !== gatewayOnline) {
    gatewayOnline = online;
    broadcast("gateway", { online, url: BIFROST_URL });
  }
  if (!logs) return;
  const next = logs.map(toFeed);
  const known = new Set(feed.map((f) => f.id));
  const fresh = next.filter((f) => !known.has(f.id));
  feed = next;
  if (fresh.length) broadcast("feed", feed);
}
setInterval(pollFeed, 2000);
pollFeed();

function gatewayFrom(hit: LogEntry) {
  return {
    cost: num(hit.cost),
    complexityTier: str(hit.complexity_tier),
    routingRule: str(hit.routing_rule_name),
    fallbackIndex: num(hit.fallback_index) ?? 0,
    retries: num(hit.number_of_retries) ?? 0,
    latency: num(hit.latency),
    virtualKey: str(hit.virtual_key_name),
    status: str(hit.status),
  };
}

function applyHit(ev: Ev, hit: LogEntry) {
  const gateway = gatewayFrom(hit);
  ev.gateway = gateway;
  delete ev.gatewayMissing;
  broadcast("enrich", { runId: ev.runId, requestId: ev.requestId, gateway });
}

function markMissing(ev: Ev, reason: string) {
  ev.gatewayMissing = reason;
  broadcast("enrich", { runId: ev.runId, requestId: ev.requestId, missing: reason });
}

// Logs are written asynchronously by the gateway, so retry a few times.
async function enrich(ev: Ev) {
  const id = str(ev.requestId);
  if (!id) return;
  let reached = false;
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise((r) => setTimeout(r, 600 + attempt * 700));
    const logs = await fetchLogs(100);
    if (!logs) continue;
    reached = true;
    const hit = logs.find((l) => l.id === id);
    if (hit) return applyHit(ev, hit);
  }
  markMissing(ev, reached ? "not found" : "gateway offline");
}

// Runs replayed from disk have no gateway data yet. Look them up once, when a run is opened.
const backfilled = new Set<string>();
async function backfill(run: Run) {
  if (backfilled.has(run.runId)) return;
  const steps = run.events.filter((e) => e.type === "step" && str(e.requestId) && !e.gateway);
  if (!steps.length) return;
  backfilled.add(run.runId);
  await new Promise((r) => setTimeout(r, 300));
  const logs = await fetchLogs(1000);
  if (!logs) {
    backfilled.delete(run.runId);
    for (const ev of steps) markMissing(ev, "gateway offline");
    return;
  }
  const byId = new Map(logs.map((l) => [String(l.id), l]));
  for (const ev of steps) {
    const hit = byId.get(String(ev.requestId));
    if (hit) applyHit(ev, hit);
    else markMissing(ev, "not found");
  }
}

// ---------- Runs ----------

function summary(run: Run) {
  const start = run.events.find((e) => e.type === "run_start");
  const end = run.events.find((e) => e.type === "run_end");
  return {
    runId: run.runId,
    task: (start?.task as string) ?? null,
    mode: (start?.mode ?? run.events[0]?.mode ?? null) as string | null,
    startedAt: run.events[0]?.at ?? run.updatedAt,
    updatedAt: run.updatedAt,
    ended: Boolean(end),
    error: Boolean(end?.error) || run.events.some((e) => e.type === "error"),
    tokens: (end?.tokens as number) ?? null,
  };
}

// ---------- Bench ----------

function listBench() {
  let names: string[] = [];
  try {
    names = fs.readdirSync(benchDir).filter((f) => /^run-.*\.jsonl$/.test(f));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const full = path.join(benchDir, name);
      const text = fs.readFileSync(full, "utf8");
      const rows = text.split("\n").filter((l) => l.trim()).length;
      const summaryName = name.replace(/\.jsonl$/, ".summary.json");
      return {
        name,
        rows,
        mtime: fs.statSync(full).mtimeMs,
        hasSummary: fs.existsSync(path.join(benchDir, summaryName)),
        hasFreshness: text.includes('"freshness":{') || text.includes('"mode":"stale"'),
        hasCost: /"cost":\d/.test(text),
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function readBench(name: string) {
  if (!/^run-[\w.-]+\.jsonl$/.test(name)) return null;
  const full = path.join(benchDir, name);
  if (!fs.existsSync(full)) return null;
  const rows = fs
    .readFileSync(full, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  let summary = null;
  try {
    summary = JSON.parse(fs.readFileSync(full.replace(/\.jsonl$/, ".summary.json"), "utf8"));
  } catch {
    // optional
  }
  return { name, rows, summary };
}

// ---------- HTTP ----------

function send(res: http.ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 2_000_000) req.destroy();
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST",
      "access-control-allow-headers": "content-type",
    });
    return res.end();
  }

  if (req.method === "POST" && (p === "/events" || p === "/api/events")) {
    try {
      const parsed = JSON.parse(await readBody(req));
      const list: Ev[] = Array.isArray(parsed) ? parsed : [parsed];
      for (const raw of list) {
        if (!raw || typeof raw.runId !== "string" || typeof raw.type !== "string") continue;
        const ev: Ev = { ...raw, at: typeof raw.at === "number" ? raw.at : Date.now() };
        addToMemory(ev);
        fs.appendFile(eventsFile, JSON.stringify(ev) + "\n", () => {});
        broadcast("event", ev);
        if (ev.type === "step") void enrich(ev);
      }
      return send(res, 202, { ok: true });
    } catch {
      return send(res, 400, { ok: false, error: "invalid json" });
    }
  }

  if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });

  if (p === "/api/stream") {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write(`event: gateway\ndata: ${JSON.stringify({ online: gatewayOnline, url: BIFROST_URL })}\n\n`);
    res.write(`event: feed\ndata: ${JSON.stringify(feed)}\n\n`);
    clients.add(res);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      clearInterval(ping);
      clients.delete(res);
    });
    return;
  }

  if (p === "/api/runs") {
    const list = [...runs.values()].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50).map(summary);
    return send(res, 200, list);
  }

  const runMatch = p.match(/^\/api\/runs\/(.+)$/);
  if (runMatch) {
    const run = runs.get(decodeURIComponent(runMatch[1]));
    if (!run) return send(res, 404, { error: "not found" });
    send(res, 200, run);
    void backfill(run);
    return;
  }

  if (p === "/api/gateway") return send(res, 200, { online: gatewayOnline, url: BIFROST_URL, feed });
  if (p === "/api/bench") return send(res, 200, listBench());

  const benchMatch = p.match(/^\/api\/bench\/(.+)$/);
  if (benchMatch) {
    const data = readBench(decodeURIComponent(benchMatch[1]));
    return data ? send(res, 200, data) : send(res, 404, { error: "not found" });
  }

  send(res, 404, { error: "not found" });
});

server.listen(PORT, () => {
  console.log(`thrift dashboard server on http://localhost:${PORT} (gateway ${BIFROST_URL}${TOKEN ? "" : ", no token"})`);
});
