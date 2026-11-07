// Benchmark runner. For every task it copies the fixture repo into the
// workspace, runs the agent in both modes, restores the original tests so
// the agent can't pass by editing them, and records pass/fail, tokens,
// cost (as Bifrost computed it) and time.
//
//   npm run bench -- [--runs 3] [--only 03] [--modes naive,thrift]
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
const only = opt("only", "");
const modes = opt("modes", "naive,thrift").split(",");
// Groq's free tier allows 8k tokens a minute on the big model, so runs are
// spaced out. Otherwise the baseline would keep failing over to Gemini.
const pauseMs = Number(opt("pause", "20000"));

type Step = { model: string; prompt: number; completion: number; fallback: boolean; requestId: string | null };
type AgentOut = { tokens: number; steps: number; stopped: boolean; ms: number; usage: Step[] };

async function resetWorkspace(repo: string) {
  // Keep the directory itself: Bifrost's MCP server has it open as its root.
  await fs.mkdir(workspace, { recursive: true });
  for (const e of await fs.readdir(workspace)) await fs.rm(path.join(workspace, e), { recursive: true, force: true });
  await fs.cp(repo, workspace, { recursive: true });
}

function runAgent(prompt: string, mode: string, cacheKey: string): Promise<AgentOut | null> {
  const args = ["tsx", path.join(here, "index.ts"), prompt, "--yes", "--json"];
  if (mode === "naive") args.push("--naive");
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

async function costOf(ids: string[]): Promise<number | null> {
  if (!ids.length) return 0;
  try {
    const res = await fetch(`${GATEWAY}/api/logs?limit=500`, {
      headers: { "X-Bifrost-Setup-Token": process.env.BIFROST_SETUP_TOKEN ?? "" },
    });
    const body: any = await res.json();
    const byId = new Map<string, any>(body.logs.map((l: any) => [l.id, l]));
    return ids.reduce((sum, id) => sum + (byId.get(id)?.cost ?? 0), 0);
  } catch {
    return null;
  }
}

const tasks = (await fs.readdir(tasksDir)).filter((t) => !only || t.startsWith(only)).sort();
await fs.mkdir(resultsDir, { recursive: true });
const outFile = path.join(resultsDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
console.log(`${tasks.length} tasks x ${modes.length} modes x ${runs} runs -> ${path.relative(projectRoot, outFile)}`);

for (const task of tasks) {
  const meta = JSON.parse(await fs.readFile(path.join(tasksDir, task, "task.json"), "utf8"));
  const repo = path.join(tasksDir, task, "repo");
  for (let r = 1; r <= runs; r++) {
    for (const mode of modes) {
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
        crashed: out === null,
        error: (out as any)?.error ?? null,
      };
      await fs.appendFile(outFile, JSON.stringify(row) + "\n");
      console.log(
        `${task.padEnd(28)} ${mode.padEnd(6)} #${r} ${pass ? "PASS" : "FAIL"} ` +
          `tokens=${row.tokens} cost=${cost?.toFixed(5)} ${row.models.join(",")}`,
      );
      await new Promise((ok) => setTimeout(ok, mode === "naive" ? pauseMs : pauseMs / 4));
    }
  }
}
console.log(`done -> ${outFile}`);
