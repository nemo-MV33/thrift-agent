// Minimal agent loop. Every model call goes through Bifrost, which also
// injects the workspace tools over MCP. Bifrost only returns tool calls and
// leaves running them to us, so this is where risky calls get confirmed.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkFreshness, freshnessNotes } from "./freshness.js";
import { buildContext, compactHistory, dropFile, type Message, type ToolCall } from "./context.js";
import { GATEWAY, GatewayError, gatewayChat, smallModelChat } from "./gateway.js";
import { markedPrivate, needsApproval, retryDelay } from "./policy.js";
import { clearSession, loadSession, saveSession, type Session } from "./session.js";
import { FileCache } from "./cache.js";

const args = process.argv.slice(2);
const autoYes = args.includes("--yes");
const asJson = args.includes("--json");
const root = fileURLToPath(new URL("../..", import.meta.url));
const workspace = path.resolve(root, process.env.THRIFT_WORKSPACE ?? "sandbox/demo-app");
const sessionFile = process.env.THRIFT_SESSION_FILE ?? path.join(root, ".thrift", "session.json");

// --resume continues the last run that stopped on an error, with its history,
// model and step count. The mode comes from the saved run, not the new flags.
let resumed: Session | null = null;
if (args.includes("--resume")) {
  resumed = await loadSession(sessionFile);
  if (!resumed || resumed.workspace !== workspace) {
    console.error("No stopped run to resume for this workspace.");
    process.exit(1);
  }
}
// --naive is the baseline for the benchmark: one strong model, no repo
// context up front, full history every step.
const naive = resumed ? resumed.mode === "naive" : args.includes("--naive");
const task = resumed?.task ?? args.filter((a) => !a.startsWith("--")).join(" ");
const gitFollowUp = /\bgit\s+(?:add|commit|push)\b|\bthen\s+(?:commit|push)\b/i.test(task);

if (!task) {
  console.error('usage: npm start -- "<task>" [--private] [--yes]   or   npm start -- --resume');
  process.exit(1);
}

const marked = await markedPrivate(workspace);
const isPrivate = marked || args.includes("--private") || resumed?.mode === "private";
if (marked && naive) {
  console.error("This repository is marked confidential. The baseline agent uses a cloud model, so it will not run here.");
  process.exit(1);
}
if (isPrivate && !process.env.THRIFT_VK_PRIVATE) {
  console.error("Private mode needs THRIFT_VK_PRIVATE, the Ollama-only virtual key. Refusing to send the repo anywhere else.");
  process.exit(1);
}
if (marked) console.log("This repository is marked confidential. Every model call stays on local Ollama.");
// Private repos never leave the machine, so no web lookups there either.
const fresh = !naive && !isPrivate && !resumed && !args.includes("--no-fresh");
// Ablation switches for the benchmark. Each one turns off a single technique
// so its share of the savings can be measured.
const noContext = !naive && args.includes("--no-context");
const noTrim = !naive && args.includes("--no-trim");
const noAutotest = !naive && args.includes("--no-autotest");
const noRoute = !naive && !isPrivate && args.includes("--no-route");

const vk = isPrivate
  ? process.env.THRIFT_VK_PRIVATE
  : naive
    ? process.env.THRIFT_VK_BASELINE
    : process.env.THRIFT_VK_DEV;
let model = isPrivate ? "ollama/qwen2.5-coder:7b" : "groq/openai/gpt-oss-120b";
let fallbacks = isPrivate || naive ? [] : ["gemini/gemini-3.5-flash", "ollama/qwen2.5-coder:7b"];
// A private run that resumes stays local even if the saved run was not private.
if (resumed && (!isPrivate || resumed.mode === "private")) {
  model = resumed.model;
  fallbacks = resumed.fallbacks;
}

