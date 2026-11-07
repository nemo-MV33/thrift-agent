import { useCallback, useEffect, useRef, useState } from "react";
import { Ev, FeedItem, Gateway, RunSummary, getJSON } from "./lib";
import { LivePage } from "./Live";
import { BenchPage } from "./Bench";

type Page = "live" | "bench";

export type Store = {
  runs: RunSummary[];
  events: Record<string, Ev[]>;
  feed: FeedItem[];
  gatewayOnline: boolean | null;
  serverOnline: boolean;
  loadRun: (id: string) => void;
};

function initialPage(): Page {
  return location.hash === "#bench" ? "bench" : "live";
}

export function App() {
  const [page, setPage] = useState<Page>(initialPage);
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    try {
      return (localStorage.getItem("thrift-theme") as "dark" | "light") || "light";
    } catch {
      return "light";
    }
  });
  const store = useStore();

  useEffect(() => {
    const onHash = () => setPage(initialPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("thrift-theme", theme);
    } catch {
      // storage blocked
    }
  }, [theme]);

  const go = (p: Page) => {
    setPage(p);
    history.replaceState(null, "", p === "bench" ? "#bench" : "#");
  };

  return (
    <div className="shell">
      <header className="topbar">
        <a className="wordmark" href="#" onClick={(e) => { e.preventDefault(); go("live"); }} aria-label="Thrift home">
          thrift
        </a>
        <nav className="segment" role="tablist" aria-label="Pages">
          <button role="tab" aria-selected={page === "live"} onClick={() => go("live")}>
            Live run
          </button>
          <button role="tab" aria-selected={page === "bench"} onClick={() => go("bench")}>
            Benchmark
          </button>
        </nav>
        <div className="topbar-right">
          <Status label="Server" ok={store.serverOnline} />
          <Status label="Gateway" ok={store.gatewayOnline} />
          <div className="segment segment-sm" role="radiogroup" aria-label="Theme">
            <button role="radio" aria-checked={theme === "light"} onClick={() => setTheme("light")}>
              Light
            </button>
            <button role="radio" aria-checked={theme === "dark"} onClick={() => setTheme("dark")}>
              Dark
            </button>
          </div>
        </div>
      </header>
      <main>{page === "live" ? <LivePage store={store} /> : <BenchPage />}</main>
    </div>
  );
}

function Status({ label, ok }: { label: string; ok: boolean | null }) {
  const state = ok == null ? "pending" : ok ? "ok" : "down";
  return (
    <span className={`status ${state}`} title={`${label}: ${state === "ok" ? "online" : state === "down" ? "offline" : "connecting"}`}>
      <span className="status-dot" />
      {label}
      <span className="status-text">{state === "ok" ? "online" : state === "down" ? "offline" : "..."}</span>
    </span>
  );
}

function useStore(): Store {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [events, setEvents] = useState<Record<string, Ev[]>>({});
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [gatewayOnline, setGatewayOnline] = useState<boolean | null>(null);
  const [serverOnline, setServerOnline] = useState(false);
  const loaded = useRef(new Set<string>());

  const refreshRuns = useCallback(() => {
    getJSON<RunSummary[]>("/api/runs")
      .then(setRuns)
      .catch(() => {});
  }, []);

  const loadRun = useCallback((id: string) => {
    if (loaded.current.has(id)) return;
    loaded.current.add(id);
    getJSON<{ events: Ev[] }>(`/api/runs/${encodeURIComponent(id)}`)
      .then((r) => setEvents((prev) => ({ ...prev, [id]: r.events })))
      .catch(() => loaded.current.delete(id));
  }, []);

  useEffect(() => {
    refreshRuns();
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      es = new EventSource("/api/stream");
      es.onopen = () => {
        setServerOnline(true);
        refreshRuns();
      };
      es.onerror = () => {
        setServerOnline(false);
        setGatewayOnline(null);
        es?.close();
        retry = setTimeout(connect, 2500);
      };
      es.addEventListener("gateway", (m) => setGatewayOnline(JSON.parse((m as MessageEvent).data).online));
      es.addEventListener("feed", (m) => setFeed(JSON.parse((m as MessageEvent).data)));
      es.addEventListener("event", (m) => {
        const ev = JSON.parse((m as MessageEvent).data) as Ev;
        loaded.current.add(ev.runId);
        setEvents((prev) => ({ ...prev, [ev.runId]: [...(prev[ev.runId] ?? []), ev] }));
        if (ev.type === "run_start" || ev.type === "run_end" || ev.type === "error") refreshRuns();
        else
          setRuns((prev) =>
            prev.some((r) => r.runId === ev.runId)
              ? prev.map((r) => (r.runId === ev.runId ? { ...r, updatedAt: ev.at } : r))
              : prev,
          );
      });
      es.addEventListener("enrich", (m) => {
        const { runId, requestId, gateway, missing } = JSON.parse((m as MessageEvent).data) as {
          runId: string;
          requestId: string;
          gateway?: Gateway;
          missing?: string;
        };
        setEvents((prev) => {
          const list = prev[runId];
          if (!list) return prev;
          return {
            ...prev,
            [runId]: list.map((e) =>
              e.type === "step" && e.requestId === requestId ? (gateway ? { ...e, gateway, gatewayMissing: undefined } : { ...e, gatewayMissing: missing }) : e,
            ),
          };
        });
      });
    };
    connect();
    return () => {
      clearTimeout(retry);
      es?.close();
    };
  }, [refreshRuns]);

  return { runs, events, feed, gatewayOnline, serverOnline, loadRun };
}
