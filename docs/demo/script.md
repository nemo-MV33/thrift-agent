# Thrift demo video

Target length: 2 minutes 35 seconds. Record the terminal and dashboard side by side where possible. Use a separate fixture for each scene. Keep the gateway setup page and environment file out of the recording.

| Time | On screen | Narration |
|---|---|---|
| 0:00-0:17 | Start on the live dashboard with the percent-coupon task and its failing test. | "Thrift fixes small bugs in Node repos. It starts with the relevant files, asks Bifrost to pick a model, and runs the tests after an edit. It stops when they pass." |
| 0:17-0:44 | Show the fallback run. Open step 1, point to the Gemini model and fallback badge, then show the same model on step 2 and the green test result. | "For this scene we forced Groq to fail. Bifrost sent the request to Gemini. Thrift pinned the model that answered and finished the fix on the next step." |
| 0:44-1:04 | Show the budget run. Open the first completed step, then show the 402 and stopped state on the next step. | "Bifrost enforces a budget on the virtual key. Here it let the first step through. The next request got a 402, and Thrift stopped." |
| 1:04-1:27 | Show the private pagination run. Point to the private virtual key, Ollama model and passing tests. | "For the private fixture, the key only allows local Ollama. The pagination fix passed in one step, with no cloud model or Tavily request." |
| 1:27-1:54 | Show the approval terminal at the push prompt. Enter `n`. Show the stopped run and the unchanged log of the local bare remote. | "Thrift asks before running commands. I let it add and commit the change, then declined the push. The local commit is there. The remote stayed at its starting commit." |
| 1:54-2:35 | Open Benchmark. Select the comparison files, point to coverage and pass rates, then show the Express 5 example or the freshness evidence from the run. | "We copy the same tasks for both modes and restore the protected tests before grading. Naive sends the full history to one model. Thrift cuts that history and checks version-sensitive API assumptions through Tavily. Express 5 is a good example. A wildcard route needs a parameter name now. The benchmark tracks whether the tests passed and how many tokens each approach used." |

Before recording, read the Results section of the README and use only the figures for the selected files. Keep the scope on screen if either comparison is partial. Show the existing screenshots if you are using the recorded fallback or budget result. The approval scene uses a local bare remote.
