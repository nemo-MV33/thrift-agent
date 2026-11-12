import { useEffect, useMemo, useState } from "react";
import { BenchFile, BenchRow, Mode, fmtCost, fmtInt, fmtMs, fmtPct, getJSON, shortModel } from "./lib";
import { Empty } from "./Live";

type Agg = { runs: number; pass: number; passRate: number; tokens: number | null; cost: number | null; ms: number | null };
const MODES: Mode[] = ["naive", "thrift", "stale"];

function avgKnown(values: (number | null | undefined)[]): number | null {
  const known = values.filter((value): value is number => typeof value === "number");
  return known.length ? known.reduce((a, b) => a + b, 0) / known.length : null;
}

function agg(rows: BenchRow[]): Agg | null {
  if (!rows.length) return null;
  const pass = rows.filter((r) => r.pass).length;
  return {
    runs: rows.length,
    pass,
    passRate: pass / rows.length,
    tokens: avgKnown(rows.map((r) => r.tokens)),
    cost: avgKnown(rows.map((r) => r.cost)),
    ms: avgKnown(rows.map((r) => r.ms)),
  };
}

function pickDefault(files: BenchFile[]) {
  return files.find((file) => file.name === "current-suite")
    ?? files.find((file) => file.name === "paired-suite")
    ?? [...files].sort((a, b) => b.rows - a.rows || Number(b.hasFreshness) - Number(a.hasFreshness) || b.mtime - a.mtime)[0];
}