const headers: Record<string, string> = { "Content-Type": "application/json", "x-bf-vk": vk ?? "" };
// The benchmark gives each run its own cache namespace so repeated runs
// don't get answers cached by earlier ones.
if (process.env.THRIFT_CACHE_KEY) headers["x-bf-cache-key"] = process.env.THRIFT_CACHE_KEY;
// Live events for the dashboard. Fire and forget: the agent must never wait
// on, or fail because of, the dashboard.
const EVENTS = process.env.THRIFT_EVENTS_URL ?? "http://127.0.0.1:5199/events";
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
// Answers are read line by line from a queue rather than with rl.question,
// which throws once stdin has closed. A closed stdin counts as "no".
const answers: string[] = [];
let waiting: ((line: string | null) => void) | null = null;
let inputClosed = false;
rl.on("line", (line) => {
  if (waiting) {
    const resolve = waiting;
    waiting = null;
    resolve(line);
  } else answers.push(line);
});
rl.on("close", () => {
  inputClosed = true;
  waiting?.(null);
  waiting = null;
});
function ask(prompt: string): Promise<string | null> {
  stdout.write(prompt);
  if (answers.length) return Promise.resolve(answers.shift()!);
  if (inputClosed) return Promise.resolve(null);
  return new Promise((resolve) => (waiting = resolve));
}
const gray = (s: string) => `\x1b[90m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

// Bifrost's complexity router only looks at the latest message. After the
// first step that is a tool result ("exit 0 ..."), which says nothing about
// how hard the task is. So the first request is routed on the task itself,
// and later steps stay on whatever model it picked. The pinned header turns
// the tier rules off for those requests (see bifrost/config.json).
// Without routing every request goes straight to the requested big model.
let pinned = resumed ? resumed.pinned && (!isPrivate || resumed.mode === "private") : noRoute;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function chat(messages: Message[], step: number) {
  // A cap on output: a small local model that runs past its context window
  // can otherwise generate until the gateway times out (seen: 504 after 300 s).
  const payload = () => ({ model, messages, fallbacks, max_tokens: isPrivate ? 1500 : 4000 });
  for (let attempt = 0; ; attempt++) {
    try {
      return await gatewayChat(headers, payload(), pinned ? { "x-thrift-pinned": "1" } : {});
    } catch (e) {
      // Bifrost already tried every model in the fallback chain. If all of them
      // are rate limited or down, wait and ask again instead of dropping the run.
      const wait = retryDelay(e, attempt);
      if (wait == null) throw e;
      const reason = e instanceof GatewayError ? `HTTP ${e.status}` : "gateway unreachable";
      console.log(yellow(`No model answered (${reason}). Waiting ${Math.round(wait / 1000)} s, then trying again.`));
      emit("retry", { step, attempt: attempt + 1, waitMs: wait, reason });
      await sleep(wait);
    }
  }
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

// The files a write_file or write_files call would change, or null for any
// other tool.
function writesOf(toolName: string, input: any): { path: string; content: string }[] | null {
  if (toolName === "write_file") return [{ path: String(input.path), content: String(input.content ?? "") }];
  if (toolName === "write_files" && Array.isArray(input.files))
    return input.files.map((f: any) => ({ path: String(f?.path), content: String(f?.content ?? "") }));
  return null;
}

async function confirm(call: ToolCall, toolName: string): Promise<boolean> {
  const input = JSON.parse(call.function.arguments || "{}");
  const writes = writesOf(toolName, input);
  if (writes) {
    const prefix = call.function.name.slice(0, -toolName.length);
    for (const [i, w] of writes.entries()) {
      const current = await execTool({
        id: `${call.id}-preview-${i}`,
        type: "function",
        function: { name: `${prefix}read_file`, arguments: JSON.stringify({ path: w.path }) },
      });
      const before = String(current.content ?? "").startsWith("error") ? "" : String(current.content);
      console.log(`\nwrite ${w.path}\n${diff(before, w.content)}`);
    }
  } else if (toolName === "run_command") {
    console.log(`\nrun: ${input.command}`);
  } else {
    console.log(`\n${toolName} ${call.function.arguments}`);
  }
  const detail =
    writes ? { path: writes.map((w) => w.path).join(", ") }
    : toolName === "run_command" ? { command: input.command }
    : { command: `${toolName} ${call.function.arguments.slice(0, 200)}` };
  if (autoYes) {
    emit("approval", { tool: toolName, ...detail, approved: true, auto: true });
    return true;
  }
  emit("approval_wait", { tool: toolName, ...detail });
  const answer = await ask("apply? [y/N] ");
  if (answer === null) console.log("\nno answer, treating it as no");
  const approved = answer?.trim().toLowerCase().startsWith("y") ?? false;
  emit("approval", { tool: toolName, ...detail, approved, auto: false });
  return approved;
}

// Thrift's key offers write_files, which takes every changed file in one call.
// The private key keeps write_file, which small local models handle better.
const writeHow = isPrivate
  ? "one write_file call per file, all at once, each with the full new content"
  : "a single write_files call with the full new content of every file you change";
const SYSTEM = naive || noContext
  ? "You are a coding agent working inside a small repository. Use the tools to look at files, " +
    "make the change, then run the tests. Paths are relative to the repo root. Keep answers short."
  : gitFollowUp
    ? `Coding agent. The relevant files are below, don't read them again. Make every code change in one reply: ${writeHow}. ` +
      "The agent runs npm test after the edits. Then do the requested Git actions. Paths are relative to the repo root. Keep answers short."
    // Measured on task 12: the old prompt ("write the fix, run the tests
    // once") made the model run the failing tests first and then edit one
    // file per step, resending the whole context every time.
    : `Coding agent. The relevant files are below, don't read them again. Make every change the task needs in one reply: ${writeHow}. ` +
      "Don't run the tests. The agent runs npm test after your edits and only comes back to you if they fail, " +
      "so then fix what the output points to. Paths are relative to the repo root.";

