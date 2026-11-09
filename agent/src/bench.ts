// Benchmark runner. For every task it copies the fixture repo into the
// workspace, runs the agent in both modes, restores the original tests so
// the agent can't pass by editing them, and records pass/fail, tokens,
// cost (as Bifrost computed it) and time.
//
//   npm run bench -- [--runs 3] [--only 07,08,09] [--modes naive,thrift]
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");
const tasksDir = path.join(projectRoot, "bench/tasks");
const resultsDir = path.join(projectRoot, "bench/results");
const workspace = path.join(projectRoot, "sandbox/demo-app");
const GATEWAY = process.env.BIFROST_URL ?? "http://localhost:8080";

const argv = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const runs = Number(opt("runs", "3"));
const only = opt("only", "").split(",").map((prefix) => prefix.trim()).filter(Boolean);
const modes = opt("modes", "naive,thrift").split(",");
// Groq's free tier allows 8k tokens a minute on the big model, so runs are
// spaced out. Otherwise the baseline would keep failing over to Gemini.
const pauseMs = Number(opt("pause", "20000"));

type Step = { model: string; prompt: number; completion: number; fallback: boolean; cacheHit?: boolean; requestId: string | null };
type AgentOut = {
  tokens: number; steps: number; stopped: boolean; ms: number; usage: Step[];
  error?: string | null; freshness?: any; freshnessFailed?: boolean;
};

async function resetWorkspace(repo: string) {
  // Keep the directory itself: Bifrost's MCP server has it open as its root.
  await fs.mkdir(workspace, { recursive: true });
  for (const e of await fs.readdir(workspace)) await fs.rm(path.join(workspace, e), { recursive: true, force: true });
  await fs.cp(repo, workspace, { recursive: true });
}

function runAgent(prompt: string, mode: string, cacheKey: string): Promise<AgentOut | null> {
  const args = ["tsx", path.join(here, "index.ts"), prompt, "--yes", "--json"];
  if (mode === "naive") args.push("--naive");
  // "stale" is thrift with the freshness check off, to measure what Tavily adds.
  if (mode === "stale") args.push("--no-fresh");
  return new Promise((resolve) => {
    const child = spawn("npx", args, {
      cwd: path.join(here, ".."),
      env: { ...process.env, THRIFT_CACHE_KEY: cacheKey },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 240_000);
    child.on("close", () => {
      clearTimeout(timer);
      const last = out.trim().split("\n").reverse().find((l) => l.startsWith('{"tokens"'));
      resolve(last ? JSON.parse(last) : null);
    });
  });
}

async function passes(): Promise<boolean> {
  try {
    await run("npm", ["test", "--silent"], { cwd: workspace, timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

// Bifrost writes logs asynchronously, and a fast run can finish before its
// last entries land. Earlier versions summed whatever was there and reported
// cost 0 for quick runs. Now we wait until every request id shows up, and
// return null (not 0) if some never do.
async function costOf(ids: string[]): Promise<number | null> {
  if (!ids.length) return 0;
  // One fetch per attempt covers every id. Short waits first, since the log
  // writer usually catches up within a second; about 10 s in total.
  for (const wait of [0, 300, 700, 1000, 2000, 3000, 3000]) {
    if (wait) await new Promise((ok) => setTimeout(ok, wait));
    try {
      const res = await fetch(`${GATEWAY}/api/logs?limit=500`, {
        headers: { "X-Bifrost-Setup-Token": process.env.BIFROST_SETUP_TOKEN ?? "" },
      });
      const body: any = await res.json();
      // A request that failed over shows up as the failed attempt plus a
      // separate entry for the fallback, linked by parent_request_id.
      const byRoot = new Map<string, any[]>();
      for (const l of body.logs ?? []) {
        for (const key of new Set([l.id, l.parent_request_id].filter(Boolean))) {
          const list = byRoot.get(key) ?? [];
          list.push(l);
          byRoot.set(key, list);
        }
      }
      const entries = (id: string) => byRoot.get(id) ?? [];
      if (ids.every((id) => entries(id).some((l) => l.status === "success" && l.cost != null)))
        return ids.reduce((sum, id) => sum + entries(id).reduce((s, l) => s + (l.cost ?? 0), 0), 0);
    } catch {}
  }
  return null;
}

const tasks = (await fs.readdir(tasksDir))
  .filter((task) => !only.length || only.some((prefix) => task.startsWith(prefix)))
  .sort();
await fs.mkdir(resultsDir, { recursive: true });
const outFile = path.join(resultsDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
console.log(`${tasks.length} tasks x ${modes.length} modes x ${runs} runs -> ${path.relative(projectRoot, outFile)}`);

let naiveQuotaHit = false;
for (const task of tasks) {
  const meta = JSON.parse(await fs.readFile(path.join(tasksDir, task, "task.json"), "utf8"));
  const repo = path.join(tasksDir, task, "repo");
  // Some tasks pin real npm packages (the freshness ones). node_modules is
  // not in git, so install once on a fresh checkout.
  const pkg = JSON.parse(await fs.readFile(path.join(repo, "package.json"), "utf8"));
  if (pkg.dependencies && !(await fs.stat(path.join(repo, "node_modules")).catch(() => null)))
    await run("npm", ["install", "--silent"], { cwd: repo });
  for (let r = 1; r <= runs; r++) {
    for (const mode of modes) {
      if (mode === "naive" && naiveQuotaHit) continue;
      await resetWorkspace(repo);
      const out = await runAgent(meta.prompt, mode, `bench-${Date.now()}-${task}-${mode}-${r}`);
      // Put the original tests back before judging.
      for (const f of meta.protected ?? []) await fs.cp(path.join(repo, f), path.join(workspace, f));
      const pass = out !== null && (await passes());
      await new Promise((ok) => setTimeout(ok, 1500)); // let the log writer flush
      const cost = out ? await costOf(out.usage.map((u) => u.requestId).filter(Boolean) as string[]) : null;
      const row = {
        task,
        tier: meta.tier,
        mode,
        run: r,
        pass,
        tokens: out?.tokens ?? null,
        steps: out?.steps ?? null,
        ms: out?.ms ?? null,
        cost,
        models: [...new Set(out?.usage.map((u) => u.model) ?? [])],
        fallbacks: out?.usage.filter((u) => u.fallback).length ?? 0,
        cacheHits: out?.usage.filter((u) => u.cacheHit).length ?? 0,
        requestIds: out?.usage.map((u) => u.requestId).filter(Boolean) ?? [],
        crashed: out === null,
        error: out?.error ?? null,
        ...(out?.freshnessFailed ? { freshnessFailed: true } : {}),
        freshness: out?.freshness
          ? { searches: out.freshness.searches, tokens: out.freshness.tokens, verdicts: out.freshness.verdicts }
          : null,
      };
      await fs.appendFile(outFile, JSON.stringify(row) + "\n");
      console.log(
        `${task.padEnd(28)} ${mode.padEnd(6)} #${r} ${pass ? "PASS" : "FAIL"} ` +
          `tokens=${row.tokens} cost=${cost?.toFixed(5)} ${row.models.join(",")}`,
      );
      if (mode === "naive" && !pass && /\b429\b|rate limit/i.test(row.error ?? "")) {
        naiveQuotaHit = true;
        console.log("Naive hit a provider quota. Skipping the remaining naive runs in this batch.");
      }
      await new Promise((ok) => setTimeout(ok, mode === "naive" ? pauseMs : pauseMs / 4));
    }
  }
}
console.log(`done -> ${path.relative(projectRoot, outFile)}`);
