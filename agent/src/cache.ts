// A small JSON file cache with an expiry per entry. The freshness check keeps
// claim lists and verdicts here, so the same library version is not searched
// and judged again on every run.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

type Entry = { value: unknown; expires: number };

export class FileCache {
  private entries: Record<string, Entry> | null = null;
  hits = 0;

  constructor(readonly file: string, readonly ttlMs = 7 * 24 * 3600 * 1000) {}

  static key(...parts: string[]): string {
    return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
  }

  private async load(): Promise<Record<string, Entry>> {
    if (this.entries) return this.entries;
    try {
      this.entries = JSON.parse(await fs.readFile(this.file, "utf8"));
    } catch {
      this.entries = {};
    }
    return this.entries!;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = (await this.load())[key];
    if (!entry || entry.expires < Date.now()) return undefined;
    this.hits++;
    return entry.value as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    const entries = await this.load();
    entries[key] = { value, expires: Date.now() + this.ttlMs };
    for (const [k, e] of Object.entries(entries)) if (e.expires < Date.now()) delete entries[k];
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(entries));
    await fs.rename(tmp, this.file);
  }
}
