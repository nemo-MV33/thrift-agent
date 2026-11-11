import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileCache } from "../src/cache.js";
import { compactHistory, dropFile } from "../src/context.js";
import { verifyClaims, type Claim } from "../src/freshness.js";
import { GatewayError } from "../src/gateway.js";
import { markedPrivate, needsApproval, retryDelay } from "../src/policy.js";
import { loadSession, saveSession } from "../src/session.js";
import { tempRepo } from "./mock-gateway.js";

test("only list and read run without approval", () => {
  assert.equal(needsApproval("read_file"), false);
  assert.equal(needsApproval("list_files"), false);
  for (const name of ["write_file", "run_command", "git_push", "anything_new"]) assert.equal(needsApproval(name), true);
});

test("retries rate limits, server errors and network failures, not client errors", () => {
  process.env.THRIFT_RETRY_DELAYS = "5,15";
  try {
    assert.equal(retryDelay(new GatewayError(429, "slow down"), 0), 5000);
    assert.equal(retryDelay(new GatewayError(503, "down"), 1), 15000);
    assert.equal(retryDelay(new GatewayError(503, "down"), 2), null);
    assert.equal(retryDelay(new GatewayError(429, "slow down", 2), 0), 2000);
    assert.equal(retryDelay(new GatewayError(429, "slow down", 600), 0), 15000);
    assert.equal(retryDelay(new TypeError("fetch failed"), 0), 5000);
    assert.equal(retryDelay(new GatewayError(402, "budget"), 0), null);
    assert.equal(retryDelay(new GatewayError(400, "bad request"), 0), null);
    assert.equal(retryDelay(new Error("other"), 0), null);
  } finally {
    delete process.env.THRIFT_RETRY_DELAYS;
  }
});

test("a repo is private by marker file or package.json flag", async () => {
  assert.equal(await markedPrivate(await tempRepo({ "package.json": "{}" })), false);
  assert.equal(await markedPrivate(await tempRepo({ ".thrift-private": "" })), true);
  assert.equal(await markedPrivate(await tempRepo({ "package.json": '{"thrift":{"private":true}}' })), true);
  assert.equal(await markedPrivate(await tempRepo({ "package.json": '{"thrift":{"private":"yes"}}' })), false);
});

test("sessions round trip and reject unknown formats", async () => {
  const dir = await tempRepo({});
  const file = path.join(dir, "nested", "s.json");
  await saveSession(file, {
    version: 1, task: "t", workspace: dir, mode: "thrift", model: "m", fallbacks: [], pinned: true,
    messages: [{ role: "user", content: "hi" }], steps: 2, tokens: 10, wrote: false, savedAt: "now", reason: "r",
  });
  assert.equal((await loadSession(file))?.steps, 2);
  await fs.writeFile(file, '{"version":2}');
  assert.equal(await loadSession(file), null);
});

