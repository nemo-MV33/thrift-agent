import { useEffect, useMemo, useState } from "react";
import type { Store } from "./App";
import { Ev, FeedItem, Gateway, RunSummary, fmtAgo, fmtCost, fmtInt, fmtMs, shortModel, useNow } from "./lib";

type ToolCall = { tool: string; args: string; auto?: boolean; ok?: boolean; at: number };
type Approval = { tool: string; target: string; state: "waiting" | "approved" | "rejected" | "auto"; at: number };

type StepView = {
  kind: "step";
  key: string;
  step: number;
  provider: string;
  model: string;
  fallback: boolean;
  cacheHit: boolean;
  pinned: boolean;
  prompt: number;
  completion: number;
  ms: number | null;
  gateway?: Gateway;
  hasRequest: boolean;
  missing: string | null;
  firstModel: string | null;
  tools: ToolCall[];
  approvals: Approval[];
  at: number;
};
type ErrorView = { kind: "error"; key: string; step: number | null; message: string; at: number };
type Item = StepView | ErrorView;

type Verdict = {
  library: string;
  claim: string;
  status: "current" | "outdated" | "unknown";
  freshness: number;
  correction?: string | null;
  source?: string | null;
};

type RunView = {
  task: string | null;
  mode: string | null;
  startedAt: number | null;
  end: Ev | null;
  items: Item[];
  freshness: { verdicts: Verdict[]; searches: number; failedSearches: number; tokens: number; ms: number } | null;
  tokens: number;
  cost: number;
  costKnown: boolean;
  steps: number;
  lastAt: number;
  stoppedReason: string | null;
};

const isLocal = (s: { provider: string }) => s.provider.toLowerCase() === "ollama";
const stepCost = (s: StepView): number | null => (s.gateway?.cost != null ? s.gateway.cost : isLocal(s) ? 0 : null);

const target = (e: Ev) => String(e.path ?? e.command ?? "");

