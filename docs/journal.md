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
