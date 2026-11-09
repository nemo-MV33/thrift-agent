# Thrift demo video

The final recording runs for 2 minutes 28 seconds. It shows the local dashboard and tests from the benchmark fixtures. The outage, budget and approval scenes replay recorded runs. The approval scene used a local bare Git remote.

| Time | On screen | Narration |
|---|---|---|
| 0:00-0:17 | Thrift cover, followed by the dashboard and CLI flow. | Thrift is a terminal coding agent with a browser dashboard. It reads the relevant files, asks Bifrost to route the task, and checks its changes against the repository's tests. |
| 0:17-0:39 | Coupon run with the Gemini fallback, followed by the pinned model. | In this recorded test, we deliberately failed the primary provider. Bifrost sent the coupon fix to Gemini. Thrift kept the same model for the next step, applied the change, and the tests passed. |
| 0:39-0:57 | Virtual key budget stop and HTTP 402. | Each Bifrost virtual key can carry its own spending limit. This key had room for the first request. The next request returned 402, and Thrift stopped. |
| 0:57-1:19 | Private pagination run on local Ollama with before and after test counts. | This pagination task starts with two failing tests. Private mode sends the task through a key restricted to local Ollama. The local model fixed the bug in one step, and both tests passed. |
| 1:19-1:41 | A rejected push in the dashboard, with the original terminal excerpt. | Thrift asks before writes and shell commands. In this recorded run we approved the local add and commit. We declined git push. The agent stopped, and the test remote stayed at its starting commit. |
| 1:41-2:04 | Paired benchmark and pass counts. | On 17 shared tasks, the baseline averaged 11,126 tokens per run. Thrift averaged 3,579, 68 percent fewer. Naive passed 24 of 24 valid runs. Thrift passed 31 of 31. |
| 2:04-2:28 | Stale and thrift results, then the Zod claim with its source link. | Tavily searches for evidence about the installed library version. Here the dashboard cites the Zod changelog. In the rerun, both modes passed all nine attempts. The freshness check used more tokens, and we did not measure a pass rate gain. |

The [README](../../README.md#results) links the exact raw result files used in the recording.
