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

const root = await fs.realpath(process.argv[2] ?? process.cwd());
const run = promisify(execFile);
const commandEnv = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(GROQ_API_KEY|GEMINI_API_KEY|TAVILY_API_KEY|BIFROST_SETUP_TOKEN|THRIFT_VK_.*)$/.test(name)),
);

function contained(full: string, requested: string): string {
  const relative = path.relative(root, full);
  if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
    throw new Error(`path escapes workspace: ${requested}`);
  return full;
}

async function inside(p: string, create = false): Promise<string> {
  const full = contained(path.resolve(root, p), p);
  const missing = create && !(await fs.lstat(full).catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  }));
  const resolved = missing
    ? path.join(await fs.realpath(path.dirname(full)), path.basename(full))
    : await fs.realpath(full);
  return contained(resolved, p);
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
    // gpt-oss on Groq returns one tool call per reply, so a fix that touches
    // three files cost three round trips with write_file. Thrift's key gets
    // this tool instead and writes them all at once.
    name: "write_files",
    description: "Overwrite or create several text files in the workspace in one call.",
    inputSchema: {
      type: "object",
      properties: {
        files: {
          type: "array",
          items: {
            type: "object",
            properties: { path: str("File path relative to the workspace root"), content: str("Full new file content") },
            required: ["path", "content"],
          },
        },
      },
      required: ["files"],
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
    else if (entry.isFile()) out.push(path.relative(root, full));
  }
  return out;
}

async function call(name: string, args: Record<string, any>): Promise<string> {
  switch (name) {
    case "list_files":
      return (await walk(await inside(args.dir ?? "."))).join("\n");
    case "read_file":
      return fs.readFile(await inside(args.path), "utf8");
    case "write_file":
      await fs.writeFile(await inside(args.path, true), args.content);
      return `wrote ${args.content.length} chars to ${args.path}`;
    case "write_files": {
      const files: { path: string; content: string }[] = Array.isArray(args.files) ? args.files : [];
      if (!files.length) throw new Error("files is empty");
      // Resolve every path first, so one bad path writes nothing.
      const targets = await Promise.all(files.map((f) => inside(f.path, true)));
      await Promise.all(targets.map((t, i) => fs.writeFile(t, String(files[i].content))));
      return `wrote ${files.map((f) => `${f.path} (${String(f.content).length} chars)`).join(", ")}`;
    }
    case "run_command":
      try {
        const { stdout, stderr } = await run("sh", ["-c", args.command], { cwd: root, env: commandEnv, timeout: 60_000 });
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
    const text = await call(req.params.name, (req.params.arguments ?? {}) as Record<string, any>);
    return { content: [{ type: "text", text }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
