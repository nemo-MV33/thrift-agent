import { useEffect, useMemo, useState } from "react";
import { BenchFile, BenchRow, Mode, fmtCost, fmtInt, fmtMs, fmtPct, getJSON, shortModel } from "./lib";
import { Empty } from "./Live";

type Agg = { runs: number; pass: number; passRate: number; tokens: number; cost: number | null; ms: number };
const MODES: Mode[] = ["naive", "thrift", "stale"];

function agg(rows: BenchRow[]): Agg | null {
  if (!rows.length) return null;
  const costs = rows.map((r) => r.cost).filter((c): c is number => typeof c === "number");
  const pass = rows.filter((r) => r.pass).length;
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  return {
    runs: rows.length,
    pass,
    passRate: pass / rows.length,
    tokens: avg(rows.map((r) => r.tokens)),
    cost: costs.length ? avg(costs) : null,
    ms: avg(rows.map((r) => r.ms)),
  };
}

function pickDefault(files: BenchFile[]) {
  return [...files].sort((a, b) => b.rows - a.rows || Number(b.hasFreshness) - Number(a.hasFreshness) || b.mtime - a.mtime)[0];
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

  return (
    <div className="bench">
      <div className="bench-bar">
        <div className="bench-title">
          <span className="eyebrow-label">Naive vs thrift</span>
          <h1 className="display">Benchmark</h1>
          <p className="page-sub">
            Small Node repos with failing tests. Naive sends the full history to one model. Thrift routes once per task and keeps context short. Stale runs Thrift with the Tavily check off.
          </p>
        </div>
        <label className="select">
          <span className="sr-only">Results file</span>
          <select value={file ?? ""} onChange={(e) => setFile(e.target.value)} disabled={!files}>
            {files?.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name.replace(/^run-|\.jsonl$/g, "").replace(/T(\d\d)-(\d\d)-(\d\d)-\d+Z/, " $1:$2:$3")} ({f.rows} rows)
              </option>
            ))}
          </select>
        </label>
      </div>
      {!rows ? <div className="skeleton"><div className="sk sk-row" /><div className="sk sk-card" /></div> : rows.length === 0 ? <Empty title="This file is empty" body="Pick another results file." /> : <BenchBody rows={rows} />}
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
  const naive = agg(main.filter((r) => r.mode === "naive" && shared.has(r.task)));
  const thrift = agg(main.filter((r) => r.mode === "thrift" && shared.has(r.task)));
  const tiers = [...new Set(main.map((r) => r.tier))].sort((a, b) => ["simple", "medium", "complex"].indexOf(a) - ["simple", "medium", "complex"].indexOf(b));
  const staleTasks = new Set(rows.filter((r) => r.mode === "stale").map((r) => r.task));
  const fresh = rows.filter((r) => staleTasks.has(r.task));
  const headline = naive && thrift;

  return (
    <>
      {headline && <Headline naive={naive} thrift={thrift} taskCount={shared.size} />}
      {fresh.length > 0 && <FreshSection rows={fresh} />}
      <div className="bench-grid">
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
            <TierTable rows={main.filter((r) => shared.has(r.task))} tiers={tiers.filter((tier) => main.some((r) => r.tier === tier && shared.has(r.task)))} />
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
    vals: modes.map((m) => {
      const xs = rows.filter((r) => r.task === task && r.mode === m).map((r) => r.tokens);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    }),
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
