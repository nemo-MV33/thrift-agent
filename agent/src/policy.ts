// Rules the CLI enforces on its own, whatever the model or the task text says.
import { promises as fs } from "node:fs";
import path from "node:path";
import { GatewayError } from "./gateway.js";

/**
 * A repo is confidential if it says so itself, with a .thrift-private file or
 * "thrift": { "private": true } in package.json. The marker lives in the repo,
 * not in the task text, so nothing typed into a prompt can turn it off.
 */
export async function markedPrivate(dir: string): Promise<boolean> {
  if (await fs.access(path.join(dir, ".thrift-private")).then(() => true, () => false)) return true;
  try {
    return JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"))?.thrift?.private === true;
  } catch {
    return false;
  }
}

// Reading is free. Every other tool, including any a future MCP server adds,
// needs a yes from the user.
const READ_ONLY = new Set(["list_files", "read_file"]);
export const needsApproval = (toolName: string) => !READ_ONLY.has(toolName);

const DEFAULT_DELAYS = [5_000, 15_000, 30_000, 60_000];

function delays(): number[] {
  const raw = process.env.THRIFT_RETRY_DELAYS;
  if (raw === undefined) return DEFAULT_DELAYS;
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((s) => Number(s) * 1000).filter((n) => n >= 0);
}

/**
 * How long to wait before retrying a failed model call, or null to give up.
 * Rate limits, server errors and an unreachable gateway are worth waiting
 * for. Bad requests and an exhausted budget are not.
 */
export function retryDelay(error: unknown, attempt: number): number | null {
  const plan = delays();
  if (attempt >= plan.length) return null;
  if (error instanceof GatewayError) {
    if (error.status !== 429 && error.status < 500) return null;
    // Respect the provider's own hint, but never wait longer than our longest step.
    if (error.retryAfter != null) return Math.min(error.retryAfter * 1000, Math.max(...plan));
    return plan[attempt];
  }
  // fetch throws a TypeError when the gateway is down or the connection drops.
  if (error instanceof TypeError) return plan[attempt];
  return null;
}
