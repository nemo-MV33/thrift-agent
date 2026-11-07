# Build journal

Running notes on what we built, what we measured and what broke. This is the raw material for the README, the deck and the demo video, so numbers go here as soon as we have them.

## 2026-11-07

### Setup

- Bifrost v2.5.0, started natively with `scripts/gateway.sh` (npx). Running it natively rather than in Docker lets it reach Ollama on localhost and spawn our stdio MCP server.
- Redis (redis-stack-server 7.4.0) in Docker for the semantic cache, see `docker-compose.yml`.
- Providers: Gemini (`gemini-3.5-flash`, `gemini-3.5-flash-lite`), Groq (`openai/gpt-oss-120b`, `openai/gpt-oss-20b`), Ollama (`qwen2.5-coder:7b`, `nomic-embed-text`). We have no OpenAI or Anthropic keys.
- Virtual keys:
  - `thrift-dev`: all three providers, $2/day budget.
  - `thrift-private`: Ollama only. This is private mode.
  - `thrift-baseline`: Groq only, excluded from routing rules. The naive agent uses it in the benchmark.
- Admin API is locked until an admin exists. We use `BIFROST_SETUP_TOKEN` from `.env` and the `X-Bifrost-Setup-Token` header for `/api/*`.

### Bifrost features in use

| Feature | How we use it | Status |
|---|---|---|
| MCP with manual tool execution | Workspace tools come from our stdio MCP server. Bifrost returns tool calls and the agent executes them via `/v1/mcp/tool/execute` after the user approves risky ones | working |
| Complexity router | Semantic classifier (Ollama embeddings) sets `complexity_tier`. CEL routing rules send SIMPLE to gpt-oss-20b, MEDIUM to gpt-oss-120b, COMPLEX to gemini-3.5-flash, each with its own fallback chain | working |
| Fallbacks | Per-request `fallbacks` plus per-rule chains. Seen live: Groq got rate limited mid-task and Bifrost moved the request to Gemini | working |
| Semantic cache | Direct (hash) mode, `default_cache_key`. A repeat request came back in 1 ms | working |
| Virtual key budgets | Configured; the 402 `budget_exceeded` path is not tested yet | todo |
| Cost tracking | `/api/logs` returns per-request cost; the benchmark reads cost from there | working |

### Problems we hit

- The official `@modelcontextprotocol/server-filesystem` exposes tool schemas that both Gemini ("unrecognized type ''") and Groq (metaschema validation) reject. We wrote our own small MCP server, `agent/src/workspace-server.ts`, with plain JSON schemas.
- Gemini's free tier hit 429 on embeddings while the complexity classifier warmed up its reference phrases. We moved embeddings to local Ollama (`nomic-embed-text`).
- `qwen2.5-coder:1.5b` does not call tools and makes up answers. `qwen2.5-coder:7b` works but sometimes prints tool calls as JSON text. The agent parses those.
- After a rejected write, models tried the same change through `run_command`. A "no" now ends the run.
- Groq validates tool arguments against the schema and rejected `list_files` without `dir`. `dir` is optional now.
- Groq free tier allows 8k tokens a minute on gpt-oss-120b. The benchmark spaces runs out and Groq has 4 retries with backoff.
- Gemini returned a 404 for a valid model once and worked on the next try. That's another reason to keep fallbacks on.

### First measurements (single task, before the full benchmark)

Task: fix `cart.js` so the tests pass (now bench task 01).

| Mode | Tokens | Steps | Time | Tests |
|---|---|---|---|---|
| naive (one model, full history) | ~8,400 | 8 | 38-69 s | pass |
| thrift, context trimming only | ~2,600 | 3 | 15-21 s | pass |
| thrift with complexity routing (gpt-oss-20b) | ~2,500 | 3 | 2 s | pass |
| private mode, qwen2.5-coder:7b | 2,100-3,400 | 3-4 | 5-8 s | 1 of 2 |

### Benchmark

- 14 tasks in `bench/tasks/`: 5 simple, 6 medium, 3 complex, all small Node repos with failing tests. Each one has a reference solution in `bench/solutions/` and was checked to fail before the fix and pass after it.
- Runner: `npm run bench -- --runs 3`. Summary: `npm run summarize -- bench/results/<file>.jsonl`.
- Protected test files are restored before judging, so an agent can't pass by editing tests.
- Each run gets its own cache key, so no run sees answers cached by an earlier one.
- The full run (14 x 2 modes x 3) was started on 2026-11-07. Raw results: `bench/results/run-*.jsonl`, log: `bench/results/full.log`.
- Early lines from the full run looked worse than the single-task numbers. Thrift went to gpt-oss-120b on a simple task and used 5-12k tokens, and some thrift runs reported cost 0. Both need a look before we quote any number.

### Full run, first attempt (partial)

The background run stopped after 10 of 84 runs (tasks 01 and 02 only, all simple), probably when the session that started it went idle. File: `bench/results/run-2026-11-07T06-01-*.jsonl`.

