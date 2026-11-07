# Thrift

A coding agent that tries to finish real dev tasks while spending as few tokens as possible. Built on Bifrost and Tavily for the Geek Room Global AI Hackathon.

Team: anakshin power

Hackathon page: https://hackculture.io/hackathons/ai-global-hackathon

Submission closes 15 Nov 2026 at 23:59. The page doesn't say which timezone, so the plan is to submit on the 14th. Judging is on 29 Nov.

## What we're submitting

Primary problem statement: "Build a Coding Agent That Gets the Job Done on the Fewest Tokens" (Bifrost track).

We also tick the Tavily box for the Stale-Answer Detector, since the agent checks its own assumptions about APIs and library versions against the live web.

If there's time left at the end, a second, separate entry for the Tavily pre-meeting briefing agent. The rules allow two projects, one per technology.

## Why this one

Bifrost is the title partner, and this challenge reads like a list of things Bifrost already does: provider fallbacks, budgets, routing to local models, caching. A good entry here ends up demoing most of their gateway, which is probably what the sponsor wants to see.

It also gives us a number to put on a slide. "Same tasks, same pass rate, 70% fewer tokens" is easy for a judge to remember.

The demo can be scripted around failures: kill a provider mid-task and watch it switch, run out of budget and watch it stop, open a private repo and watch everything stay on Ollama, try a `git push` and get asked first.

## Requirements and how we handle them

| Requirement | Approach |
|---|---|
| Keep working when a provider goes down | Bifrost fallback chain: OpenAI, then Anthropic, then Gemini, then Ollama |
| Per-user spending limits | Bifrost virtual keys with budgets |
| Confidential repos stay local | Private mode routes every call to Ollama |
| Use as few tokens as possible | Pick a cheap or strong model per step, semantic cache, send only the relevant code and a compressed history |
| Ask before risky actions | Approval prompt before file writes, shell commands and git operations |

## Pieces

1. Bifrost gateway with providers, fallbacks, virtual keys and the semantic cache turned on.
2. The agent itself, as a CLI plus a small web dashboard. It has the model router, the context trimming, private mode and the approval prompt.
3. Freshness check. Before the agent relies on an API or a library version, it pulls those claims out of its plan, looks them up with Tavily, gives each one a freshness score and fixes the plan if something is out of date.
4. Benchmark. 10 to 20 real tasks, run several times each, our agent against a plain agent on one model. We compare tokens, cost, pass rate and time.
5. Dashboard showing each step live: tokens, cost, which model was picked and why, and any fallbacks.
6. If we end up writing something reusable inside Bifrost (complexity-based routing, for example), we open it as a PR against their repo.

## What has to be handed in

- Public GitHub repo with a proper README: what it is, how to install it, how it works, what it's built with.
- Pitch deck: problem, solution, architecture, benchmark results, and what Bifrost and Tavily each do in the project.
- A 2 to 3 minute demo video.

## Links

- Bifrost repo: https://github.com/maximhq/bifrost
- Bifrost docs: https://docs.getmaxim.ai
- Tavily docs: https://docs.tavily.com
- Tavily credits: redeem coupon `GEEKROOM2` at https://app.tavily.com/home before 28 Nov

## Next up

Read through the Bifrost repo and docs (fallbacks, virtual keys, semantic cache, MCP), pick the stack, sketch the architecture and a day-by-day plan, then start building.
