// Minimal agent loop. Every model call goes through Bifrost, which also
// injects the workspace tools over MCP. Bifrost only returns tool calls and
// leaves running them to us, so this is where risky calls get confirmed.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFreshness, freshnessNotes } from "./freshness.js";
import { buildContext, compactHistory, dropFile, type Message, type ToolCall } from "./context.js";

const GATEWAY = process.env.BIFROST_URL ?? "http://localhost:8080";
const args = process.argv.slice(2);
const isPrivate = args.includes("--private");
const autoYes = args.includes("--yes");
// --naive is the baseline for the benchmark: one strong model, no repo
// context up front, full history every step.
const naive = args.includes("--naive");
const asJson = args.includes("--json");
// Private repos never leave the machine, so no web lookups there either.
const fresh = !naive && !isPrivate && !args.includes("--no-fresh");
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
let model = isPrivate ? "ollama/qwen2.5-coder:7b" : "groq/openai/gpt-oss-120b";
let fallbacks = isPrivate || naive ? [] : ["gemini/gemini-3.5-flash", "ollama/qwen2.5-coder:7b"];

// Tools that change something on disk or run code need a yes from the user.
const RISKY = new Set(["write_file", "run_command"]);


const headers: Record<string, string> = { "Content-Type": "application/json", "x-bf-vk": vk ?? "" };
// The benchmark gives each run its own cache namespace so repeated runs
// don't get answers cached by earlier ones.
if (process.env.THRIFT_CACHE_KEY) headers["x-bf-cache-key"] = process.env.THRIFT_CACHE_KEY;
// Live events for the dashboard. Fire and forget: the agent must never wait
// on, or fail because of, the dashboard.
const EVENTS = process.env.THRIFT_EVENTS_URL ?? "http://localhost:5199/events";
const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const mode = isPrivate ? "private" : naive ? "naive" : "thrift";
function emit(type: string, data: Record<string, unknown> = {}) {
  fetch(EVENTS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId, type, mode, at: Date.now(), ...data }),
    signal: AbortSignal.timeout(type === "run_end" ? 3000 : 1000),
  }).catch(() => {});
}

const rl = createInterface({ input: stdin, output: stdout });
const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;

// Bifrost's complexity router only looks at the latest message. After the
// first step that is a tool result ("exit 0 ..."), which says nothing about
// how hard the task is. So the first request is routed on the task itself,
// and later steps stay on whatever model it picked. The pinned header turns
// the tier rules off for those requests (see bifrost/config.json).
let pinned = false;

async function chat(messages: Message[]) {
  const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
    method: "POST",
    headers: pinned ? { ...headers, "x-thrift-pinned": "1" } : headers,
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
    cacheHit: res.headers.get("x-bifrost-cache-hit") === "true",
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
  const detail = toolName === "write_file" ? { path: input.path } : { command: input.command };
  if (autoYes) {
    emit("approval", { tool: toolName, ...detail, approved: true, auto: true });
    return true;
  }
  emit("approval_wait", { tool: toolName, ...detail });
  const answer = await rl.question("apply? [y/N] ");
  const approved = answer.trim().toLowerCase().startsWith("y");
  emit("approval", { tool: toolName, ...detail, approved, auto: false });
  return approved;
}

const SYSTEM = naive
  ? "You are a coding agent working inside a small repository. Use the tools to look at files, " +
    "make the change, then run the tests. Paths are relative to the repo root. Keep answers short."
  : "Coding agent. The relevant files are already below, don't read them again. " +
    "Write the fix, run the tests once, reply in one line. Paths are relative to the repo root.";

emit("run_start", { task, workspace: path.basename(workspace) });
let tokens = 0;
const usage: { model: string; prompt: number; completion: number; fallback: boolean; cacheHit: boolean; requestId: string | null }[] = [];
const started = Date.now();
let freshness: Awaited<ReturnType<typeof checkFreshness>> = null;
if (fresh) {
  // Claim extraction and judging are short JSON jobs, the small model is enough.
  freshness = await checkFreshness(workspace, task, async (msgs) => {
    const res = await fetch(`${GATEWAY}/v1/chat/completions`, {
      method: "POST",
      // An empty include list keeps Bifrost from attaching the workspace tools:
      // these calls must answer in JSON, not go read files.
      headers: { ...headers, "x-thrift-pinned": "1", "x-bf-mcp-include-clients": "" },
      body: JSON.stringify({ model: "groq/openai/gpt-oss-20b", messages: msgs, tools: [], fallbacks: ["gemini/gemini-3.5-flash-lite"] }),
    });
    const body: any = await res.json();
    if (!res.ok) throw new Error(`gateway ${res.status}: ${body?.error?.message}`);
    const u = body.usage ?? {};
    usage.push({
      model: `${res.headers.get("x-bifrost-provider")}/${res.headers.get("x-bifrost-routing-info-model")}`,
      prompt: u.prompt_tokens ?? 0,
      completion: u.completion_tokens ?? 0,
      fallback: res.headers.get("x-bifrost-routing-info-is-fallback") === "true",
      cacheHit: res.headers.get("x-bifrost-cache-hit") === "true",
      requestId: res.headers.get("x-bifrost-request-id"),
    });
    return { content: body.choices[0].message.content ?? "", tokens: u.total_tokens ?? 0, requestId: res.headers.get("x-bifrost-request-id") };
  }).catch((e) => {
    console.log(red(`freshness check skipped: ${e.message}`));
    return null;
  });
  if (freshness) {
    tokens += freshness.tokens;
    emit("freshness", { verdicts: freshness.verdicts, searches: freshness.searches, tokens: freshness.tokens, ms: freshness.ms });
    for (const v of freshness.verdicts)
      console.log(gray(`[fresh] ${v.library}: ${v.status} (${v.freshness}) ${v.claim}`));
  }
}
const notes = freshness ? freshnessNotes(freshness) : null;

