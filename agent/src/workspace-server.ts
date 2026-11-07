// MCP server that exposes a single workspace directory to the agent.
// Bifrost connects to it over stdio. Every path is resolved inside the root,
// so the model can't read or write anything outside the repo it works on.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const root = path.resolve(process.argv[2] ?? process.cwd());
const run = promisify(execFile);

function inside(p: string): string {
  const full = path.resolve(root, p);
  if (full !== root && !full.startsWith(root + path.sep)) {
    throw new Error(`path escapes workspace: ${p}`);
  }
  return full;
}

const str = (description: string) => ({ type: "string", description });

const tools = [
  {
    name: "list_files",
    description: "List files in a directory of the workspace, recursively, skipping node_modules and .git.",
    inputSchema: { type: "object", properties: { dir: str("Directory relative to the workspace root, '.' for root") } },
  },
  {
    name: "read_file",
    description: "Read a text file from the workspace.",
    inputSchema: { type: "object", properties: { path: str("File path relative to the workspace root") }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Overwrite a text file in the workspace with new content.",
    inputSchema: {
      type: "object",
      properties: { path: str("File path relative to the workspace root"), content: str("Full new file content") },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the workspace root, for example 'npm test'. Returns exit code and output.",
    inputSchema: { type: "object", properties: { command: str("Command line to run") }, required: ["command"] },
  },
];

async function walk(dir: string, out: string[] = []): Promise<string[]> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(path.relative(root, full));
  }
  return out;
}

async function call(name: string, args: Record<string, string>): Promise<string> {
  switch (name) {
    case "list_files":
      return (await walk(inside(args.dir ?? "."))).join("\n");
    case "read_file":
      return fs.readFile(inside(args.path), "utf8");
    case "write_file":
      await fs.writeFile(inside(args.path), args.content);
      return `wrote ${args.content.length} chars to ${args.path}`;
    case "run_command":
      try {
        const { stdout, stderr } = await run("sh", ["-c", args.command], { cwd: root, timeout: 60_000 });
        return `exit 0\n${stdout}${stderr}`.slice(0, 4000);
      } catch (e: any) {
        return `exit ${e.code ?? 1}\n${e.stdout ?? ""}${e.stderr ?? ""}`.slice(0, 4000);
      }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

const server = new Server({ name: "workspace", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    const text = await call(req.params.name, (req.params.arguments ?? {}) as Record<string, string>);
    return { content: [{ type: "text", text }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