export function BenchPage() {
  const [files, setFiles] = useState<BenchFile[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [file, setFile] = useState<string | null>(null);
  const [rows, setRows] = useState<BenchRow[] | null>(null);

  useEffect(() => {
    getJSON<BenchFile[]>("/api/bench")
      .then((f) => {
        setFiles(f);
        if (f.length) setFile(pickDefault(f).name);
      })
      .catch(() => setFailed(true));
  }, []);

  useEffect(() => {
    if (!file) return;
    setRows(null);
    getJSON<{ rows: BenchRow[] }>(`/api/bench/${encodeURIComponent(file)}`)
      .then((d) => setRows(d.rows))
      .catch(() => setRows([]));
  }, [file]);

  if (failed) return <Empty title="Event server is not reachable" body="Benchmark files are served by the dashboard server. Start it with npm run dev." />;
  if (files && files.length === 0) return <Empty title="No benchmark results yet" body="Run the benchmark and its results file will appear here." command="cd agent && npm run bench -- --runs 3" />;
  const modes = new Set(rows?.filter((r) => !providerFailure(r)).map((r) => r.mode));
  const others = modes.has("claude-code") || modes.has("codex");
  const label = modes.has("stale") ? "Stale vs thrift" : others ? "Four agents, same tests" : modes.has("naive") ? "Naive vs thrift" : "Thrift runs";

  return (
    <div className="bench">
      <div className="bench-bar">
        <div className="bench-title">
          <span className="eyebrow-label">{label}</span>
          <h1 className="display">Benchmark</h1>
          <p className="page-sub">
            Small Node repos with failing tests, judged by the original tests. Naive sends the full history to one model. Thrift routes once per task and keeps context short. Claude Code and Codex ran the same tasks.
          </p>
        </div>
        <label className="select">
          <span className="sr-only">Results file</span>
          <select value={file ?? ""} onChange={(e) => setFile(e.target.value)} disabled={!files}>
            {files?.map((f) => (
              <option key={f.name} value={f.name}>
                {f.label ?? f.name.replace(/^run-|\.jsonl$/g, "").replace(/T(\d\d)-(\d\d)-(\d\d)-\d+Z/, " $1:$2:$3")} ({f.rows} rows)
              </option>
            ))}
          </select>
        </label>
      </div>
      {!rows ? <div className="skeleton"><div className="sk sk-row" /><div className="sk sk-card" /></div> : rows.length === 0 ? <Empty title="This file is empty" body="Pick another results file." /> : <BenchBody rows={rows} />}
      <StaleClaims />
    </div>
  );
}

// Keep provider failures out of the comparison, as in agent/src/summarize.ts.
const providerFailure = (r: BenchRow) =>
  !r.pass && /\b429\b|rate limit|all configured keys returned permanent per-key errors/i.test(r.error ?? "");

function BenchBody({ rows: all }: { rows: BenchRow[] }) {
  const rows = all.filter((r) => !providerFailure(r));
  const skipped = all.length - rows.length;
  const main = rows.filter((r) => r.mode !== "stale");
  const naiveTasks = new Set(main.filter((r) => r.mode === "naive").map((r) => r.task));
  const thriftTasks = new Set(main.filter((r) => r.mode === "thrift").map((r) => r.task));
  const shared = new Set([...naiveTasks].filter((task) => thriftTasks.has(task)));
  const paired = main.filter((r) => shared.has(r.task));
  const naive = agg(paired.filter((r) => r.mode === "naive"));
  const thrift = agg(paired.filter((r) => r.mode === "thrift"));
  const tiers = ["simple", "medium", "complex"].filter((tier) => paired.some((r) => r.tier === tier));
  const staleTasks = new Set(rows.filter((r) => r.mode === "stale").map((r) => r.task));
  const fresh = rows.filter((r) => staleTasks.has(r.task));
  const headline = naive && thrift;

  return (
    <>
      {headline && <Headline naive={naive} thrift={thrift} taskCount={shared.size} />}
      <AgentsPanel rows={rows} />
      {fresh.length > 0 && <FreshSection rows={fresh} />}
      <div className={headline ? "bench-grid" : undefined}>
        <section className="panel">
          <header className="panel-head">
            <h2>Tokens per task</h2>
            <Legend modes={MODES.filter((m) => rows.some((r) => r.mode === m))} />
          </header>
          <TokenChart rows={rows} />
        </section>
        {headline && (
          <section className="panel">
            <header className="panel-head">
              <h2>By tier</h2>
            </header>
            <TierTable rows={paired} tiers={tiers} />
          </section>
        )}
      </div>
      <section className="panel">
        <header className="panel-head">
          <h2>Per task</h2>
          <span className="muted">
            {rows.length} runs{skipped > 0 && `, ${skipped} excluded for provider errors`}
          </span>
        </header>
        <TaskTable rows={rows} />
      </section>
    </>
  );
}

function delta(a: number | null | undefined, b: number | null | undefined) {
  if (a == null || b == null || a === 0) return null;
  return (b - a) / a;
}

function Headline({ naive, thrift, taskCount }: { naive: Agg; thrift: Agg; taskCount: number }) {
  const cells: { label: string; n: string; t: string; d: number | null; lowerBetter: boolean; abs?: boolean }[] = [
    { label: "Pass rate", n: fmtPct(naive?.passRate), t: fmtPct(thrift?.passRate), d: naive && thrift ? thrift.passRate - naive.passRate : null, lowerBetter: false, abs: true },
    { label: "Avg tokens", n: fmtInt(naive?.tokens), t: fmtInt(thrift?.tokens), d: delta(naive?.tokens, thrift?.tokens), lowerBetter: true },
    { label: "Avg cost", n: fmtCost(naive?.cost), t: fmtCost(thrift?.cost), d: delta(naive?.cost, thrift?.cost), lowerBetter: true },
    { label: "Avg time", n: fmtMs(naive?.ms), t: fmtMs(thrift?.ms), d: delta(naive?.ms, thrift?.ms), lowerBetter: true },
  ];
  const td = delta(naive?.tokens, thrift?.tokens);
  const cd = delta(naive?.cost, thrift?.cost);
  return (
    <div className="headline">
      <div className="hero">
        <span className="hero-tag">Thrift token change</span>
        <div className="hero-num">
          {td == null ? "-" : `${td > 0 ? "+" : ""}${(td * 100).toFixed(0)}%`}
          <small>tokens</small>
        </div>
        <p className="hero-sub">
          {fmtInt(naive.tokens)} to {fmtInt(thrift.tokens)} tokens per run on {taskCount} shared {taskCount === 1 ? "task" : "tasks"}
          {cd != null ? `, cost ${cd > 0 ? "+" : ""}${(cd * 100).toFixed(0)}%` : ""}.
        </p>
      </div>
      {cells.map((c) => {
        const good = c.d == null ? null : c.lowerBetter ? c.d < 0 : c.d >= 0;
        return (
          <div key={c.label} className="kpi">
            <div className="kpi-label">{c.label}</div>
            <div className="kpi-value">{c.t}</div>
            <div className="kpi-foot">
              <span className="muted">naive {c.n}</span>
              {c.d != null && (
                <span className={good ? "pos" : c.d === 0 ? "muted" : "neg"}>
                  {c.d > 0 ? "+" : ""}
                  {c.abs ? `${(c.d * 100).toFixed(0)} pts` : fmtPct(c.d)}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Legend({ modes }: { modes: Mode[] }) {
  return (
    <span className="legend">
      {modes.map((m) => (
        <span key={m}>
          <i className={`sw sw-${m}`} />
          {m}
        </span>
      ))}
    </span>
  );
}

function TokenChart({ rows }: { rows: BenchRow[] }) {
  const tasks = [...new Set(rows.map((r) => r.task))].sort();
  const modes = MODES.filter((m) => rows.some((r) => r.mode === m));
  const data = tasks.map((task) => ({
    task,
    vals: modes.map((m) => avgKnown(rows.filter((r) => r.task === task && r.mode === m).map((r) => r.tokens))),
  }));
  const max = Math.max(1, ...data.flatMap((d) => d.vals.map((v) => v ?? 0)));
  const [hover, setHover] = useState<string | null>(null);

  return (
    <div className="hbars" role="img" aria-label="Average tokens per task by mode">
      {data.map((d) => (
        <div key={d.task} className={hover && hover !== d.task ? "hbar-row dim" : "hbar-row"} onMouseEnter={() => setHover(d.task)} onMouseLeave={() => setHover(null)}>
          <span className="hbar-label" title={d.task}>
            {d.task}
          </span>
          <div className="hbar-stack">
            {d.vals.map((v, i) => (
              <div key={modes[i]} className="hbar-line">
                <span className={`hbar sw-${modes[i]}`} style={{ transform: `scaleX(${(v ?? 0) / max})` }} />
                <span className="hbar-val">{v == null ? "" : fmtInt(v)}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function TierTable({ rows, tiers }: { rows: BenchRow[]; tiers: string[] }) {
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Tier</th>
            <th className="r">Pass n / t</th>
            <th className="r">Tokens n</th>
            <th className="r">Tokens t</th>
            <th className="r">Saved</th>
          </tr>
        </thead>
        <tbody>
          {tiers.map((tier) => {
            const n = agg(rows.filter((r) => r.tier === tier && r.mode === "naive"));
            const t = agg(rows.filter((r) => r.tier === tier && r.mode === "thrift"));
            const d = delta(n?.tokens, t?.tokens);
            return (
              <tr key={tier}>
                <td>{tier}</td>
                <td className="r num">
                  {fmtPct(n?.passRate)} / {fmtPct(t?.passRate)}
                </td>
                <td className="r num">{fmtInt(n?.tokens)}</td>
                <td className="r num">{fmtInt(t?.tokens)}</td>
                <td className={`r num ${d == null ? "" : d < 0 ? "pos" : d > 0 ? "neg" : ""}`}>{d == null ? "-" : fmtPct(-d)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Marks({ rows }: { rows: BenchRow[] }) {
  if (!rows.length) return <span className="muted">-</span>;
  return (
    <span className="marks">
      {[...rows].sort((a, b) => a.run - b.run).map((r) => (
        <i key={r.run} className={r.crashed ? "mark crash" : r.pass ? "mark ok" : "mark fail"} title={`run ${r.run}: ${r.crashed ? "crashed" : r.pass ? "pass" : "fail"}${r.error ? ` (${r.error})` : ""}`} />
      ))}
    </span>
  );
}

function TaskTable({ rows }: { rows: BenchRow[] }) {
  const tasks = useMemo(() => [...new Set(rows.map((r) => r.task))].sort(), [rows]);
  const modes = MODES.filter((mode) => rows.some((r) => r.mode === mode));
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Task</th>
            <th>Tier</th>
            {modes.map((m) => (
              <th key={m} className="r">
                {m} tokens
              </th>
            ))}
            {modes.map((m) => (
              <th key={`p${m}`}>{m}</th>
            ))}
            <th>Thrift model</th>
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const tr = rows.filter((r) => r.task === task);
            const models = [...new Set(tr.filter((r) => r.mode === "thrift").flatMap((r) => r.models ?? []))];
            return (
              <tr key={task}>
                <td className="mono">{task}</td>
                <td className="muted">{tr[0]?.tier}</td>
                {modes.map((m) => {
                  const a = agg(tr.filter((r) => r.mode === m));
                  return (
                    <td key={m} className="r num">
                      {fmtInt(a?.tokens)}
                    </td>
                  );
                })}
                {modes.map((m) => (
                  <td key={`p${m}`}>
                    <Marks rows={tr.filter((r) => r.mode === m)} />
                  </td>
                ))}
                <td className="mono muted small">{models.map((m) => shortModel(m.split("/").slice(1).join("/") || m)).join(", ") || "-"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FreshSection({ rows }: { rows: BenchRow[] }) {
  const stale = agg(rows.filter((r) => r.mode === "stale"));
  const thrift = agg(rows.filter((r) => r.mode === "thrift"));
  const tasks = [...new Set(rows.map((r) => r.task))].sort();
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Freshness tasks</h2>
        <span className="muted">stale docs vs live check</span>
      </header>
      <div className="fresh-cmp">
        <div className="fresh-kpi">
          <span className="kpi-label">Stale pass rate</span>
          <span className="kpi-value">{fmtPct(stale?.passRate)}</span>
          <span className="muted">{stale ? `${stale.pass} of ${stale.runs}` : "no stale runs"}</span>
          {stale && <span className="muted">{fmtInt(stale.tokens)} avg tokens</span>}
        </div>
        <div className="fresh-kpi">
          <span className="kpi-label">Thrift pass rate</span>
          <span className="kpi-value">{fmtPct(thrift?.passRate)}</span>
          <span className="muted">{thrift ? `${thrift.pass} of ${thrift.runs}` : "no thrift runs"}</span>
          {thrift && <span className="muted">{fmtInt(thrift.tokens)} avg tokens</span>}
        </div>
        <ul className="fresh-tasks">
          {tasks.map((t) => (
            <li key={t}>
              <span className="mono">{t}</span>
              <span className="fresh-marks">
                <span className="muted small">stale</span>
                <Marks rows={rows.filter((r) => r.task === t && r.mode === "stale")} />
                <span className="muted small">thrift</span>
                <Marks rows={rows.filter((r) => r.task === t && r.mode === "thrift")} />
              </span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

type StaleRow = { id: string; mode: string; truth: string; status: string; tokens: number; search: { name: string; judge: string } | null };

// Labeled claims from bench/stale/claims.json. Memory is the judge with no
// evidence; each Tavily setting is one version of the search and judge.
function StaleClaims() {
  const [files, setFiles] = useState<{ name: string; rows: StaleRow[] }[] | null>(null);
  useEffect(() => {
    getJSON<{ name: string; rows: StaleRow[] }[]>("/api/stale").then(setFiles).catch(() => setFiles([]));
  }, []);
  if (!files?.length) return null;
  const all = files.flatMap((f) => f.rows);
  const groups = new Map<string, StaleRow[]>();
  for (const r of all) {
    const key = r.mode === "memory" ? "memory" : `tavily ${r.search?.name ?? "?"}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const keys = [...groups.keys()].sort((a, b) => (a === "memory" ? -1 : b === "memory" ? 1 : a.localeCompare(b)));
  const count = (rows: StaleRow[], f: (r: StaleRow) => boolean) => rows.filter(f).length;
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Stale-claim check</h2>
        <span className="muted">{files.length} runs over {new Set(all.map((r) => r.id)).size} labeled claims</span>
      </header>
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Judge</th>
              <th className="r">Claims judged</th>
              <th className="r">Right</th>
              <th className="r">Stale caught</th>
              <th className="r">Stale passed as current</th>
              <th className="r">False alarms</th>
              <th className="r">Unknown</th>
              <th className="r">Tokens per claim</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((key) => {
              const rows = groups.get(key)!;
              const stale = rows.filter((r) => r.truth === "outdated");
              const fresh = rows.filter((r) => r.truth === "current");
              const passed = count(stale, (r) => r.status === "current");
              return (
                <tr key={key}>
                  <td className="mono" title={rows[0].search?.judge ?? "no evidence, the model's own memory"}>{key}</td>
                  <td className="r num">{rows.length}</td>
                  <td className="r num">{fmtPct(count(rows, (r) => r.status === r.truth) / rows.length)}</td>
                  <td className="r num">{count(stale, (r) => r.status === "outdated")} of {stale.length}</td>
                  <td className={`r num ${passed ? "neg" : "pos"}`}>{passed} of {stale.length}</td>
                  <td className="r num">{count(fresh, (r) => r.status === "outdated")} of {fresh.length}</td>
                  <td className="r num">{count(rows, (r) => r.status === "unknown")}</td>
                  <td className="r num">{fmtInt(avgKnown(rows.map((r) => r.tokens)))}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const AGENTS: { mode: string; label: string }[] = [
  { mode: "claude-code", label: "Claude Code" },
  { mode: "codex", label: "Codex" },
  { mode: "naive", label: "Naive baseline" },
  { mode: "thrift", label: "Thrift" },
];

// Average tokens per task for each agent, split into what the provider served
// from its prompt cache and what it processed fresh. Thrift and the baseline
// have no prompt cache, so all of theirs is fresh.
function AgentsPanel({ rows }: { rows: BenchRow[] }) {
  const tasks = new Set(rows.filter((r) => r.mode === "thrift").map((r) => r.task));
  const stats = AGENTS.flatMap(({ mode, label }) => {
    const own = rows.filter((r) => r.mode === mode && tasks.has(r.task) && !r.crashed);
    if (!own.length) return [];
    const byTask = [...tasks].map((task) => own.filter((r) => r.task === task)).filter((list) => list.length);
    const perTask = (f: (r: BenchRow) => number) => avgKnown(byTask.map((list) => avgKnown(list.map(f)))) ?? 0;
    const total = perTask((r) => r.tokens ?? 0);
    const cached = perTask((r) => r.usage?.cached ?? 0);
    const pass = own.filter((r) => r.pass).length;
    return [{ mode, label, total, cached, fresh: total - cached, pass, runs: own.length }];
  });
  if (stats.length < 3) return null;
  const thrift = stats.find((s) => s.mode === "thrift")!;
  const max = Math.max(...stats.map((s) => s.total));
  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Against other agents</h2>
        <span className="muted">avg tokens per task, {tasks.size} tasks</span>
      </header>
      <div className="agents">
        {stats.map((s) => (
          <div key={s.mode} className={s.mode === "thrift" ? "agent-row is-thrift" : "agent-row"}>
            <span className="agent-name">{s.label}</span>
            <div className="agent-track" aria-label={`${s.label}: ${fmtInt(s.total)} tokens, ${fmtInt(s.cached)} from cache`}>
              <span className="agent-fresh" style={{ width: `${(s.fresh / max) * 100}%` }} />
              {s.cached > 0 && <span className="agent-cached" style={{ width: `${(s.cached / max) * 100}%` }} />}
            </div>
            <span className="agent-num">{fmtInt(s.total)}</span>
            <span className="agent-foot muted">
              {s.pass}/{s.runs} passed, {fmtInt(s.fresh)} uncached
              {s.mode !== "thrift" && thrift.fresh > 0 && <> · {(s.fresh / thrift.fresh).toFixed(1)}x Thrift</>}
            </span>
          </div>
        ))}
        <p className="agent-key muted">
          <span><i className="agent-fresh" /> processed fresh</span>
          <span><i className="agent-cached" /> read from the provider's prompt cache</span>
        </p>
      </div>
    </section>
  );
}
