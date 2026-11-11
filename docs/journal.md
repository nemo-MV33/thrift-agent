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

### Second full run: stopped by Groq's daily quota

The second full run got through 36 of 84 runs (tasks 01-06) before naive runs started failing with Groq 429 "tokens per day (TPD): Limit 200000". The free tier allows 200k tokens a day on gpt-oss-120b, and the naive agent alone used most of that. Thrift runs on the same tasks kept passing.

Up to that point (`run-2026-11-07T06-17-12-387Z.jsonl`, 18 runs per mode, tasks 01-06):

| Mode | Pass | Avg tokens | Avg cost | Avg time |
|---|---|---|---|---|
| naive | 61% (11/18, all 7 failures are 429 quota errors) | 7,268 | $0.00102 | 30.6 s |
| thrift | 100% | 1,982 | $0.00025 | 24.8 s |

Quota failures are not agent failures, so `summarize` now leaves out runs that died on a 429 and says how many. We stopped the run rather than let the rest of the naive side fail the same way.

### Private mode hang

A private-mode run on task 01 hung on step 2 until Bifrost gave up with 504 after 300 s. Ollama itself was fine. Our guess: the prompt plus tool output ran past qwen2.5-coder's 4096-token context window, and with no output limit the model kept generating. Requests now carry `max_tokens` (1,500 in private mode, 4,000 otherwise). The same run then finished in 3 steps and 4,657 tokens, but the fix was wrong and tests failed. That matches what we saw before: the 7B local model passes this task about half the time. Private mode keeps code on the machine. It is not where you get the best pass rate.

### Demo scenes, 7 Nov

Recorded four scenes against the live gateway with the dashboard open. Screenshots are in `docs/demo/`. All runs used the normal workspace, `sandbox/demo-app`, staged from a bench task the same way the benchmark does it. That directory is fixed by the MCP server args in the gateway config, so `THRIFT_WORKSPACE` alone does not move where files get written.

#### MCP header check

Freshness calls send `x-bf-mcp-include-clients: ""` to keep the workspace tools away from the judge model. That does not work. Through the gateway on Gemini flash-lite, with `tools: []` and the empty header, the model still listed `ws-list_files`, `ws-read_file`, `ws-write_file` and `ws-run_command`. Without the header the answer was the same. With `x-bf-mcp-include-clients: none` the model answered NONE. Bifrost seems to treat an empty value as "header not set". The fix belongs in `agent/src/freshness.ts` (send a name that matches no client, like `none`).

#### Fallback

The Groq daily quota had reset by the time we recorded, so there was no real 429 to show. We restarted the gateway with an invalid Groq key instead (only for this scene, real key restored after). Task 01, thrift mode:

- Groq gpt-oss-20b failed, Bifrost moved to gemini-3.5-flash-lite (`fallback_index` 1 in the gateway log), the agent marked step 1 as a fallback.
- Step 2 stayed pinned on Gemini, wrote the fix, tests passed 3 of 3.
- 2,709 tokens, 2 steps, $0.00097.

Screenshot: `fallback.png` (also used as `dashboard.png`).

#### Budget 402

Set the `thrift-dev` daily budget to $0.0435 through `PUT /api/governance/virtual-keys/vk-dev`, with $0.0425 already spent that day. The first run (task 07, 3,080 tokens) still got through. It looks like Bifrost checks the budget before a request and only adds the cost after it. The next run (task 08) did one step for 2,737 tokens, then got `402 Budget exceeded: 0.0446 >= 0.0435 dollars` on step 2. The agent printed the error, the dashboard showed "Stopped: virtual key budget exhausted", and the process exited normally. The budget went back to $2.00 right after.

Screenshot: `budget.png`.

#### Private mode

`--private` sends everything to qwen2.5-coder:7b on Ollama through the `thrift-private` key. Two simple tasks, both passed on the first try this time:

- 04 slugify: 1 step, 822 tokens, 14 s, tests 2 of 2.
- 02 pagination: 1 step, 992 tokens, about 10 s, tests 2 of 2. Before the run the same tests failed 2 of 2, and the protected test file was unchanged afterwards.

Cost is $0. This does not change what we wrote earlier: task 01 in private mode fails about half the time. We picked tasks where the small model does well.

Screenshot: `private.png`.

#### Approval