emit("run_start", { task, workspace: path.basename(workspace), resumed: Boolean(resumed) });
let tokens = resumed?.tokens ?? 0;
const usage: { model: string; prompt: number; completion: number; fallback: boolean; cacheHit: boolean; requestId: string | null }[] = [];
const started = Date.now();
let freshness: Awaited<ReturnType<typeof checkFreshness>> = null;
let freshnessFailed = false;
if (fresh) {
  // Claim extraction and judging are short JSON jobs, the small model is enough.
  // Settled verdicts are reused for a week. The benchmark turns this off so
  // every attempt pays for its own check.
  const cache = process.env.THRIFT_FRESHNESS_CACHE === "off"
    ? undefined
    : new FileCache(process.env.THRIFT_FRESHNESS_CACHE_FILE ?? path.join(root, ".thrift", "freshness-cache.json"));
  freshness = await checkFreshness(workspace, task, async (msgs, purpose) => {
    const r = await smallModelChat(headers, msgs, purpose);
    usage.push(r.record);
    const used = r.usage.total_tokens ?? 0;
    tokens += used;
    return { content: String(r.message.content ?? ""), tokens: used, requestId: r.requestId };
  }, cache).catch((e) => {
    freshnessFailed = true;
    console.log(red(`freshness check skipped: ${e.message}`));
    return null;
  });
  if (freshness) {
    emit("freshness", {
      verdicts: freshness.verdicts, searches: freshness.searches, failedSearches: freshness.failedSearches,
      tokens: freshness.tokens, ms: freshness.ms, cached: freshness.cached,
    });
    if (freshness.cached) console.log(gray(`[fresh] ${freshness.cached} of ${freshness.verdicts.length} claims answered from the cache`));
    if (freshness.failedSearches) console.log(gray(`[fresh] ${freshness.failedSearches} of ${freshness.searches} web searches failed`));
    for (const v of freshness.verdicts)
      console.log(gray(`[fresh] ${v.library}: ${v.status} (${v.freshness}) ${v.claim}`));
  }
}
const notes = freshness ? freshnessNotes(freshness) : null;