const messages: Message[] = [
  { role: "system", content: SYSTEM },
  // Repo context and the task go in separate messages. Bifrost classifies
  // complexity from the latest user message only, so it sees just the task.
  ...(naive ? [] : [{ role: "user", content: (await buildContext(workspace, task)) + (notes ? `\n\n${notes}` : "") }]),
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

let steps = 0;
let stopped = false;
let wrote = false;
let finished = false;
let error: string | null = null;
for (let step = 1; step <= 15 && !stopped; step++) {
  let r: Awaited<ReturnType<typeof chat>>;
  const stepStart = Date.now();
  try {
    r = await chat(naive ? messages : compactHistory(messages));
  } catch (e: any) {
    console.log(red(e.message));
    error = e.message;
    emit("error", { step, message: e.message });
    break;
  }
  if (!pinned && !naive && !isPrivate) {
    // A fallback on step 1 means the routed model is down, so stay on the one
    // that answered. Without routing headers (a cache hit, say) keep the
    // requested model, but pin anyway so step 2 isn't classified on tool output.
    if (r.provider && r.servedModel) model = `${r.provider}/${r.servedModel}`;
    fallbacks = fallbacks.filter((f) => f !== model);
    pinned = true;
  }
  tokens += r.usage.total_tokens ?? 0;
  steps = step;
  usage.push({
    model: `${r.provider}/${r.servedModel}`,
    prompt: r.usage.prompt_tokens ?? 0,
    completion: r.usage.completion_tokens ?? 0,
    fallback: r.fallback,
    cacheHit: r.cacheHit,
    requestId: r.requestId,
  });
  const route = `${r.provider}/${r.servedModel}${r.fallback ? " (fallback)" : ""}`;
  console.log(gray(`[step ${step}] ${route}  tokens ${r.usage.total_tokens ?? "?"}`));
  emit("step", {
    step,
    provider: r.provider,
    model: r.servedModel,
    fallback: r.fallback,
    cacheHit: r.cacheHit,
    pinned: step > 1 && pinned,
    prompt: r.usage.prompt_tokens ?? 0,
    completion: r.usage.completion_tokens ?? 0,
    requestId: r.requestId,
    ms: Date.now() - stepStart,
  });
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
    emit("tool", { step, tool: toolName, args: call.function.arguments.slice(0, 300) });
    // A "no" ends the run. Otherwise models tend to retry the same change
    // through another tool, which defeats the point of asking.
    if (RISKY.has(toolName) && !(await confirm(call, toolName))) {
      console.log("rejected, stopping");
      stopped = true;
      break;
    }
    const result = await execTool(call);
    messages.push(result);
    if (naive) continue;
    const input = JSON.parse(call.function.arguments || "{}");
    if (toolName === "write_file" && typeof input.path === "string") {
      wrote = true;
      // The model's own write call already carries the new version of this
      // file, so the old copy in the repo context is dead weight.
      messages[1] = { ...messages[1], content: dropFile(String(messages[1].content), input.path) };
    }
    // Tests green after an edit means the job is done. Asking the model to
    // say so in a sentence would cost one more full round trip.
    if (toolName === "run_command" && wrote && /test/.test(input.command ?? "") && String(result.content).startsWith("exit 0")) {
      console.log("\ntests pass after the edit, done");
      finished = true;
      break;
    }
  }
  if (finished || stopped) break;
  // After an edit the agent runs the tests itself instead of spending a
  // model round trip on "now run npm test".
  const editedNow = calls.some((c) => c.function.name.endsWith("write_file"));
  const testedNow = calls.some((c) => c.function.name.endsWith("run_command"));
  if (!naive && editedNow && !testedNow) {
    const prefix = calls[0].function.name.replace(/[^-]+$/, "");
    const call: ToolCall = {
      id: `auto-test-${step}`,
      type: "function",
      function: { name: `${prefix}run_command`, arguments: JSON.stringify({ command: "npm test" }) },
    };
    if (!(await confirm(call, "run_command"))) {
      console.log("rejected, stopping");
      stopped = true;
      break;
    }
    const result = await execTool(call);
    messages.push({ role: "assistant", content: null, tool_calls: [call] }, result);
    emit("tool", { step, tool: "run_command", args: '{"command":"npm test"}', auto: true, ok: String(result.content).startsWith("exit 0") });
    if (String(result.content).startsWith("exit 0")) {
      console.log("\ntests pass after the edit, done");
      finished = true;
      break;
    }
    console.log(gray("  tests still fail, back to the model"));
  }
}

console.log(gray(`\ntotal tokens: ${tokens}, steps: ${steps}`));
emit("run_end", { tokens, steps, finished, stopped, error, ms: Date.now() - started });
if (asJson) console.log(JSON.stringify({ tokens, steps, stopped, error, ms: Date.now() - started, usage, freshness }));
rl.close();