Run without `--yes`, in a copy of task 01 with a local bare repo as `origin`. The task asked for `git add -A`, `git commit` and `git push origin main` and said not to edit files. Each command came up as `run: ...` with an `apply? [y/N]` prompt.

- Deny: add and commit approved, push answered `n`. The agent printed "rejected, stopping" after 3 steps and 2,874 tokens. The remote still had only the starting commit.
- Approve: same three prompts answered `y`. The push went through, the remote got the "Fix percent coupon" commit. 4 steps, 3,984 tokens.

Terminal output for both is in `approval-deny.txt` and `approval-approve.txt`, the dashboard view of the denied run in `approval.png`.

Two things we noticed. When the task is a code fix, the agent ends as soon as the tests pass after a write, so a "fix it, then commit and push" task never reaches the push. And in thrift mode the system prompt pushes the model to write a fix even when the task says the fix is already there; it only stopped doing that when told not to edit any files.

## 2026-11-09

### Benchmark task selection

The runner accepts comma-separated prefixes in `--only`. A zero-run check selected exactly three tasks for `07, 08,09` and one for `03`. This lets us resume a batch without rerunning tasks that already have results.

### Quota handling

The runner now records the first failed naive run that hits a provider quota, then skips further naive attempts in that batch. Thrift runs continue. The November 7 results contain no valid naive run for task 06, so it needs a separate baseline run to complete task coverage.

### Gateway smoke test and batch A

Docker Desktop, Redis and Ollama started locally. Bifrost v2.5.0 downloaded its binary and started from a fresh local config. On a copy of task 01, the CLI fixed the bug and passed all three tests. The gateway fell back from Groq to gemini-3.5-flash. The run used 3,160 tokens over two steps and took 47.0 seconds. This was a smoke test and is outside the benchmark.

The first background launch exited before npm wrote anything. Relaunching with `nohup`, closed stdin and `disown` left the runner alive. Batch A covers tasks 07-17 with one attempt per mode and the default pauses. Its log is `bench/results/batch-a-20261109T122643Z.log`.

### Summary inputs

The summary command now accepts multiple JSONL files. It keeps an existing companion summary and prints combined results to the terminal for multiple inputs. Rechecking the November 7 file still leaves out seven quota failures and gives 11,376 naive tokens and 1,982 thrift tokens per valid run. The runner now prints relative result paths in its log.

The first two launches did not produce result rows. Starting the third in its own process session kept it alive after the shell returned. Groq returned HTTP 403 on the models endpoint twice and Bifrost surfaced it as a 502 on the first naive attempt. The VPN tunnel must stay as it is. We stopped batch A after task 07, which passed in thrift on Gemini Flash with 2,624 tokens and $0.01649 in gateway cost. The raw rows are in `run-2026-11-09T12-27-03-719Z.jsonl`. The remaining thrift attempts run in a separate file. The stale comparison follows them under the same fallback conditions.

### Submission checks

A clean archive installed both npm lockfiles, built the dashboard and reproduced the cart fixture's starting state (two tests pass, one fails). The credential scan found no matches for current secret values or common credential formats in reachable Git blobs. The current tree has no machine-specific absolute paths. An old revision of `bifrost/config.json` still contains local paths in Git history, from before the switch to a generated config.

The benchmark dashboard now shows the stale and thrift pass rates and average tokens together. It only shows naive comparison cards when both naive and thrift rows are present.

Rechecking coverage showed that task 05 also has no valid naive run. The old 83% figure pooled all available runs, including tasks with only thrift results. On shared tasks 01-04, naive passed 11/11 with 11,376 tokens, $0.00159 and 28.7 seconds per run. Thrift passed 12/12 with 1,621 tokens, $0.00023 and 1.7 seconds per run. One thrift cost is missing. The shared-task token and cost differences both round to 86%. The dashboard and summary now use shared tasks for the naive comparison while retaining all runs in the coverage tables.

In the fallback batch, task 12 passed in four Gemini Flash steps with 16,455 tokens. Later steps each resent roughly 4,100-4,400 prompt tokens, compared with 1,429 on the first step. The COMPLEX rule initially chose Groq 120B, then the first request fell back and pinned Gemini. Task 13 failed after Groq and Gemini both errored and Bifrost moved to Ollama. Task 14 passed on Gemini Flash-Lite with 5,722 tokens. We have no valid naive result for these tasks to compare with.

