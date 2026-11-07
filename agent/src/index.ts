// Minimal agent loop. Every model call goes through Bifrost, which also
// injects the workspace tools over MCP. Bifrost only returns tool calls and
// leaves running them to us, so this is where risky calls get confirmed.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildContext, compactHistory, type Message, type ToolCall } from "./context.js";

const GATEWAY = process.env.BIFROST_URL ?? "http://localhost:8080";
const args = process.argv.slice(2);
const isPrivate = args.includes("--private");
const autoYes = args.includes("--yes");
// --naive is the baseline for the benchmark: one strong model, no repo
// context up front, full history every step.
const naive = args.includes("--naive");
const asJson = args.includes("--json");
const workspace = path.resolve(process.env.THRIFT_WORKSPACE ?? fileURLToPath(new URL("../../sandbox/demo-app", import.meta.url)));
const task = args.filter((a) => !a.startsWith("--")).join(" ");

if (!task) {
  console.error('usage: npm start -- "<task>" [--private] [--yes]');
  process.exit(1);
}

const vk = isPrivate
  ? process.env.THRIFT_VK_PRIVATE
  : naive
    ? process.env.THRIFT_VK_BASELINE
    : process.env.THRIFT_VK_DEV;
const model = isPrivate ? "ollama/qwen2.5-coder:7b" : "groq/openai/gpt-oss-120b";
const fallbacks = isPrivate || naive ? [] : ["gemini/gemini-3.5-flash", "ollama/qwen2.5-coder:7b"];

// Tools that change something on disk or run code need a yes from the user.
const RISKY = new Set(["write_file", "run_command"]);


const headers: Record<string, string> = { "Content-Type": "application/json", "x-bf-vk": vk ?? "" };
// The benchmark gives each run its own cache namespace so repeated runs
// don't get answers cached by earlier ones.
if (process.env.THRIFT_CACHE_KEY) headers["x-bf-cache-key"] = process.env.THRIFT_CACHE_KEY;
const rl = createInterface({ input: stdin, output: stdout });
const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

async function chat(messages: Message[]) {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ model, messages, fallbacks }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`gateway ${res.status}: ${body?.error?.message ?? JSON.stringify(body)}`);
  return {
    message: body.choices[0].message as Message,
    usage: body.usage ?? {},
    provider: res.headers.get("x-bifrost-routing-info-provider") ?? res.headers.get("x-bifrost-provider"),
    servedModel: res.headers.get("x-bifrost-routing-info-model"),
    fallback: res.headers.get("x-bifrost-routing-info-is-fallback") === "true",
    requestId: res.headers.get("x-bifrost-request-id"),
  };
}

async function execTool(call: ToolCall): Promise<Message> {
  const res = await fetch(`${GATEWAY}/v1/mcp/tool/execute?format=chat`, {
    method: "POST",
    headers,
    body: JSON.stringify(call),
  });
  const body = await res.json();
  if (!res.ok) return { role: "tool", tool_call_id: call.id, content: `error: ${JSON.stringify(body)}` };
  return { role: "tool", tool_call_id: call.id, content: body.content ?? JSON.stringify(body) };
}

// Short line diff for the confirmation prompt. Files here are small, so a
// plain LCS table is fine.
function diff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      out.push(gray(`  ${a[i]}`));
      i++;
      j++;
    } else if (j < b.length && (i === a.length || dp[i][j + 1] >= dp[i + 1][j])) {
      out.push(green(`+ ${b[j++]}`));
    } else {
      out.push(red(`- ${a[i++]}`));
    }
  }
  return out.join("\n");
}

async function confirm(call: ToolCall, toolName: string): Promise<boolean> {
  const input = JSON.parse(call.function.arguments || "{}");
  if (toolName === "write_file") {
    const prefix = call.function.name.slice(0, -toolName.length);
    const current = await execTool({
      id: `${call.id}-preview`,
      type: "function",
      function: { name: `${prefix}read_file`, arguments: JSON.stringify({ path: input.path }) },
    });
    const before = String(current.content ?? "").startsWith("error") ? "" : String(current.content);
    console.log(`\nwrite ${input.path}\n${diff(before, input.content)}`);
  } else {
    console.log(`\nrun: ${input.command}`);
  }
  if (autoYes) return true;
  const answer = await rl.question("apply? [y/N] ");
  return answer.trim().toLowerCase().startsWith("y");
}