| Mode | Runs | Pass | Tokens | Cost | Time |
|---|---|---|---|---|---|
| naive | 5 | 100% | 13,898 | $0.00167 | 61.5 s |
| thrift | 5 | 100% | 6,051 | $0.00038 | 15.6 s |

That is -56% tokens, -77% cost and -75% time at the same pass rate. It's only two simple tasks, though, and the complexity router sent them to gpt-oss-120b instead of 20b, with some runs reporting cost 0. Treat these as preliminary until the full run finishes.

### Why the first full run looked bad

We stopped the first full run after two tasks and looked at the Bifrost logs instead.

- Every thrift request was tagged MEDIUM and went to gpt-oss-120b. Two reasons. Bifrost's complexity classifier looks at the latest message only, and from step 2 on that is a tool result like "exit 0 ... TAP version 13", so every later step was classified on test output. On top of that, our reference phrases were few and generic, so even the bare task prompts mostly landed in MEDIUM.
- Cost 0 on thrift runs: the runner read `/api/logs` 1.5 s after a run and summed whatever was there. Thrift runs finish in 2-3 s, so their log rows often weren't written yet. Missing rows counted as $0.

Fixes:

- The tier is decided once, on the first request, which carries only the task. The agent then pins the model Bifrost picked and sends `x-thrift-pinned: 1`; each routing rule has `!("x-thrift-pinned" in headers)` in its CEL expression, so later steps skip the classifier. If step 1 already went to a fallback, the agent stays on the model that answered.
- Rewrote the reference phrases in more of a bug-report style. We kept them generic on purpose rather than paraphrasing the benchmark prompts. Result on the 14 task prompts: 9 match the tier we assigned by hand (was effectively 0 useful splits before). Misses: 05 simple->complex, 06/10/11 medium->simple, 08 medium->complex, 14 complex->simple.
- The runner now waits until every request id is in the logs and records cost as null if one never shows up. The summary leaves null costs out instead of treating them as free.
- Routing COMPLEX to gemini-3.5-flash cost $0.035 for a single task (task 08), more than ten naive runs on gpt-oss-120b. COMPLEX now goes to gpt-oss-120b with Gemini as a fallback. On our task sizes the cheap Groq models are simply the better deal.
- Two step savings in the loop: after a file write the agent runs `npm test` itself instead of asking the model to, and stops as soon as tests pass after an edit. It also drops the old copy of a file from the repo context once the model has written a new one.

Spot checks after the fixes (thrift, one run each): task 01 1,434 tokens, $0.00022 on gpt-oss-20b (naive used 14-19k tokens on the same task); task 07 1,575 tokens; task 12 11,121 tokens.

### Cost lookup for fallbacks

When Bifrost fails over, the log has two entries: the failed attempt under the request id the client sees, and the fallback under a new id with `parent_request_id` pointing back. The runner only looked up the first one, so any run with a fallback came out as "cost unknown". It now sums both, and each result row keeps its request ids so costs can be recomputed later.

Side note: a quick test of ours used up the gpt-oss-20b minute quota while the benchmark was running, and the next thrift run moved to gemini-3.5-flash-lite on its own. Nice to see, but it also means we shouldn't run anything else against Groq during a benchmark.

### Freshness check (Tavily)

`agent/src/freshness.ts`. Runs before the first coding step, only in thrift mode, and only when the repo has npm dependencies. Private mode skips it, since the task text would leave the machine.

1. gpt-oss-20b gets the task and the installed package versions (read from node_modules, not the range in package.json) and lists up to 3 facts the change will depend on, each with a search query.
2. One Tavily advanced search per fact, top 3 results.
3. gpt-oss-20b judges each fact against the results only: current, outdated or unknown, a freshness score from 0 to 1, a corrected usage and a source URL.
4. Anything outdated or unknown goes into the repo context as a short note. Facts that hold cost nothing further.

Both model calls and their tokens count toward the run, so the benchmark sees the full price of the check.

Three new benchmark tasks use real packages whose current major versions changed things a model trained in 2024 would get wrong. We confirmed each break by running it, not from memory:

- 15 zod 4: `ZodError.errors` no longer exists (it is `undefined`), only `issues`. Code written for zod 3 crashes with "cannot read properties of undefined".
- 16 Express 5: `app.all('/api/*', ...)` throws "Missing parameter name at index 1" at startup. Wildcards need a name now (`/*rest`).
- 17 Express 5: same wildcard change, and the named wildcard comes back as an array of segments, not a string.

Each has a reference solution and was checked to fail before and pass after. The benchmark has a third mode, `stale`, which is thrift with the freshness check turned off, so the comparison isolates what Tavily adds.

### Portable gateway config

`bifrost/config.json` had absolute paths from one laptop (the MCP server is a stdio process). It is now generated by `scripts/gateway.sh` from `bifrost/config.template.json`, with `${THRIFT_ROOT}` replaced by the repo path. Only the template is in git.
