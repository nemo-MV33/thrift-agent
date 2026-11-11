// Stale-answer checker. Give it any answer an LLM wrote and it lists the
// claims that could have gone out of date, checks each one against live web
// sources with Tavily, and gives it a freshness score. The coding agent runs
// the same verification step on its own before it edits code.
//
//   npm run check -- answer.txt [--json]
//   pbpaste | npm run check
import { promises as fs } from "node:fs";
import { parseClaims, verifyClaims, type Claim } from "./freshness.js";
import { smallModelChat, type Purpose } from "./gateway.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const file = args.find((a) => !a.startsWith("--"));

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const answer = (file ? await fs.readFile(file, "utf8") : await readStdin()).trim();
if (!answer) {
  console.error("usage: npm run check -- <answer.txt> [--json]   (or pipe the answer on stdin)");
  process.exit(1);
}
if (!process.env.TAVILY_API_KEY) {
  console.error("TAVILY_API_KEY is not set.");
  process.exit(1);
}

const headers = { "Content-Type": "application/json", "x-bf-vk": process.env.THRIFT_VK_DEV ?? "" };
let tokens = 0;
const chat = async (messages: { role: string; content: string }[], purpose: Purpose = "judge") => {
  // Same small model and settings as the agent's own freshness check.
  const r = await smallModelChat(headers, messages, purpose);
  const used = r.usage.total_tokens ?? 0;
  tokens += used;
  return { content: String(r.message.content ?? ""), tokens: used, requestId: r.requestId };
};

const today = new Date().toISOString().slice(0, 10);
const extracted = await chat([
  {
    role: "user",
    content:
      `Today is ${today}. Below is an answer written by an AI assistant. List the factual statements in it that ` +
      "could have changed since the model was trained: prices and plans, software versions and API behavior, " +
      "laws and regulations, company leadership, ownership or products. Skip opinions, definitions and facts that " +
      "do not change. At most 5, the ones most likely to be out of date first. For each, give the subject " +
      "(product, company, library or law), the version if the claim names one, the claim in one sentence, and a " +
      "web search query that would confirm or refute it today. Reply with JSON only: " +
      '[{"library":"subject","version":"","claim":"","query":""}]\n\nAnswer:\n' +
      answer.slice(0, 8000),
  },
], "extract");
const claims: Claim[] = parseClaims(extracted.content)
  .filter((c) => c.library.trim() && c.claim.trim() && c.query.trim())
  .slice(0, 5);

const report = await verifyClaims(
  claims,
  chat,
  `Today is ${today}. Use the search excerpts as evidence for whether each claim is still true today.`,
);

if (asJson) {
  console.log(JSON.stringify({ ...report, tokens }, null, 2));
} else if (!claims.length) {
  console.log("No time-sensitive claims found in this answer.");
} else {
  const label = { current: "CURRENT ", outdated: "OUTDATED", unknown: "UNKNOWN " } as const;
  for (const v of report.verdicts) {
    console.log(`${label[v.status]}  score ${v.freshness.toFixed(1)}  ${v.library}: ${v.claim}`);
    if (v.correction) console.log(`          now: ${v.correction}`);
    if (v.source) console.log(`          source: ${v.source}`);
  }
  const stale = report.verdicts.filter((v) => v.status === "outdated").length;
  const unknown = report.verdicts.filter((v) => v.status === "unknown").length;
  console.log(
    `\n${report.verdicts.length} claims checked, ${stale} outdated, ${unknown} without enough evidence. ` +
      `${report.searches} searches${report.failedSearches ? ` (${report.failedSearches} failed)` : ""}, ${tokens} model tokens.`,
  );
}