const SYSTEM = naive
  ? "You are a coding agent working inside a small repository. Use the tools to look at files, " +
    "make the change, then run the tests. Paths are relative to the repo root. Keep answers short."
  : "Coding agent. The relevant files are already below, don't read them again. " +
    "Write the fix, run the tests once, reply in one line. Paths are relative to the repo root.";

const messages: Message[] = [
  { role: "system", content: SYSTEM },
  // Repo context and the task go in separate messages. Bifrost classifies
  // complexity from the latest user message only, so it sees just the task.
  ...(naive ? [] : [{ role: "user", content: await buildContext(workspace, task) }]),
  { role: "user", content: task },
];

// Small local models often print the tool call as JSON text instead of
// returning tool_calls. Pick those up so private mode still works.
function toolCallsFromText(content: string | null, step: number): ToolCall[] {
  if (!content) return [];
  const out: ToolCall[] = [];
  let i = 0;
  while ((i = content.indexOf("{", i)) !== -1) {
    // Walk to the matching brace, skipping over string contents, since
    // write_file arguments are source code full of braces.
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let j = i; j < content.length; j++) {
      const ch = content[j];
      if (inStr) {
        if (ch === "\\") j++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        end = j;
        break;
      }
    }
    if (end === -1) break;
    try {
      const obj = JSON.parse(content.slice(i, end + 1));
      if (typeof obj.name === "string" && obj.arguments && typeof obj.arguments === "object") {
        const name = obj.name.includes("-") ? obj.name : `ws-${obj.name}`;
        out.push({ id: `text-${step}-${out.length}`, type: "function", function: { name, arguments: JSON.stringify(obj.arguments) } });
        i = end + 1;
        continue;
      }
    } catch {}
    i++;
  }
  return out;
}

let tokens = 0;
let steps = 0;
const usage: { model: string; prompt: number; completion: number; fallback: boolean; requestId: string | null }[] = [];
const started = Date.now();
let stopped = false;
let error: string | null = null;
for (let step = 1; step <= 15 && !stopped; step++) {
  let r: Awaited<ReturnType<typeof chat>>;
  try {
    r = await chat(naive ? messages : compactHistory(messages));
  } catch (e: any) {
    console.log(red(e.message));
    error = e.message;
    break;
  }
  tokens += r.usage.total_tokens ?? 0;
  steps = step;
  usage.push({
    model: `${r.provider}/${r.servedModel}`,
    prompt: r.usage.prompt_tokens ?? 0,
    completion: r.usage.completion_tokens ?? 0,
    fallback: r.fallback,
    requestId: r.requestId,
  });
  const route = `${r.provider}/${r.servedModel}${r.fallback ? " (fallback)" : ""}`;
  console.log(gray(`[step ${step}] ${route}  tokens ${r.usage.total_tokens ?? "?"}`));
  if (!r.message.tool_calls?.length) {
    const recovered = toolCallsFromText(r.message.content, step);
    if (recovered.length) r.message = { role: "assistant", content: null, tool_calls: recovered };
  }
  messages.push(r.message);

  const calls = r.message.tool_calls ?? [];
  if (calls.length === 0) {
    console.log(`\n${r.message.content}`);
    break;
  }
  for (const call of calls) {
    const toolName = call.function.name.replace(/^[^-]+-/, "");
    console.log(gray(`  tool ${toolName} ${call.function.arguments}`));
    // A "no" ends the run. Otherwise models tend to retry the same change
    // through another tool, which defeats the point of asking.
    if (RISKY.has(toolName) && !(await confirm(call, toolName))) {
      console.log("rejected, stopping");
      stopped = true;
      break;
    }
    messages.push(await execTool(call));
  }
}

console.log(gray(`\ntotal tokens: ${tokens}, steps: ${steps}`));
if (asJson) console.log(JSON.stringify({ tokens, steps, stopped, error, ms: Date.now() - started, usage }));
rl.close();