if (resumed) console.log(gray(`Resuming "${task}" from step ${resumed.steps + 1} on ${model}. It stopped on: ${resumed.reason}`));
const messages: Message[] = resumed ? resumed.messages : [
  { role: "system", content: SYSTEM },
  // Repo context and the task go in separate messages. Bifrost classifies
  // complexity from the latest user message only, so it sees just the task.
  ...(naive || noContext ? (notes ? [{ role: "user", content: notes }] : []) : [{ role: "user", content: (await buildContext(workspace, task)) + (notes ? `\n\n${notes}` : "") }]),
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

const isTestRun = (cmd: unknown) => typeof cmd === "string" && /^\s*npm\s+(t|test|run\s+test)(\s|$)/.test(cmd);

let steps = resumed?.steps ?? 0;
let stopped = false;
let wrote = resumed?.wrote ?? false;
let finished = false;
let error: string | null = null;
const firstStep = steps + 1;
for (let step = firstStep; step < firstStep + 15 && !stopped; step++) {
  let r: Awaited<ReturnType<typeof chat>>;
  const stepStart = Date.now();
  try {
    r = await chat(naive || noTrim ? messages : compactHistory(messages), step);
  } catch (e: any) {
    console.log(red(e.message));
    // Bifrost checks the virtual key's budget before it forwards a request,
    // so a 402 means nothing was sent and nothing was spent on this step.
    if (e instanceof GatewayError && e.status === 402)
      console.log(red("Spending limit for this virtual key is reached. Stopping before any further model call. Files written so far stay as they are."));
    error = e.message;
    emit("error", { step, message: e.message });
    // Keep everything up to the last finished step, so the run can go on once
    // the provider is back or the budget is raised.
    await saveSession(sessionFile, {
      version: 1, task, workspace, mode, model, fallbacks, pinned, messages, steps, tokens, wrote,
      savedAt: new Date().toISOString(), reason: e.message.slice(0, 200),
    });
    console.log(yellow("The run is saved. Fix the cause, then continue it with: npm start -- --resume"));
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
  usage.push(r.record);
  const route = `${r.provider}/${r.servedModel}${r.fallback ? " (fallback)" : ""}`;
  console.log(gray(`[step ${step}] ${route}  tokens ${r.usage.total_tokens ?? "?"}`));
  if (r.fallback) console.log(yellow(`The requested model did not answer. ${r.provider}/${r.servedModel} took over and the run continues.`));
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
    if (needsApproval(toolName) && !(await confirm(call, toolName))) {
      console.log("rejected, stopping");
      stopped = true;
      break;
    }
    const result = await execTool(call);
    messages.push(result);
    if (naive) continue;
    const input = JSON.parse(call.function.arguments || "{}");
    const writes = writesOf(toolName, input);
    if (writes) wrote = true;
    if (writes && !noContext && !noTrim) {
      // The model's own write call already carries the new version of these
      // files, so the old copies in the repo context are dead weight.
      for (const w of writes) messages[1] = { ...messages[1], content: dropFile(String(messages[1].content), w.path) };
    }
    // Tests green after an edit means the job is done. Only the project's own
    // test script counts: "cat test.js" or "node -e ..." exiting 0 says nothing. Asking the model to
    // say so in a sentence would cost one more full round trip.
    if (!gitFollowUp && !noAutotest && toolName === "run_command" && wrote && isTestRun(input.command) && String(result.content).startsWith("exit 0")) {
      console.log("\ntests pass after the edit, done");
      finished = true;
      break;
    }
  }
  if (finished || stopped) break;
  // After an edit the agent runs the tests itself instead of spending a
  // model round trip on "now run npm test".
  const editedNow = calls.some((c) => /write_files?$/.test(c.function.name));
  const testedNow = calls.some((c) => c.function.name.endsWith("run_command"));
  if (!naive && !noAutotest && editedNow && !testedNow) {
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
    const passed = String(result.content).startsWith("exit 0");
    if (passed && !gitFollowUp) {
      console.log("\ntests pass after the edit, done");
      finished = true;
      break;
    }
    console.log(gray(passed ? "  tests pass, continuing with the requested Git actions" : "  tests still fail, back to the model"));
  }
}

// Only a run that stopped on an error is worth resuming.
if (!error) await clearSession(sessionFile);
console.log(gray(`\ntotal tokens: ${tokens}, steps: ${steps}`));
emit("run_end", { tokens, steps, finished, stopped, error, ms: Date.now() - started });
if (asJson) console.log(JSON.stringify({ tokens, steps, stopped, error, ms: Date.now() - started, usage, freshness, freshnessFailed }));
rl.close();