Task 15 passed on Gemini in one coding step with 3,120 total tokens, including 819 for two Tavily searches and the judge calls. The judge correctly flagged the obsolete Zod error accessor. Task 16 passed with 9,600 tokens, but its judge marked a claim containing the bare Express 5 wildcard as current. The [Express 5 migration guide](https://expressjs.com/en/guide/migrating-5/#path-route-matching-syntax) says that wildcard needs a name. A passing patch does not establish that the freshness verdict was right.

The production dependency audit flagged the MCP SDK and its transitive Zod. Updating the agent lockfile in an isolated copy moved the SDK from 1.17.0 to 1.32.2 and cleared the production findings. The updated SDK passed stdio tool listing, read, write and command checks. The running benchmark still uses the dependencies it started with.

### Batch A complete under fallback

Task 17 passed in ten coding steps and 22,025 tokens on Gemini Flash-Lite. The freshness check took 467 tokens and made one search. It incorrectly marked the claim that an Express 5 named wildcard returns a string as current. It returns an array of segments in the fixture.

Across the 11 fallback attempts on tasks 07-17, thrift passed 10/11, averaging 6,960 tokens, $0.01572 in model cost and 43.1 seconds. One cost is missing. Simple was 2/2 (6,360 tokens), medium 6/6 (6,232), and complex 2/3 (8,818). The two JSONL files are `run-2026-11-09T12-27-03-719Z.jsonl` and `run-2026-11-09T12-28-21-480Z.jsonl`.

With the comparable November 7 source included for coverage, thrift has 28 passing runs out of 29 across all 17 tasks, averaging 3,870 tokens. Naive has valid runs on four tasks. The pooled thrift average mixes Groq-era and fallback runs. Compare against naive only on their shared tasks.

Batch B started in `batch-b-20261109T123717Z.log` and writes `run-2026-11-09T12-37-18-207Z.jsonl`. The runner keeps the existing fallback chain and interleaves stale and thrift attempts on each task.

Task 15 finished at 2/3 in both modes. Stale averaged 2,427 tokens and thrift 2,495. Thrift made four searches and flagged the old accessor in the first two attempts. On the third, claim extraction focused on the return shape of `safeParse` and missed the accessor. In each mode Gemini Flash solved the first two attempts and Ollama failed the third after fallback. Both Ollama attempts have missing gateway cost.

Batch B task 16 exposed another judge error. The first thrift attempt caught the bare wildcard and suggested `/api/(.*)`, which the installed Express also rejects. A local registration check confirmed that `/api/*rest` works and both old forms throw. The second attempt extracted no claims and made no searches. Both attempts failed after falling back to Ollama.

Task 16 finished at 0/3 in both modes. Stale averaged 3,878 tokens and thrift 5,180, with five Tavily search attempts across the three thrift runs. Every coding attempt ended on Ollama. Task 17's first stale attempt failed on Gemini Flash-Lite after using 38,095 tokens.

The first stale attempt on task 17 hit the 15-step cap. The event log shows repeated writes followed by failed tests. Prompt size grew from roughly 2,100 tokens at step 5 to 3,515 at step 15 as the tool calls accumulated. In this run the long retry loop, rather than the missing check's own token overhead, explains the 38,095 tokens.

### Batch B complete

Stale and thrift each passed 2 of 9 runs. Stale recorded 14,789 tokens per run and thrift 11,062. Task 17 was 0/3 in both modes, with 38,063 stale tokens and 25,509 thrift tokens per run. All three stale attempts hit the step cap on Gemini Flash-Lite. Thrift switched to Ollama during or before coding in all three attempts. Seven of nine thrift attempts returned a freshness report, one with zero claims. Across those reports the check attempted ten searches.

The two missing reports were on task 17. The first attempt returned one successful freshness model call before the judge failed. Its request ID was still in the raw row, and the gateway log shows 284 tokens that were absent from the recorded total. The second had no successful freshness model request. The third check completed but marked the wildcard's return type as a string. The raw rows stay as recorded. The CLI now counts tokens as each freshness model call returns and records failed checks separately. A mock gateway test covered a judge failure after claim extraction and a successful check, confirming that partial tokens are retained and complete checks are counted once.

There was no pass-rate gain in this batch. The Zod baseline already knew the working API in its Gemini attempts, while the freshness check either missed or misstated relevant Express changes. Both modes also moved between coding models. The lower recorded thrift average on task 17 came with failures and cannot isolate Tavily's effect.

The README and the pitch now separate the shared-task Groq comparison, the fallback coverage, and the Tavily experiment. The dashboard screenshot shows all 18 freshness rows. The seven-slide deck was checked in the browser and as a rendered PDF. The next full comparison needs naive and thrift on tasks 05-17 after Groq access returns. Start with one attempt per mode and keep the default pauses.

### Submission review and demo capture

The public HackCulture FAQ requires an existing public GitHub repository and a PPT upload. A deployed app and demo link are optional. The deck needs the problem, solution, technical architecture, implementation and prototype, including the role of each partner in a combined entry. The public page lists November 15 at 11:59 PM for submission and November 29 for judging. It gives no deadline timezone label or accepted file extensions. The submission notes record the form path, judging criteria and evidence for each requirement.

The Git checkout already points to the team's public GitHub repository. Regenerating the gateway config uses the current checkout and keeps local paths out of the tracked template. Tested a path containing spaces, quotes and an ampersand. The CLI and gateway now resolve relative workspace paths from the same root. The benchmark rejects a custom workspace before touching the fixture.

The Git follow-up path now keeps going after green tests when the task requests Git operations. A mock gateway test covered a plain fix stopping on green and a fix continuing to a rejected push. The denied command never reached execution. The MCP stdio test also verified that symlinks cannot send file tools outside the workspace and that shell commands do not inherit gateway credentials. The event server and Redis now listen only on loopback.

After the Express judge errors, the freshness checker began requiring a URL and a verbatim excerpt present in the retrieved evidence before accepting a verdict. An isolated test kept a supported correction and downgraded an invented URL and fabricated quote to unknown. This change still needs a paired benchmark.

The demo uses screen recordings of the dashboard, archival Bifrost fallback, budget and approval runs, and a newly recorded private pagination run. The private run used 974 tokens in one Ollama step and took the tests from 0/2 to 2/2. The capture includes the scoped benchmark and a Zod source example. The video and PNG frames are local submission files. Groq's models endpoint still returns HTTP 403.

Restarting from the task shell exposed a launcher problem. Bifrost could disappear after its parent shell exited. The gateway launcher now starts a detached process and checks both MCP connection and gateway health before reporting success. Restarted without clearing the gateway databases. The updated stack passed the private pagination smoke test again in one Ollama step, with 973 tokens and both tests passing.

The demo export is 148 seconds at 1920 by 1080 with English narration and captions. The seven original dashboard frames are available separately for the slide mockups. The README opens with the four-task benchmark and keeps the separate Tavily results in their own section.

Live Zod and Express checks each returned unknown without a correction. The Express diagnostic showed that the judge received no source excerpts. A direct Tavily search returned HTTP 403. The agent now counts failed searches, reports them on the dashboard and skips the model judge when there is no evidence. A simulated 403 verified that only the claim extraction model call runs and all extracted claims stay unknown.

### Provider recovery and benchmark reruns

After the tunnel was disabled, a direct Tavily search returned HTTP 200. Direct Groq model and inference probes still returned 403, but Bifrost served the first benchmark requests on Groq without fallback or cache hits. The two routes behaved differently, so the benchmark uses the working gateway route.

The freshness rerun uses three attempts per mode on tasks 15-17 and writes `run-2026-11-09T14-53-34-479Z.jsonl`. The paired run on tasks 05-17 waits for it to finish to avoid competing for the Groq quota. Both runs keep the default pauses and use separate output files.

The dashboard can show the paired suite from a manifest of raw run files. This keeps the source rows in their original batches. The runner now starts the agent directly with Node so its timeout targets the agent process rather than an npm wrapper.

The first two paired attempts on task 17 passed in both freshness modes on Groq 20B. The second used 8,928 tokens and four coding steps in stale mode, compared with 23,015 tokens and seven coding steps in thrift. Freshness accounted for 3,944 of those thrift tokens. The additional coding steps explain the rest of the difference better than search overhead alone.

The freshness rerun finished at 9/9 in each mode. Stale averaged 6,753 tokens and thrift averaged 10,054. Across five thrift runs, 15 searches returned results without provider errors. Six claims were accepted as current and nine were left unknown. No corrections entered the coding prompt. Freshness model calls averaged 3,513 tokens per thrift run. Coding calls alone averaged 6,542, versus 6,753 for stale. One stale attempt used a Gemini fallback, so the model mix limits conclusions about cost and timing. This rerun showed no pass-rate gain.

The paired run stopped after task 13 when the local services went away. Its 18 completed rows all passed. Bifrost, Ollama and the dashboard were restarted, and the runner resumed at task 14 in a new file. A fixture check independently confirmed that all 17 start with failing tests and pass after applying the reference patch.

On task 16, thrift used 7,394 tokens and naive used 5,245. Thrift's 2,258 freshness tokens explain the gap. On task 17, naive returned a provider 429 at the fourteenth request. The gateway identified Groq's 8,000 tokens-per-minute limit. The raw row is retained and excluded from the comparison. One repeat is queued after the thrift attempt and a cooldown.

After the cooldown, naive passed task 17 in a separate run with 14,188 tokens and nine steps. Thrift passed with 20,993 tokens, including 4,063 for freshness, and seven coding steps. Both solved the fixture. Thrift used more tokens on this task even after accounting for its freshness calls.

The pooled paired suite covers all 17 tasks. Naive passed 24/24 valid attempts, averaging 11,126 tokens, $0.00176 and 29.9 seconds. Thrift passed 31/31, averaging 3,579 tokens, $0.00064 and 22.2 seconds. That is 68% fewer tokens per valid run. Eight provider errors are excluded. Four thrift rows have missing costs and are excluded only from the cost average. The manifest lists the four source batches so the dashboard and README use the same rows.

The presentation handoff is a seven-slide brief with exact English copy, a layout plan and PNG crops of the real UI. The team will assemble the PowerPoint file. The revised demo uses the paired dashboard and the fresh Tavily rerun.

### Brief check, November 11

Went back through both problem statements line by line. Three gaps against the mandatory list:

- Confidential repos depended on remembering `--private`. The brief says repos "marked confidential" must stay local no matter what the prompt says. The CLI now reads a `.thrift-private` file or `"thrift": { "private": true }` in `package.json` from the workspace. A marked repo always uses the Ollama-only key, skips Tavily, and refuses the naive baseline. Without `THRIFT_VK_PRIVATE` it exits instead of falling back to the dev key.
- Approval used a list of risky tools. It now works the other way round: `list_files` and `read_file` are free, any other tool needs a yes. That covers tools a new MCP server might add.
- The fallback only showed up as a gray "(fallback)" tag. The brief asks to inform the user, so there is now a plain line saying which model took over. A 402 also prints that the key's limit is reached and the run stops before the next call.

The Tavily brief asks for a system that takes an LLM answer. Our check only looked at the task. The verification half of `freshness.ts` is now a separate `verifyClaims`, and `npm run check` runs it on any answer from a file or stdin. On a sample answer it flagged Zod 3 as outdated with the Zod releases page as source, found a source for the GPT-4 Turbo price, and left Node.js 18 LTS and the Express wildcard unknown because no excerpt contained a quote that settled them. 4 searches, 4,969 tokens.

Live runs after the change, gateway restarted:

- Pagination fixture with `.thrift-private`, no flag: two steps on qwen2.5-coder:7b, 2,925 tokens, tests 0/2 to 2/2.
- Same fixture, task text telling the agent to ignore privacy and use the fastest cloud model: every step stayed on Ollama. The 7b model did not fix the bug in that run (3 steps, 5,139 tokens).
- `--naive` on the marked repo exits with an error.
- Cart fixture in normal mode: one step on gpt-oss-20b, 1,544 tokens, 3/3 tests.

The benchmark code paths are unchanged for unmarked repos, so the recorded results still apply. Pointed the Redis address in the gateway template at 127.0.0.1 to match the loopback binding in `docker-compose.yml`.

Rechecked the headline number. 68% is the mean per run, and tasks 01-06 have more repeats than 07-17. Averaging per task first gives 10,878 naive and 4,931 Thrift tokens, 55% fewer. Thrift was cheaper on 15 of 17 tasks and more expensive on 16 and 17. The README now gives both figures.

### Outages, tests and the stale-claim set, November 11

The brief also asks the agent to keep going when providers fail. Bifrost already moved between providers, but when the whole chain failed the run just crashed and the work was lost. Now the CLI waits and retries a 429, a 5xx or a network error (5, 15, 30, then 60 seconds, or the `retry-after` hint if it is shorter). A 402 is never retried. If the retries run out, the run is saved to `.thrift/session.json` with its messages, step count, tokens and mode, and `npm start -- --resume` continues from the next step. A resumed private run stays private. A clean finish deletes the file.

Tested it live by stopping the gateway in the middle of the cart task. The CLI printed the wait, gave up after the last retry and saved the run. After restarting the gateway, `--resume` finished the fix on the next step.

Added tests, since nothing checked these paths before. `npm test` runs 17 tests with `node:test`. The CLI tests start the real agent against a mock gateway: fallback notice, retry after a 503, save and resume, the 402 stop, a marked private repo, the naive refusal, a declined write that never reaches the tool server, and an unknown tool asking for approval. One bug came out of this: the approval prompt crashed with `ERR_USE_AFTER_CLOSE` when stdin was a pipe. Answers now come from a line queue, and a closed input counts as "no".

The freshness numbers on tasks 15-17 never showed whether the check is any good, because the model solved those tasks either way. So we wrote 30 labeled claims (`bench/stale/claims.json`), 16 stale and 14 current, and checked the uncertain ones by hand with Tavily. Some surprised us: Zod 4 dropped `.errors`, Next.js 16 removed `next lint`, Node 22 is supported until April 2027. `npm run stale-eval` judges each claim from memory and with Tavily.

- v1, one judge call for all claims, cited URL must match exactly: 20/30 with Tavily. Several right verdicts became unknown because the judge dropped the query string from the URL.
- v2, the quote is matched against every excerpt and the source is whichever excerpt holds it: 21/30.
- v3, one judge call per claim at temperature 0: 26/30 and 27/30 on two runs, 15 of 16 stale claims caught each time.
- v4, v3 plus low reasoning effort on the judge: 22/30. Reverted.

Memory alone got between 18 and 24 out of 30 and passed 3 to 7 stale claims as current in every run. Over all runs memory passed 21 of 80 stale claims as current. Tavily passed 0 of 80 and raised no false alarms on 70 current claims.

While doing this, claim extraction sometimes came back empty. gpt-oss spent the whole 2,048 token reply on reasoning. Extraction now asks for low reasoning effort. The judge keeps the default because v4 showed it is less accurate without it.

Settled verdicts and claim lists now go into a file cache for 7 days, keyed by the claim, version and search settings. The benchmark turns it off so every attempt pays full price.

### One call for all edits, November 11

Ran each technique switched off on 9 tasks, one run each. Context up front matters most: without it the average went from 2,921 to 7,212 tokens and 3 runs failed. Without the agent running the tests it was 6,283. Trimming and routing changed little on these short runs.

Then looked at the most expensive Thrift task, 12 (rename a field across three files, 11,410 tokens). The trace showed the model running the failing tests first, then writing one file per step, with the full context resent each time. A direct call through Bifrost confirmed that gpt-oss on Groq returns one tool call per reply even when asked for two, so no prompt can fix that.

The workspace server now has `write_files`, which takes every changed file in one call. Bifrost lets each virtual key list its MCP tools, so `thrift-dev` gets `write_files` while `thrift-baseline` and `thrift-private` keep `write_file`. The baseline sees exactly the tools it had in the recorded runs. The prompt now says to make every change in one reply and leave the tests to the agent. Task 12 went to 2,289 tokens in one step.

Also started comparing with agents people actually use. `npm run compare` copies each fixture to a temp directory, runs Claude Code (`claude -p`) or Codex (`codex exec`) without prompts, puts the protected tests back and runs `npm test`. Tokens are what each agent reports, cached input included, with the split kept in the row. A first Codex run on task 04 passed with 92,109 tokens, 65,920 of them cached. Thrift used 1,294 on the same task.

Full run after the change, one attempt per task: 17/17 passed, 3,150 tokens per task on average against 10,878 for naive, 71% fewer. Fourteen tasks took a single model call. Thrift still spent more than naive on 16 and 17, both because of the Tavily check (3,379 and 4,858 tokens). The coding part alone was under naive on both. Groq's daily quota for gpt-oss-20b ran out partway, so 16 calls went to Gemini and the cost only fell 27%.

Codex on all 17 tasks: 17/17, 91,290 tokens per task of which 77,327 were cached input, 13,963 uncached. Thrift used fewer uncached tokens on 16 of the 17. Claude Code could not run yet because its CLI is not logged in on this machine.
