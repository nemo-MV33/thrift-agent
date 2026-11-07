// Minimal agent loop. Every model call goes through Bifrost, which also
// injects the workspace tools over MCP. Bifrost only returns tool calls and
// leaves running them to us, so this is where risky calls get confirmed.
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const GATEWAY = process.env.BIFROST_URL ?? "http://localhost:8080";
const args = process.argv.slice(2);
const isPrivate = args.includes("--private");
const autoYes = args.includes("--yes");
const task = args.filter((a) => !a.startsWith("--")).join(" ");

if (!task) {
  console.error('usage: npm start -- "<task>" [--private] [--yes]');
  process.exit(1);
}

const vk = isPrivate ? process.env.THRIFT_VK_PRIVATE : process.env.THRIFT_VK_DEV;
const model = isPrivate ? "ollama/qwen2.5-coder:1.5b" : "groq/openai/gpt-oss-120b";
const fallbacks = isPrivate ? [] : ["gemini/gemini-3.5-flash", "ollama/qwen2.5-coder:1.5b"];

// Tools that change something on disk or run code need a yes from the user.
const RISKY = new Set(["write_file", "run_command"]);

type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
type Message = { role: string; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };

const headers = { "Content-Type": "application/json", "x-bf-vk": vk ?? "" };
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

const messages: Message[] = [
  {
    role: "system",
    content:
      "You are a coding agent working inside a small repository. Use the tools to look at files, " +
      "make the change, then run the tests. Paths are relative to the repo root. Keep answers short.",
  },
  { role: "user", content: task },
];

let tokens = 0;
let stopped = false;
for (let step = 1; step <= 15 && !stopped; step++) {
  const r = await chat(messages);
  tokens += r.usage.total_tokens ?? 0;
  const route = `${r.provider}/${r.servedModel}${r.fallback ? " (fallback)" : ""}`;
  console.log(gray(`[step ${step}] ${route}  tokens ${r.usage.total_tokens ?? "?"}`));
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

console.log(gray(`\ntotal tokens: ${tokens}`));
rl.close();