function buildRun(events: Ev[]): RunView {
  const view: RunView = {
    task: null,
    mode: null,
    startedAt: null,
    end: null,
    items: [],
    freshness: null,
    tokens: 0,
    cost: 0,
    costKnown: false,
    steps: 0,
    lastAt: 0,
    stoppedReason: null,
  };
  const byStep = new Map<number, StepView>();
  let last: StepView | null = null;
  let firstModel: string | null = null;

  for (const e of events) {
    view.lastAt = Math.max(view.lastAt, e.at);
    switch (e.type) {
      case "run_start":
        view.task = String(e.task ?? "");
        view.mode = e.mode ?? null;
        view.startedAt = e.at;
        break;
      case "freshness":
        view.freshness = {
          verdicts: (e.verdicts as Verdict[]) ?? [],
          searches: Number(e.searches ?? 0),
          failedSearches: Number(e.failedSearches ?? 0),
          tokens: Number(e.tokens ?? 0),
          ms: Number(e.ms ?? 0),
        };
        view.tokens += Number(e.tokens ?? 0);
        break;
      case "step": {
        const model = `${e.provider ?? ""}/${e.model ?? ""}`.replace(/^\//, "");
        if (!firstModel) firstModel = model;
        const s: StepView = {
          kind: "step",
          key: `s${e.step}-${e.at}`,
          step: Number(e.step),
          provider: String(e.provider ?? ""),
          model: String(e.model ?? ""),
          fallback: Boolean(e.fallback),
          cacheHit: Boolean(e.cacheHit),
          pinned: Boolean(e.pinned),
          prompt: Number(e.prompt ?? 0),
          completion: Number(e.completion ?? 0),
          ms: e.ms == null ? null : Number(e.ms),
          gateway: e.gateway,
          hasRequest: Boolean(e.requestId),
          missing: e.gatewayMissing ? String(e.gatewayMissing) : null,
          firstModel,
          tools: [],
          approvals: [],
          at: e.at,
        };
        byStep.set(s.step, s);
        last = s;
        view.items.push(s);
        view.steps += 1;
        view.tokens += s.prompt + s.completion;
        const c = stepCost(s);
        if (c != null) {
          view.cost += c;
          view.costKnown = true;
        }
        break;
      }
      case "tool": {
        const s = byStep.get(Number(e.step)) ?? last;
        s?.tools.push({ tool: String(e.tool), args: String(e.args ?? ""), auto: e.auto as boolean, ok: e.ok as boolean, at: e.at });
        break;
      }
      case "approval_wait":
        last?.approvals.push({ tool: String(e.tool), target: target(e), state: "waiting", at: e.at });
        break;
      case "approval": {
        const state = e.auto ? "auto" : e.approved ? "approved" : "rejected";
        const pending = last?.approvals.find((a) => a.state === "waiting" && a.tool === e.tool && a.target === target(e));
        if (pending) pending.state = state;
        else last?.approvals.push({ tool: String(e.tool), target: target(e), state, at: e.at });
        break;
      }
      case "error":
        view.items.push({ kind: "error", key: `e${e.at}`, step: e.step == null ? null : Number(e.step), message: String(e.message ?? "error"), at: e.at });
        view.stoppedReason = String(e.message ?? "error");
        break;
      case "run_end":
        view.end = e;
        if (typeof e.tokens === "number") view.tokens = e.tokens;
        if (e.error) view.stoppedReason = String(e.error);
        else if (e.stopped && !view.stoppedReason) view.stoppedReason = "Stopped before finishing";
        break;
    }
    if (!view.mode && e.mode) view.mode = e.mode;
  }
  return view;
}

export function LivePage({ store }: { store: Store }) {
  const { runs, events, loadRun } = store;
  const [picked, setPicked] = useState<string | null>(null);
  const activeId = picked ?? runs[0]?.runId ?? null;

  useEffect(() => {
    if (activeId) loadRun(activeId);
  }, [activeId, loadRun]);

  const evs = activeId ? events[activeId] : undefined;
  const run = useMemo(() => (evs ? buildRun(evs) : null), [evs]);

  return (
    <div className="live">
      <p className="page-sub">
        Every model call the coding agent makes: which model the Bifrost gateway picked, why, and what it cost.
      </p>
      <section className="live-main">
        {!store.serverOnline && runs.length === 0 ? (
          <Empty title="Event server is not reachable" body="Start it inside dashboard/. The page reconnects on its own." command="cd dashboard && npm run dev" />
        ) : !activeId ? (
          <Empty
            title="No runs yet"
            body="Start the agent and its steps stream in here live."
            command={'cd agent && npx tsx src/index.ts "Fix the failing test in cart.js"'}
          />
        ) : !run ? (
          <Skeleton />
        ) : (
          <RunDetail run={run} following={picked == null} onFollow={() => setPicked(null)} />
        )}
      </section>
      <aside className="live-side">
        <Legend />
        <RunPicker runs={runs} active={activeId} following={picked == null} onPick={(id) => setPicked(id)} onFollow={() => setPicked(null)} />
        <GatewayFeed feed={store.feed} online={store.gatewayOnline} />
      </aside>
    </div>
  );
}

function RunDetail({ run, following, onFollow }: { run: RunView; following: boolean; onFollow: () => void }) {
  const now = useNow(250);
  const live = !run.end && !run.stoppedReason;
  const elapsed = run.end?.ms != null ? Number(run.end.ms) : run.startedAt ? (live ? now : run.lastAt) - run.startedAt : null;
  const state = run.stoppedReason ? "stopped" : run.end ? (run.end.finished ? "finished" : "ended") : "running";

  return (
    <>
      <div className="run-head">
        <div className="run-title">
          <div className="run-meta">
            <span className="eyebrow-label">Run</span>
            {run.mode && <span className={`mode mode-${run.mode}`}>{run.mode}</span>}
            <span className={`state state-${state}`}>
              {state === "running" && <span className="pulse" />}
              {state}
            </span>
            {!following && (
              <button className="link-btn" onClick={onFollow}>
                Follow latest
              </button>
            )}
          </div>
          <h1 className="display">{run.task || "Untitled task"}</h1>
        </div>
        <dl className="totals">
          <Stat label="Tokens" value={fmtInt(run.tokens)} />
          <Stat label="Cost" value={run.costKnown ? fmtCost(run.cost) : "-"} />
          <Stat label="Steps" value={String(run.steps)} />
          <Stat label="Elapsed" value={fmtMs(elapsed)} />
        </dl>
      </div>

      {run.stoppedReason && <StoppedBanner message={run.stoppedReason} />}
      {run.freshness && <FreshnessCard f={run.freshness} />}

      {run.items.length === 0 ? (
        <div className="timeline-empty">{live ? "Waiting for the first step." : "This run has no steps."}</div>
      ) : (
        <ol className="timeline">
          {run.items.map((it, i) =>
            it.kind === "step" ? <StepCard key={it.key} s={it} live={live && i === run.items.length - 1} /> : <ErrorRow key={it.key} e={it} />,
          )}
        </ol>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function StoppedBanner({ message }: { message: string }) {
  const budget = /402|budget/i.test(message);
  return (
    <div className="banner" role="alert">
      <div className="banner-title">{budget ? "Stopped: virtual key budget exhausted" : "Run stopped"}</div>
      <div className="banner-body mono">{message}</div>
    </div>
  );
}

function why(s: StepView): { label: string; detail: string | null; tip: string } {
  const g = s.gateway;
  if (s.fallback || (g && g.fallbackIndex > 0)) {
    return {
      label: "Fallback",
      detail: s.firstModel && s.firstModel !== `${s.provider}/${s.model}` ? `after ${shortModel(s.firstModel)} failed` : "primary provider failed",
      tip: "The first choice failed, the gateway retried on the next provider in the chain",
    };
  }
  if (s.pinned) return { label: "Pinned", detail: "same model as step 1", tip: "Kept on the model routed for step 1 so the run stays consistent" };
  if (g?.complexityTier || g?.routingRule) {
    return {
      label: g.complexityTier ? `${g.complexityTier.toLowerCase()} task` : "Routed",
      detail: g.routingRule ? `rule ${g.routingRule}` : null,
      tip: "The gateway scored the request and picked the cheapest model for its tier",
    };
  }
  if (g) return { label: "Direct", detail: g.virtualKey ? `key ${g.virtualKey}` : null, tip: "Sent straight to this model, no routing rule applied" };
  if (isLocal(s)) return { label: "Local", detail: "runs on this machine", tip: "Private mode: a local Ollama model, nothing leaves the laptop" };
  if (s.missing) return { label: "No gateway log", detail: s.missing === "gateway offline" ? "gateway was offline" : null, tip: "The gateway log for this request was not found" };
  return { label: "Waiting", detail: s.hasRequest ? "for the gateway log" : null, tip: "Routing details arrive from the gateway log a moment after the call" };
}

const PROVIDERS = ["groq", "gemini", "ollama", "openai", "anthropic", "openrouter"];

function StepCard({ s, live }: { s: StepView; live: boolean }) {
  const w = why(s);
  const g = s.gateway;
  const prov = PROVIDERS.includes(s.provider.toLowerCase()) ? s.provider.toLowerCase() : "other";
  const cls = ["step", "enter", `prov-${prov}`, live ? "step-live" : "", w.label === "Fallback" ? "step-fallback" : ""].filter(Boolean).join(" ");
  return (
    <li className={cls}>
      <div className="step-top">
        <span className="step-num">{String(s.step).padStart(2, "0")}</span>
        <span className="step-kind">
          {s.provider}
          {g?.complexityTier ? ` / ${g.complexityTier.toLowerCase()}` : ""}
        </span>
      </div>
      <div className="model-name">{shortModel(s.model)}</div>
      <div className="step-why">
        <span className="why-label">Why this model</span>
        <span className={`why why-${w.label.split(" ")[0].toLowerCase()}`} title={w.tip}>
          {w.label}
        </span>
        {w.detail && <span className="why-detail">{w.detail}</span>}
        {s.cacheHit && (
          <span className="badge badge-cache" title="Answered from the semantic cache, no model call">
            cache hit
          </span>
        )}
        {g && g.retries > 0 && <span className="badge">{g.retries} retries</span>}
      </div>
      {live && (
        <div className="step-running">
          <span>running</span>
          <span className="meter" aria-hidden>
            <i />
          </span>
        </div>
      )}
      <dl className="step-nums">
        <div>
          <dt>in</dt>
          <dd>{fmtInt(s.prompt)}</dd>
        </div>
        <div>
          <dt>out</dt>
          <dd>{fmtInt(s.completion)}</dd>
        </div>
        <div>
          <dt>cost</dt>
          <dd>{stepCost(s) != null ? fmtCost(stepCost(s)) : s.missing ? "n/a" : s.hasRequest ? <span className="shimmer">....</span> : "-"}</dd>
        </div>
        <div>
          <dt>latency</dt>
          <dd>{fmtMs(g?.latency ?? s.ms)}</dd>
        </div>
      </dl>
      {(s.tools.length > 0 || s.approvals.length > 0) && (
        <ul className="tools">
          {s.tools.map((t, i) => (
            <li key={i} className={t.ok === false ? "tool fail enter" : "tool enter"}>
              <span className="tool-name">{t.tool}</span>
              <span className="tool-args">{t.args}</span>
              {t.auto && <span className="tool-tag">auto</span>}
            </li>
          ))}
          {s.approvals.map((a, i) => (
            <li key={`a${i}`} className={`approval approval-${a.state} enter`}>
              <span className="approval-state">
                {a.state === "waiting" && <span className="pulse" />}
                {a.state === "waiting" ? "Waiting for approval" : a.state === "auto" ? "Auto approved" : a.state === "approved" ? "Approved" : "Rejected"}
              </span>
              <span className="tool-name">{a.tool}</span>
              <span className="tool-args">{a.target}</span>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

function ErrorRow({ e }: { e: ErrorView }) {
  return (
    <li className="step step-error enter">
      <div className="step-top">
        <span className="step-num">{e.step != null ? String(e.step).padStart(2, "0") : "!"}</span>
        <span className="step-kind">error</span>
      </div>
      <div className="error-text mono-wrap">{e.message}</div>
    </li>
  );
}

function FreshnessCard({ f }: { f: NonNullable<RunView["freshness"]> }) {
  return (
    <section className="panel fresh enter">
      <header className="panel-head">
        <h2>Freshness check</h2>
        <span className="muted mono">
          {f.searches} searches{f.failedSearches > 0 && ` (${f.failedSearches} failed)`}, {fmtInt(f.tokens)} tokens, {fmtMs(f.ms)}
        </span>
      </header>
      {f.verdicts.length === 0 ? (
        <p className="muted pad">No library claims needed checking.</p>
      ) : (
        <ul className="verdicts">
          {f.verdicts.map((v, i) => (
            <li key={i} className="verdict">
              <div className="verdict-top">
                <span className="lib mono">{v.library}</span>
                <span className={`pill pill-${v.status}`}>{v.status}</span>
                <span className="score" aria-label={`freshness ${Math.round(v.freshness * 100)}%`}>
                  <span className="score-bar">
                    <span style={{ transform: `scaleX(${Math.max(0, Math.min(1, v.freshness))})` }} />
                  </span>
                  <span className="mono">{v.freshness.toFixed(2)}</span>
                </span>
              </div>
              <p className="claim">{v.claim}</p>
              {v.correction && <p className="correction">{v.correction}</p>}
              {v.source && (
                <a className="source" href={v.source} target="_blank" rel="noreferrer">
                  {v.source.replace(/^https?:\/\//, "")}
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RunPicker(props: { runs: RunSummary[]; active: string | null; following: boolean; onPick: (id: string) => void; onFollow: () => void }) {
  const now = useNow(5000);
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Runs</h2>
        {!props.following && (
          <button className="link-btn" onClick={props.onFollow}>
            Latest
          </button>
        )}
      </header>
      {props.runs.length === 0 ? (
        <p className="muted pad">Runs appear here once the agent posts its first event.</p>
      ) : (
        <ul className="run-list">
          {props.runs.map((r) => (
            <li key={r.runId}>
              <button className={r.runId === props.active ? "run-item on" : "run-item"} onClick={() => props.onPick(r.runId)}>
                <span className="run-item-task">{r.task || r.runId}</span>
                <span className="run-item-meta">
                  {r.mode && <span className={`mode mode-${r.mode} small`}>{r.mode}</span>}
                  <span className={r.error ? "neg" : r.ended ? "muted" : "live-text"}>{r.error ? "stopped" : r.ended ? "done" : "live"}</span>
                  <span className="muted">{fmtAgo(r.updatedAt, now)}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function GatewayFeed({ feed, online }: { feed: FeedItem[]; online: boolean | null }) {
  return (
    <section className="panel feed">
      <header className="panel-head">
        <h2>Gateway feed</h2>
        <span className="muted">all keys</span>
      </header>
      {online === false ? (
        <p className="muted pad">Gateway offline. Requests show up here when it is reachable again.</p>
      ) : feed.length === 0 ? (
        <p className="muted pad">{online == null ? "Connecting..." : "No requests yet."}</p>
      ) : (
        <ul className="feed-list">
          {feed.slice(0, 30).map((f) => (
            <li key={f.id} className={`feed-row enter ${f.status !== "success" ? "feed-fail" : ""}`}>
              <div className="feed-line">
                <span className="feed-model">{shortModel(f.model)}</span>
                <span className="mono">{fmtCost(f.cost)}</span>
              </div>
              <div className="feed-line muted">
                <span>
                  {f.key ?? "no key"}
                  {f.tier ? ` / ${f.tier.toLowerCase()}` : ""}
                  {f.fallbackIndex > 0 ? " / fallback" : ""}
                </span>
                <span className="mono">
                  {fmtInt(f.tokens)} tok, {fmtMs(f.latency)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Empty({ title, body, command }: { title: string; body: string; command?: string }) {
  return (
    <div className="empty">
      <h2>{title}</h2>
      <p>{body}</p>
      {command && <code className="cmd">{command}</code>}
    </div>
  );
}

function Legend() {
  return (
    <section className="panel legend-panel">
      <header className="panel-head">
        <h2>How to read a step</h2>
      </header>
      <ul className="key">
        <li>
          <i className="key-sw prov-groq" />
          Groq
        </li>
        <li>
          <i className="key-sw prov-gemini" />
          Gemini
        </li>
        <li>
          <i className="key-sw prov-ollama" />
          Ollama, local
        </li>
        <li>
          <i className="key-sw key-live" />
          Running now
        </li>
        <li>
          <span className="why why-fallback">Fallback</span>
          first model failed, next one answered
        </li>
        <li>
          <span className="badge badge-cache">cache hit</span>
          served from cache, no model call
        </li>
        <li>
          <span className="why">Pinned</span>
          kept on the step 1 model
        </li>
      </ul>
    </section>
  );
}

function Skeleton() {
  return (
    <div className="skeleton">
      <div className="sk sk-title" />
      <div className="sk sk-row" />
      <div className="sk sk-card" />
      <div className="sk sk-card" />
    </div>
  );
}
