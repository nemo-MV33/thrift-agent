// Measures the stale-claim check on a labeled set. Each claim in
// bench/stale/claims.json has a known answer as of November 2026. The same
// small model judges every claim twice: once from what it remembers, once
// from Tavily excerpts with the quote rule. The difference is what live
// search adds.
//
//   npm run stale-eval -- [--modes memory,tavily] [--batch 3]
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { searchSettings, verifyClaims, type Claim } from "./freshness.js";
import { smallModelChat } from "./gateway.js";

type Labeled = Claim & { id: string; category: string; subject: string; truth: "current" | "outdated" };
type Status = "current" | "outdated" | "unknown";

const argv = process.argv.slice(2);
const opt = (name: string, def: string) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? def : argv[i + 1];
};
const modes = opt("modes", "memory,tavily").split(",");
const batchSize = Number(opt("batch", "3"));

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const raw: any[] = JSON.parse(await fs.readFile(path.join(root, "bench/stale/claims.json"), "utf8"));
const claims: Labeled[] = raw.map((c) => ({ ...c, library: c.subject }));
const today = new Date().toISOString().slice(0, 10);

const headers = { "Content-Type": "application/json", "x-bf-vk": process.env.THRIFT_VK_DEV ?? "" };
function chatCounting(counter: { tokens: number }) {
  return async (messages: { role: string; content: string }[]) => {
    const r = await smallModelChat(headers, messages);
    const used = r.usage.total_tokens ?? 0;
    counter.tokens += used;
    return { content: String(r.message.content ?? ""), tokens: used, requestId: r.requestId, model: `${r.provider}/${r.servedModel}` };
  };
}

function parseStatuses(text: string, n: number): Status[] {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  let list: any[] = [];
  try {
    list = start >= 0 && end > start ? JSON.parse(text.slice(start, end + 1)) : [];
  } catch {}
  return Array.from({ length: n }, (_, i) => {
    const s = list.find((item) => item?.index === i + 1)?.status;
    return s === "current" || s === "outdated" ? s : "unknown";
  });
}

async function judgeFromMemory(batch: Labeled[], counter: { tokens: number }): Promise<Status[]> {
  const chat = chatCounting(counter);
  const r = await chat([
    {
      role: "user",
      content:
        `Today is ${today}. For each claim, say whether it is still true today, based on what you know. ` +
        "Use unknown if you are not sure.\n\n" +
        batch.map((c, i) => `Claim ${i + 1} (${c.version ? `${c.library}@${c.version}` : c.library}): ${c.claim}`).join("\n") +
        '\n\nReply with JSON only: [{"index":1,"status":"current|outdated|unknown"}]',
    },
  ]);
  return parseStatuses(r.content, batch.length);
}

const rows: Record<string, unknown>[] = [];
for (const mode of modes) {
  for (let i = 0; i < claims.length; i += batchSize) {
    const batch = claims.slice(i, i + batchSize);
    const counter = { tokens: 0 };
    const started = Date.now();
    let statuses: Status[];
    let sources: (string | null)[] = batch.map(() => null);
    let searches = 0;
    let failedSearches = 0;
    if (mode === "memory") {
      statuses = await judgeFromMemory(batch, counter);
    } else {
      const report = await verifyClaims(batch, chatCounting(counter), `Today is ${today}. Use the search excerpts as evidence for whether each claim is still true today.`);
      statuses = report.verdicts.map((v) => v.status);
      sources = report.verdicts.map((v) => v.source);
      searches = report.searches;
      failedSearches = report.failedSearches;
    }
    const ms = Date.now() - started;
    batch.forEach((c, j) => {
      const row = {
        id: c.id, category: c.category, mode, truth: c.truth, status: statuses[j], source: sources[j],
        tokens: counter.tokens / batch.length, ms: ms / batch.length, searches: searches / batch.length, failedSearches,
        search: mode === "tavily" ? searchSettings : null,
      };
      rows.push(row);
      console.log(`${mode.padEnd(7)} ${c.truth.padEnd(9)} -> ${statuses[j].padEnd(9)} ${c.id}`);
    });
    // Groq's free tier counts tokens per minute. A short pause keeps the
    // judge on the same model for the whole run.
    await new Promise((resolve) => setTimeout(resolve, 4000));
  }
}

const out = path.join(root, "bench/stale/results", `run-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
await fs.mkdir(path.dirname(out), { recursive: true });
await fs.writeFile(out, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`\nwrote ${path.relative(root, out)}\n`);

console.log("mode     right  stale caught  stale passed as current  false alarms  unknown  tokens/claim");
for (const mode of modes) {
  const r = rows.filter((x) => x.mode === mode);
  const stale = r.filter((x) => x.truth === "outdated");
  const fresh = r.filter((x) => x.truth === "current");
  const right = r.filter((x) => x.status === x.truth).length;
  const tokens = r.reduce((a, x) => a + (x.tokens as number), 0) / r.length;
  console.log(
    `${mode.padEnd(8)} ${`${right}/${r.length}`.padStart(5)}  ` +
      `${`${stale.filter((x) => x.status === "outdated").length}/${stale.length}`.padStart(12)}  ` +
      `${`${stale.filter((x) => x.status === "current").length}/${stale.length}`.padStart(23)}  ` +
      `${`${fresh.filter((x) => x.status === "outdated").length}/${fresh.length}`.padStart(12)}  ` +
      `${String(r.filter((x) => x.status === "unknown").length).padStart(7)}  ${tokens.toFixed(0).padStart(12)}`,
  );
}
