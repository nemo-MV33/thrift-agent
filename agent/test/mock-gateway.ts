// A stand-in for Bifrost that answers chat and tool calls from a script, so
// the CLI can be tested end to end without providers, keys or quota.
import { createServer, type IncomingMessage, type Server } from "node:http";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ChatReply =
  | { status: number; error: string }
  | { message: Record<string, unknown>; provider?: string; model?: string; fallback?: boolean; tokens?: number };

export type Recorded = { url: string; headers: IncomingMessage["headers"]; body: any };

export class MockGateway {
  readonly requests: Recorded[] = [];
  private server: Server | null = null;
  url = "";

  constructor(
    public chatReplies: ChatReply[],
    public toolResult: (call: any) => string = () => "ok",
  ) {}

  async start(): Promise<void> {
    this.server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
      this.requests.push({ url: req.url ?? "", headers: req.headers, body });
      if (req.url?.startsWith("/v1/mcp/tool/execute")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ content: this.toolResult(body) }));
        return;
      }
      const reply = this.chatReplies.shift() ?? { status: 500, error: "no scripted reply left" };
      if ("status" in reply) {
        res.writeHead(reply.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: reply.error } }));
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/json",
        "x-bifrost-routing-info-provider": reply.provider ?? "groq",
        "x-bifrost-routing-info-model": reply.model ?? "openai/gpt-oss-20b",
        "x-bifrost-routing-info-is-fallback": String(reply.fallback ?? false),
        "x-bifrost-request-id": `req-${this.requests.length}`,
      });
      res.end(JSON.stringify({ choices: [{ message: reply.message }], usage: { total_tokens: reply.tokens ?? 100 } }));
    });
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("no port");
    this.url = `http://127.0.0.1:${address.port}`;
  }

  chats(): Recorded[] {
    return this.requests.filter((r) => r.url.startsWith("/v1/chat/completions"));
  }

  tools(): Recorded[] {
    return this.requests.filter((r) => r.url.startsWith("/v1/mcp/tool/execute"));
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }
}

export const writeCall = (file: string, content: string) => ({
  role: "assistant",
  content: null,
  tool_calls: [{ id: "call-1", type: "function", function: { name: "ws-write_file", arguments: JSON.stringify({ path: file, content }) } }],
});

export async function tempRepo(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "thrift-test-"));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));

/** Runs the real CLI against the mock gateway and returns its output. */
export function runCli(args: string[], env: Record<string, string>, input = ""): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], {
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
        THRIFT_EVENTS_URL: "http://127.0.0.1:9/events",
        THRIFT_VK_DEV: "vk-dev",
        THRIFT_VK_PRIVATE: "vk-private",
        THRIFT_VK_BASELINE: "vk-baseline",
        THRIFT_RETRY_DELAYS: "0,0",
        ...env,
      },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.stdin.end(input);
    child.on("close", (code) => resolve({ code, out: out.replace(/\x1b\[\d+m/g, "") }));
  });
}
