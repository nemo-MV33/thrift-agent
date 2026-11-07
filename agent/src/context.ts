// Context building and trimming. Most of the token savings come from here:
// the model gets the files it most likely needs up front, so it skips the
// list/read round trips, and old tool output is cut out of the history
// because every step resends the whole conversation.
import { promises as fs } from "node:fs";
import path from "node:path";

export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type Message = { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };

const SKIP = new Set(["node_modules", ".git", "dist", "build", "coverage"]);
const TEXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|json|md|toml|yaml|yml|css|html)$/;

async function walk(root: string, dir = root, out: string[] = []): Promise<string[]> {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(root, full, out);
    else out.push(path.relative(root, full));
  }
  return out;
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []);

// Rank files by how well their path matches the task. Tests count a bit
// extra since the agent nearly always needs them to know what "done" means.
function score(file: string, task: Set<string>): number {
  const name = file.toLowerCase();
  let s = 0;
  for (const w of task) if (name.includes(w)) s += 3;
  if (/test|spec/.test(name)) s += 1;
  if (name.endsWith("package.json")) s += 0.5;
  return s;
}

/**
 * Builds the repo context message: file tree plus the contents of the most
 * relevant files, up to a character budget (roughly 4 chars per token).
 */
export async function buildContext(root: string, task: string, budgetChars = 12_000): Promise<string> {
  const files = (await walk(root)).sort();
  const taskWords = words(task);
  const ranked = files
    .filter((f) => TEXT.test(f))
    .map((f) => ({ f, s: score(f, taskWords) }))
    .sort((a, b) => b.s - a.s);

  const parts = [`Repository files:\n${files.join("\n")}`];
  let used = parts[0].length;
  const included: string[] = [];
  for (const { f, s } of ranked) {
    // Small repos fit whole; in bigger ones only files with some match get in.
    if (s === 0 && files.length > 15) continue;
    const body = await fs.readFile(path.join(root, f), "utf8");
    if (used + body.length > budgetChars) continue;
    parts.push(`--- ${f}\n${body}`);
    used += body.length;
    included.push(f);
  }
  return parts.join("\n\n");
}

/**
 * Replaces tool output older than the last `keep` tool messages with a short
 * stub. The model already acted on it; resending it each step is pure cost.
 */
export function compactHistory(messages: Message[], keep = 2): Message[] {
  const toolIdx = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  const cut = new Set(toolIdx.slice(0, Math.max(0, toolIdx.length - keep)));
  return messages.map((m, i) => {
    if (!cut.has(i) || !m.content || m.content.length < 200) return m;
    const lines = m.content.split("\n");
    return { ...m, content: `${lines[0].slice(0, 120)} [${lines.length} lines trimmed]` };
  });
}
