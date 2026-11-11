// A small JSON file cache with an expiry per entry. The freshness check keeps
// claim lists and verdicts here, so the same library version is not searched
// and judged again on every run.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

type Entry = { value: unknown; expires: number };

export class FileCache {
  // One shared load, so parallel callers all work on the same entries.
  private loading: Promise<Record<string, Entry>> | null = null;
  // Judges finish in parallel and each one stores its verdict. Writes go
  // through this chain so two of them never share the temp file.
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly file: string, readonly ttlMs = 7 * 24 * 3600 * 1000) {}

  static key(...parts: string[]): string {
    return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);
  }

  private load(): Promise<Record<string, Entry>> {
    // A missing or broken file starts an empty cache.
    this.loading ??= fs.readFile(this.file, "utf8").then((text) => JSON.parse(text)).catch(() => ({}));
    return this.loading;
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = (await this.load())[key];
    if (!entry || entry.expires < Date.now()) return undefined;
    return entry.value as T;
  }

  async set(key: string, value: unknown): Promise<void> {
    const entries = await this.load();
    entries[key] = { value, expires: Date.now() + this.ttlMs };
    for (const [k, e] of Object.entries(entries)) if (e.expires < Date.now()) delete entries[k];
    const write = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(entries));
      await fs.rename(tmp, this.file);
    });
    // A failed write must not block the ones after it.
    this.writing = write.catch(() => {});
    await write;
  }
}
