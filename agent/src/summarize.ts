// Summarizes one or more benchmark result files. A single input also gets
// a companion summary file if one does not already exist.
import { promises as fs } from "node:fs";

const files = [...new Set(process.argv.slice(2))];
if (!files.length || files.some((file) => !file.endsWith(".jsonl"))) {
  throw new Error("pass one or more results .jsonl files");
}
const inputs = await Promise.all(files.map((file) => fs.readFile(file, "utf8")));
const all = inputs.flatMap((input) => input.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line)));
// A run that died on a provider quota says nothing about the agent. Those are
// reported separately and left out of every average.
const quota = (r: any) => /\b429\b|rate limit/i.test(r.error ?? "") && !r.pass;
const rows = all.filter((r) => !quota(r));
if (all.length !== rows.length) console.log(`left out ${all.length - rows.length} runs that hit a provider quota\n`);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function stats(sel: any[]) {
  return {
    runs: sel.length,
    passRate: mean(sel.map((r) => (r.pass ? 1 : 0))),
    tokens: mean(sel.filter((r) => r.tokens != null).map((r) => r.tokens)),
    // Runs whose cost never showed up in the logs are left out, not counted as free.
    cost: mean(sel.filter((r) => r.cost != null).map((r) => r.cost)),
    costMissing: sel.filter((r) => r.cost == null).length,
    seconds: mean(sel.map((r) => (r.ms ?? 0) / 1000)),
  };
}

const modes = [...new Set(rows.map((r) => r.mode))];
const overall = Object.fromEntries(modes.map((m) => [m, stats(rows.filter((r) => r.mode === m))]));
const tiers = [...new Set(rows.map((r) => r.tier))];
const byTier = Object.fromEntries(
  tiers.map((t) => [t, Object.fromEntries(modes.map((m) => [m, stats(rows.filter((r) => r.mode === m && r.tier === t))]))]),
);

const pct = (a: number, b: number) => (b ? `${(((a - b) / b) * 100).toFixed(0)}%` : "n/a");
console.log("mode     runs  pass   tokens   cost($)    sec");
for (const m of modes) {
  const s = overall[m];
  console.log(
    `${m.padEnd(8)} ${String(s.runs).padStart(4)}  ${(s.passRate * 100).toFixed(0).padStart(3)}%  ` +
      `${s.tokens.toFixed(0).padStart(7)}  ${s.cost.toFixed(5).padStart(8)}  ${s.seconds.toFixed(1).padStart(5)}`,
  );
}
if (overall.naive && overall.thrift) {
  const n = overall.naive;
  const t = overall.thrift;
  console.log(`\ntokens ${pct(t.tokens, n.tokens)}, cost ${pct(t.cost, n.cost)}, time ${pct(t.seconds, n.seconds)}`);
}
for (const t of tiers) {
  const line = modes.map((m) => `${m} ${(byTier[t][m].passRate * 100).toFixed(0)}% ${byTier[t][m].tokens.toFixed(0)}tok`);
  console.log(`${t.padEnd(8)} ${line.join("  |  ")}`);
}

if (files.length === 1) {
  const output = files[0].replace(/\.jsonl$/, ".summary.json");
  try {
    await fs.writeFile(output, JSON.stringify({ overall, byTier }, null, 2), { flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    console.log("Existing summary kept.");
  }
}
