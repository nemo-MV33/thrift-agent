# Thrift

Thrift is a terminal coding agent for Node.js repositories. Its local dashboard shows which model handled each step, what it did and what the run cost. Team: anakshin power.

The primary Geek Room challenge is **Build a Coding Agent That Gets the Job Done on the Fewest Tokens**. Select the optional **Build a Stale-Answer Detector for AI Applications** challenge for the Tavily integration. The official deadline is November 15, 2026 at 11:59 PM, with no timezone shown on the event page. The team targets November 14. Judging is November 29. [HackCulture event](https://hackculture.io/hackathons/ai-global-hackathon)

## What the prototype does

| Requirement | Implementation |
|---|---|
| Spend fewer tokens | Rank files before the first call, trim old tool output and run tests after an edit. Bifrost routes by task complexity and Thrift pins the responding model. |
| Continue through an outage | The Bifrost fallback chain routes from Groq to Gemini and then to Ollama. |
| Enforce a budget | Bifrost virtual keys carry spending caps. Thrift stops on the gateway's HTTP 402 response. |
| Keep private repositories local | Private mode uses an Ollama-only virtual key and skips Tavily. |
| Ask before risky actions | The CLI previews and requests approval for file writes and shell commands, including Git operations. |
| Verify current APIs | Tavily retrieves source excerpts for version-sensitive claims. The judge cites a retrieved excerpt before its verdict can affect the coding prompt. |

The benchmark grades 17 Node.js fixtures against protected tests and reports model tokens, pass rate, cost and time. A separate experiment compares Thrift with its freshness check off. See the [README](README.md) for results and reproduction and the [journal](docs/journal.md) for raw run notes.

## Submission

The public repository and presentation upload are required. The presentation covers the problem, solution, architecture, implementation and working prototype, with a clear role for Bifrost and Tavily. A deployment or demo video link is optional. See the [submission notes](docs/submission.md) for the form and slide plan.
