// Turns a benchmark .jsonl into a summary table and a JSON file the
// dashboard and README can use.  npm run summarize -- bench/results/run-....jsonl
import { promises as fs } from "node:fs";

const file = process.argv[2];
if (!file) throw new Error("pass a results .jsonl file");
const rows = (await fs.readFile(file, "utf8")).trim().split("\n").map((l) => JSON.parse(l));

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function stats(sel: any[]) {
  return {
    runs: sel.length,
    passRate: mean(sel.map((r) => (r.pass ? 1 : 0))),
    tokens: mean(sel.map((r) => r.tokens ?? 0)),
    cost: mean(sel.map((r) => r.cost ?? 0)),
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

await fs.writeFile(file.replace(/\.jsonl$/, ".summary.json"), JSON.stringify({ overall, byTier }, null, 2));
