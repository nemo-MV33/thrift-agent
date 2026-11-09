# HackCulture submission

The entry is Thrift, a terminal coding agent with a local browser dashboard. The repository is [nemo-MV33/thrift-agent](https://github.com/nemo-MV33/thrift-agent).

## Form

| Field | Entry |
|---|---|
| Project title | Thrift |
| Primary theme | Build a Coding Agent That Gets the Job Done on the Fewest Tokens |
| Optional Tavily challenge | Build a Stale-Answer Detector for AI Applications |
| Project description | Thrift fixes bugs in Node repositories. It cuts prompt context, routes the task through Bifrost, and verifies version-sensitive API claims with Tavily. |
| Source | Existing public GitHub repository and its README |
| Deck | Upload a PowerPoint deck. The public FAQ calls the upload a PPT. Check the allowed extensions in the signed-in form. |
| Demo | Optional video link. The demo shows the CLI and dashboard against real test fixtures. |

The official path is **Manage → Submissions → Problem Statements & Prototype Submission**. The prototype deadline shown is **November 15, 2026 at 11:59 PM**. The public page gives no timezone label next to the deadline. Target November 14. Judging is November 29. Shortlisted teams receive presentation instructions through official channels. The rules require participants to join the official Discord and mention AI tools where applicable. See the [event rules and FAQ](https://hackculture.io/hackathons/ai-global-hackathon).

## Evidence against the challenge

| Requirement | Evidence | Status |
|---|---|---|
| Complete real development tasks with fewer tokens | Protected tests and raw run files. Four shared tasks used 11,376 naive and 1,621 thrift tokens per run, with every valid run passing. | Demonstrated on tasks 01-04. Paired runs on 05-17 await Groq access. |
| Continue through a provider outage | The recorded coupon run moves from Groq to Gemini, pins the responding model, and passes the tests. | Demonstrated |
| Enforce individual limits | A Bifrost virtual key returns HTTP 402, and the agent stops. | Demonstrated |
| Keep confidential work local | The private virtual key allows Ollama only. A local pagination run went from two failing tests to two passing tests. | Demonstrated on the fixture |
| Require approval for writes, shell and Git | The CLI shows the proposed change or command before execution. A rejected push stopped the recorded run. | Demonstrated against a local test remote |
| Use Tavily and Bifrost together | The preflight identifies version-sensitive claims, searches live sources, scores each claim and includes supported corrections in the prompt. | Working prototype. The fallback batch tied 2/9 and surfaced incorrect Express verdicts. |
| Ship a working public prototype | The repository is already public. The README documents setup and reproduction. | Local changes still need the owner's approval before push. |
| Include the pitch deck | Problem, solution, architecture, implementation and prototype. Show both partner integrations. | Content below. PowerPoint production follows review. |

The public criteria are innovation, technical execution, problem solving and impact, use of AI, user experience, and scalability. The public page gives no weights. Show the measurable token savings on the shared tasks, the safety controls in the demo, and the separate limits of the freshness experiment.

## Slide outline

| Slide | Point | Visual or evidence |
|---|---|---|
| 1 / Thrift | Fix the bug with less repeated context. Name the primary challenge and team. | One laptop mockup with the live dashboard. |
| 2 / The problem | A small patch can take repeated file reads, tool calls and full prompt resends. Version changes can also break an otherwise reasonable fix. | Baseline request sequence beside the same task with context supplied up front. |
| 3 / Architecture | CLI builds context and sends the task through Bifrost. Bifrost routes models and exposes MCP tools. The CLI approves and executes calls, runs tests, and emits dashboard events. | Four boxes. Draw the optional Tavily preflight as a separate branch. |
| 4 / Bifrost controls | Show fallback, the 402 budget stop, local Ollama, and a denied push. | Use four small crops or one main image with three callouts. |
| 5 / Benchmark | On tasks 01-04, every valid run passed. Report 11,376 vs 1,621 tokens per run and the number of valid runs. Separate the 10/11 fallback coverage for tasks 07-17. | One horizontal bar comparison with sample sizes and a footnote on quota exclusions. Replace figures only after a valid new batch. |
| 6 / Tavily evidence | Installed version, claim, live source, freshness score and correction. The fallback series tied 2/9. | Use the Zod accessor example and the freshness panel. Keep the Express failure visible as a limitation. |
| 7 / Prototype and next measurement | Run from the terminal, inspect the dashboard, and reproduce the benchmark. Link the public repo and video. | A clean screenshot and short run instructions. |

Use screenshots from the actual desktop dashboard in mockups. Keep text such as token counts, model names, and the approval state legible at slide size. The dashboard is web-based. The coding agent runs in the terminal.
