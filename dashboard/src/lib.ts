import { useEffect, useState } from "react";

export type Mode = "thrift" | "naive" | "private" | "stale" | "claude-code" | "codex";

export type Gateway = {
  cost: number | null;
  complexityTier: string | null;
  routingRule: string | null;
  fallbackIndex: number;
  retries: number;
  latency: number | null;
  virtualKey: string | null;
  status: string | null;
};

export type Ev = {
  runId: string;
  type: string;
  mode?: Mode;
  at: number;
  gateway?: Gateway;
  [k: string]: unknown;
};

export type RunSummary = {
  runId: string;
  task: string | null;
  mode: Mode | null;
  startedAt: number;
  updatedAt: number;
  ended: boolean;
  error: boolean;
  stopped: boolean;
  tokens: number | null;
};

export type FeedItem = {
  id: string;
  at: string;
  provider: string;
  model: string;
  key: string | null;
  status: string;
  latency: number | null;
  cost: number | null;
  tokens: number | null;
  tier: string | null;
  rule: string | null;
  fallbackIndex: number;
};

export type BenchRow = {
  task: string;
  tier: string;
  mode: Mode;
  run: number;
  pass: boolean;
  tokens: number | null;
  steps: number | null;
  ms: number | null;
  cost?: number | null;
  models?: string[];
  fallbacks?: number;
  cacheHits?: number;
  crashed?: boolean;
  error?: string | null;
  freshness?: unknown;
  // Other agents report their own usage; cached is what came from the prompt cache.
  usage?: { input: number; cached: number; cacheWrite?: number; output: number };
};

export type BenchFile = {
  name: string;
  label?: string;
  rows: number;
  mtime: number;
  hasSummary: boolean;
  hasFreshness: boolean;
  hasCost: boolean;
};

const intFmt = new Intl.NumberFormat("en-US");
export const fmtInt = (n: number | null | undefined) => (n == null || !Number.isFinite(n) ? "-" : intFmt.format(Math.round(n)));

export function fmtCost(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n)) return "-";
  if (n === 0) return "$0";
  if (n < 0.01) return "$" + n.toFixed(5);
  return "$" + n.toFixed(3);
}

export function fmtMs(ms: number | null | undefined) {
  if (ms == null || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
}

export function fmtPct(n: number | null | undefined, digits = 0) {
  if (n == null || !Number.isFinite(n)) return "-";
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtAgo(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(at).toLocaleDateString();
}

export function useNow(interval = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(id);
  }, [interval]);
  return now;
}

export async function getJSON<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json() as Promise<T>;
}

export function shortModel(m: string) {
  return m.replace(/^openai\//, "");
}
