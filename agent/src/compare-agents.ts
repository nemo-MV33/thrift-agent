// Runs other coding agents on the same benchmark tasks, for comparison with
// Thrift. Each attempt gets a fresh copy of the fixture in a temp directory,
// the agent runs without approval prompts, the protected tests are put back
// and npm test decides pass or fail, the same way bench.ts judges Thrift.
//
// Tokens are what the agent itself reports. Cached input counts too, since
// the model still reads it: Thrift's numbers include every prompt token as
// well. The split is kept in the row.
//
//   CLAUDE_BIN=... CODEX_BIN=... npm run compare -- [--agents claude-code,codex] [--only 01,12] [--runs 1]
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "../..");
const tasksDir = path.join(projectRoot, "bench/tasks");
const resultsDir = path.join(projectRoot, "bench/results");

const argv = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const agents = opt("agents", "claude-code,codex").split(",");
const only = opt("only", "").split(",").map((p) => p.trim()).filter(Boolean);
const runs = Number(opt("runs", "1"));

// cached: input read from the provider's prompt cache, billed at a discount.
// cacheWrite: input written to it, which Anthropic bills above the normal
// input price, so it counts as new work, not as cache.
type Usage = { input: number; cached: number; cacheWrite: number; output: number };
type AgentResult = { usage: Usage; steps: number | null; model: string | null; cost: number | null; error: string | null };

function exec(bin: string, args: string[], cwd: string, timeoutMs = 600_000): Promise<{ out: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ out, code });
    });
  });
}

// claude -p prints one JSON object with usage, turns and the models used.
async function claudeCode(prompt: string, cwd: string): Promise<AgentResult> {
  const bin = process.env.CLAUDE_BIN ?? "claude";
  const { out } = await exec(bin, ["-p", prompt, "--output-format", "json", "--dangerously-skip-permissions", "--strict-mcp-config"], cwd);
  const line = out.trim().split("\n").reverse().find((l) => l.startsWith("{"));
  if (!line) return { usage: { input: 0, cached: 0, cacheWrite: 0, output: 0 }, steps: null, model: null, cost: null, error: out.slice(-300) };
  const j = JSON.parse(line);
  // modelUsage covers every model the run used, subagents included.
  const per = Object.entries<any>(j.modelUsage ?? {});
  const usage = per.length
    ? per.reduce(
        (u, [, m]) => ({
          input: u.input + (m.inputTokens ?? 0),
          cached: u.cached + (m.cacheReadInputTokens ?? 0),
          cacheWrite: u.cacheWrite + (m.cacheCreationInputTokens ?? 0),
          output: u.output + (m.outputTokens ?? 0),
        }),
        { input: 0, cached: 0, cacheWrite: 0, output: 0 },
      )
    : {
        input: j.usage?.input_tokens ?? 0,
        cached: j.usage?.cache_read_input_tokens ?? 0,
        cacheWrite: j.usage?.cache_creation_input_tokens ?? 0,
        output: j.usage?.output_tokens ?? 0,
      };
  return {
    usage,
    steps: j.num_turns ?? null,
    model: per.map(([name]) => name).join(",") || null,
    cost: j.total_cost_usd ?? null,
    error: j.is_error ? String(j.result ?? "error").slice(0, 300) : null,
  };
}

// codex exec --json streams events. Each finished turn carries its usage, and
// input_tokens already includes the cached part.
async function codex(prompt: string, cwd: string): Promise<AgentResult> {
  const bin = process.env.CODEX_BIN ?? "codex";
  const { out, code } = await exec(bin, ["exec", "--json", "--skip-git-repo-check", "--dangerously-bypass-approvals-and-sandbox", prompt], cwd);
  const usage = { input: 0, cached: 0, cacheWrite: 0, output: 0 };
  let turns = 0;
  let model: string | null = null;
  let error: string | null = null;
  for (const l of out.split("\n")) {
    if (!l.startsWith("{")) continue;
    let e: any;
    try {
      e = JSON.parse(l);
    } catch {
      continue;
    }
    if (e.type === "turn.completed" && e.usage) {
      turns++;
      const cached = e.usage.cached_input_tokens ?? 0;
      usage.input += (e.usage.input_tokens ?? 0) - cached;
      usage.cached += cached;
      usage.output += e.usage.output_tokens ?? 0;
    }
    if (e.model) model = e.model;
    if (e.type === "error" || e.type === "turn.failed") error = JSON.stringify(e).slice(0, 300);
  }
  if (!turns && code !== 0) error ??= out.slice(-300);
  return { usage, steps: turns || null, model, cost: null, error };
}

async function passes(dir: string): Promise<boolean> {
  try {
    await run("npm", ["test", "--silent"], { cwd: dir, timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

const tasks = (await fs.readdir(tasksDir)).filter((t) => !only.length || only.some((p) => t.startsWith(p))).sort();
await fs.mkdir(resultsDir, { recursive: true });
const outFile = path.join(resultsDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
console.log(`${tasks.length} tasks x ${agents.join(",")} x ${runs} runs -> ${path.relative(projectRoot, outFile)}`);

for (const task of tasks) {
  const meta = JSON.parse(await fs.readFile(path.join(tasksDir, task, "task.json"), "utf8"));
  const repo = path.join(tasksDir, task, "repo");
  const pkg = JSON.parse(await fs.readFile(path.join(repo, "package.json"), "utf8"));
  if (pkg.dependencies && !(await fs.stat(path.join(repo, "node_modules")).catch(() => null)))
    await run("npm", ["install", "--silent"], { cwd: repo });
  for (let r = 1; r <= runs; r++) {
    for (const agent of agents) {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), `thrift-compare-${task}-`));
      await fs.cp(repo, dir, { recursive: true });
      const started = Date.now();
      const res = agent === "codex" ? await codex(meta.prompt, dir) : await claudeCode(meta.prompt, dir);
      const ms = Date.now() - started;
      for (const f of meta.protected ?? []) await fs.cp(path.join(repo, f), path.join(dir, f));
      const pass = await passes(dir);
      await fs.rm(dir, { recursive: true, force: true });
      const tokens = res.usage.input + res.usage.cached + res.usage.cacheWrite + res.usage.output;
      const row = {
        task, tier: meta.tier, mode: agent, run: r, pass, tokens, usage: res.usage, steps: res.steps, ms,
        cost: res.cost, models: res.model ? [res.model] : [],
        // An agent that errored out (usage cap, not logged in) never really
        // tried, so it is kept out of the pass rate rather than counted as a fail.
        crashed: tokens === 0 || res.error !== null, error: res.error,
      };
      await fs.appendFile(outFile, JSON.stringify(row) + "\n");
      console.log(
        `${task.padEnd(28)} ${agent.padEnd(11)} #${r} ${pass ? "PASS" : "FAIL"} tokens=${tokens} ` +
          `(new ${res.usage.input}, cache read ${res.usage.cached}, cache write ${res.usage.cacheWrite}, out ${res.usage.output}) ${res.model ?? ""}`,
      );
    }
  }
}
console.log(`done -> ${path.relative(projectRoot, outFile)}`);