test("history trimming keeps the last two tool results and stubs older ones", () => {
  const big = "x".repeat(2000);
  const msgs = [
    { role: "system", content: "s" },
    { role: "user", content: "ctx" },
    { role: "user", content: "task" },
    { role: "assistant", content: null, tool_calls: [{ id: "a", type: "function" as const, function: { name: "ws-run_command", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: big },
    { role: "assistant", content: null, tool_calls: [{ id: "b", type: "function" as const, function: { name: "ws-run_command", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "b", content: big },
    { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function" as const, function: { name: "ws-run_command", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "c", content: big },
  ];
  const out = compactHistory(msgs);
  assert.ok(String(out[4].content).length < 200);
  assert.equal(out[6].content, big);
  assert.equal(out[8].content, big);
});

test("dropFile removes a file block from the repo context", () => {
  const ctx = "Repository files:\nsrc/a.js\nsrc/b.js\n\n--- src/a.js\nconst a = 1;\n\n--- src/b.js\nconst b = 2;\n";
  const out = dropFile(ctx, "src/a.js");
  assert.ok(!out.includes("const a = 1"));
  assert.ok(out.includes("const b = 2"));
});

const claim: Claim = { library: "zod", version: "4.1.0", claim: "Errors are in error.errors", query: "zod 4 error issues" };

async function withTavily(results: { url: string; content: string }[], body: () => Promise<void>) {
  const real = globalThis.fetch;
  process.env.TAVILY_API_KEY = "test";
  globalThis.fetch = (async () => new Response(JSON.stringify({ results }), { status: 200 })) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = real;
    delete process.env.TAVILY_API_KEY;
  }
}

test("a verdict counts only with a real quote from the cited page", async () => {
  const page = { url: "https://zod.dev/v4/changelog", content: "In Zod 4 the .errors property is removed. Use error.issues instead." };
  await withTavily([page], async () => {
    const honest = await verifyClaims([claim], async () => ({
      content: JSON.stringify([{ index: 1, status: "outdated", correction: "use error.issues", source: page.url, quote: "Use error.issues instead." }]),
      tokens: 50, requestId: null,
    }), "Check.");
    assert.equal(honest.verdicts[0].status, "outdated");
    assert.equal(honest.verdicts[0].freshness, 0);
    assert.equal(honest.verdicts[0].source, page.url);

    const invented = await verifyClaims([claim], async () => ({
      content: JSON.stringify([{ index: 1, status: "outdated", correction: "use error.problems", source: page.url, quote: "Use error.problems instead." }]),
      tokens: 50, requestId: null,
    }), "Check.");
    assert.equal(invented.verdicts[0].status, "unknown");

    const rewordedUrl = await verifyClaims([claim], async () => ({
      content: JSON.stringify([{ index: 1, status: "outdated", source: "https://zod.dev/v4/changelog?ref=x", quote: "use ERROR.issues instead" }]),
      tokens: 50, requestId: null,
    }), "Check.");
    assert.equal(rewordedUrl.verdicts[0].status, "outdated");
    assert.equal(rewordedUrl.verdicts[0].source, page.url);

    const tooShort = await verifyClaims([claim], async () => ({
      content: JSON.stringify([{ index: 1, status: "outdated", source: page.url, quote: "Zod 4" }]),
      tokens: 50, requestId: null,
    }), "Check.");
    assert.equal(tooShort.verdicts[0].status, "unknown");
  });
});

test("no search results means no judge call and an unknown verdict", async () => {
  await withTavily([], async () => {
    let calls = 0;
    const report = await verifyClaims([claim], async () => {
      calls++;
      return { content: "[]", tokens: 0, requestId: null };
    }, "Check.");
    assert.equal(calls, 0);
    assert.equal(report.verdicts[0].status, "unknown");
  });
});

test("settled verdicts come from the cache on the next run, unknowns do not", async () => {
  const { FileCache } = await import("../src/cache.js");
  const dir = await tempRepo({});
  const cache = new FileCache(path.join(dir, "cache.json"));
  const page = { url: "https://zod.dev/v4/changelog", content: "In Zod 4 the .errors property is removed. Use error.issues instead." };
  const other: Claim = { library: "zod", version: "4.1.0", claim: "Something nobody wrote about", query: "nothing" };
  let judgeCalls = 0;
  const judge = async (messages: { content: string }[]) => {
    judgeCalls++;
    const known = messages[0].content.includes("error.errors");
    return {
      content: JSON.stringify([known ? { index: 1, status: "outdated", source: page.url, quote: "Use error.issues instead." } : { index: 1, status: "unknown" }]),
      tokens: 10, requestId: null,
    };
  };
  await withTavily([page], async () => {
    const first = await verifyClaims([claim, other], judge, "Check.", cache);
    assert.equal(first.cached, 0);
    assert.equal(judgeCalls, 2);
    const second = await verifyClaims([claim, other], judge, "Check.", new FileCache(path.join(dir, "cache.json")));
    assert.equal(second.cached, 1);
    assert.equal(second.searches, 1);
    assert.equal(judgeCalls, 3);
    assert.equal(second.verdicts[0].status, "outdated");
    assert.equal(second.verdicts[1].status, "unknown");
  });
});

test("parallel cache writes all land", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "thrift-cache-"));
  const cache = new FileCache(path.join(dir, "c.json"));
  await Promise.all(Array.from({ length: 8 }, (_, i) => cache.set(`k${i}`, i)));
  const fresh = new FileCache(path.join(dir, "c.json"));
  for (let i = 0; i < 8; i++) assert.equal(await fresh.get(`k${i}`), i);
});
