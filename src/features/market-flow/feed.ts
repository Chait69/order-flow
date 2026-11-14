import { useEffect, useRef, useState } from 'react';
import { profileFor, type Segment } from '@/lib/segmentSession';
import type { Underlying } from '@/lib/underlyings';
import { combineMonths, type FuturesMonth, type FuturesSeries } from '../options-scanner/futuresModel';
import { parseMarketFile, type ContractMarket } from '../options-scanner/contractScanModel';

/**
 * The page's data, all from its own server (server/index.mjs), whichever
 * provider feeds it: the market file every minute, and each underlying's
 * futures. Nothing here knows which broker (or the demo) is behind it.
 */

const API = (import.meta.env.VITE_API_BASE || '').replace(/\/$/, '');

export interface FeedStatus {
  provider: { id: string; label: string; alwaysLive: boolean };
  ready: boolean;
  /** The session the server's provider is on: today's, or a recorded day being replayed. (The F&O segment's; `segments` has each one's.) */
  session?: string;
  lastError: { message: string } | null;
  /** Each segment's own session and whether this server's provider supplies it. Absent from an older server: then only F&O is served. */
  segments?: Partial<Record<Segment, {
    enabled: boolean; session?: string; underlyings?: number;
    /** The segment's last good build, and the last time a build failed (cleared by the next good one). */
    market?: { at: number; date: string; series: number } | null; lastError?: { at: number; message: string } | null;
  }>>;
  /** Set here, not by the server: the last status check failed, so this is what was held before it. */
  unreachable?: boolean;
}

const STATUS_EVERY_MS = 60_000;
let statusInFlight: Promise<FeedStatus | null> | null = null;
/**
 * The server's status, asked afresh every time (one request at a time). It was read once per visit and kept: a tab left open across a session change
 * went on asking for yesterday's futures, and never learned the feed had failed or come back.
 */
export function feedStatus(): Promise<FeedStatus | null> {
  statusInFlight ??= fetch(`${API}/api/status`, { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).catch(() => null).finally(() => { statusInFlight = null; });
  return statusInFlight;
}

/** The status, read again every minute and when the tab comes back. A failed read keeps the last good one, marked `unreachable`. */
export function useFeedStatus(): FeedStatus | null {
  const [status, setStatus] = useState<FeedStatus | null>(null);
  useEffect(() => {
    let live = true;
    const read = () => {
      void feedStatus().then(next => {
        if (!live) return;
        setStatus(current => (next ? next : current ? (current.unreachable ? current : { ...current, unreachable: true }) : null));
      });
    };
    read();
    const timer = window.setInterval(() => { if (visible()) read(); }, STATUS_EVERY_MS);
    const onVisible = () => { if (visible()) read(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { live = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return status;
}

/** True while the numbers can move: in the segment's market hours, or always for a provider that is always live (the demo). */
const moving = (status: FeedStatus | null, segment: Segment = 'fno') => Boolean(status?.provider.alwaysLive) || profileFor(segment).isSessionTime(Date.now());

/** The session the server's provider is on for a segment: its own, else (an older server) F&O's, else the segment's latest by the real clock. */
export function sessionOfStatus(status: FeedStatus | null, segment: Segment = 'fno'): string {
  return status?.segments?.[segment]?.session ?? (segment === 'fno' ? status?.session : undefined) ?? profileFor(segment).latestSessionDate(new Date());
}
const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible';

/**
 * When the prices were OBSERVED: the newest chain time the vendor stamped on any series. Not `market.at`, which is when this server built the file:
 * a build at noon of data last traded at midnight must not read as noon.
 */
export function observedAtOf(market: ContractMarket | null): number | null {
  let latest: number | null = null;
  for (const series of market?.series ?? []) if (series.tape != null && (latest === null || series.tape > latest)) latest = series.tape;
  return latest;
}

/** What is wrong with the live data, in a line fit to show, or null. Shown even while older data is on screen. */
export function feedProblem(status: FeedStatus | null, segment: Segment = 'fno'): string | null {
  if (!status) return null;
  if (status.unreachable) return 'The Order Flow server did not answer its last status check';
  return status.segments?.[segment]?.lastError?.message ?? (segment === 'fno' ? status.lastError?.message : null) ?? null;
}

/** The query that picks a segment's board: none for F&O, the original URL. */
const segmentQuery = (segment: Segment) => (segment === 'mcx' ? '?segment=mcx' : '');

export async function fetchMarket(signal?: AbortSignal, segment: Segment = 'fno'): Promise<ContractMarket | null> {
  const res = await fetch(`${API}/api/market${segmentQuery(segment)}`, { cache: 'no-store', signal });
  // 503: still building. 404 for a segment: this provider does not supply it, and the server says so in a line fit to show.
  if (!res.ok) throw new Error(res.status === 503 || (res.status === 404 && segment !== 'fno') ? ((await res.json().catch(() => null))?.error ?? 'The market is still loading.') : `Market ${res.status}`);
  return parseMarketFile(await res.json());
}

export async function fetchMarketMinute(date: string, minute: string, segment: Segment = 'fno'): Promise<ContractMarket | null> {
  const res = await fetch(`${API}/api/market/${date}/${minute}${segmentQuery(segment)}`);
  return res.ok ? parseMarketFile(await res.json()) : null;
}

export async function fetchFutures(symbol: string, session: string): Promise<FuturesSeries | null> {
  const res = await fetch(`${API}/api/futures/${encodeURIComponent(symbol)}?session=${session}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Futures ${symbol}: ${res.status}`);
  const body = await res.json() as { months: FuturesMonth[] };
  return combineMonths(symbol, body.months ?? []);
}

/**
 * The market file of one segment, read again every minute while its numbers can move. Each segment has its own file, session and
 * clock; switching segment drops what was held (a commodity board never inherits the F&O reading, nor the other way round).
 */
export function useMarketFeed(segment: Segment = 'fno') {
  const status = useFeedStatus();
  const [held, setHeld] = useState<{ segment: Segment; market: ContractMarket | null }>({ segment, market: null });
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const statusRef = useRef(status);
  statusRef.current = status;
  const market = held.segment === segment ? held.market : null;
  // A server that has answered /api/status and does not list this segment as supplied (an older server, or a provider without it) is not asked.
  // (An older server has no `segments`: it serves F&O only, so F&O is asked for and MCX is not.)
  const unsupplied = status !== null && (status.segments ? status.segments[segment]?.enabled !== true : segment !== 'fno');

  useEffect(() => {
    if (unsupplied) return undefined;
    const controller = new AbortController();
    setError(null);
    fetchMarket(controller.signal, segment)
      .then(next => {
        if (!next) return;
        setError(null);
        // A file from an earlier session is not today's board; a reading older than the one held is ignored.
        if (next.date < sessionOfStatus(statusRef.current, segment)) return;
        setHeld(current => (current.segment === segment && current.market && next.at <= current.market.at ? current : { segment, market: next }));
      })
      .catch(err => { if (!controller.signal.aborted) setError(String(err?.message ?? err)); });
    return () => controller.abort();
  }, [tick, segment, unsupplied]);

  useEffect(() => {
    // Until the first file arrives, ask every five seconds; then once a minute while the numbers move.
    const timer = window.setInterval(() => {
      if (!visible()) return;
      if (!market || moving(statusRef.current, segment)) setTick(value => value + 1);
    }, market ? 60_000 : 5_000);
    return () => window.clearInterval(timer);
  }, [market, segment]);

  if (unsupplied) return { market: null, loading: false, error: `${status?.provider.label ?? 'This source'} does not supply ${profileFor(segment).label} data.`, status, rescan: () => setTick(value => value + 1) };
  return { market, loading: !market, error, status, rescan: () => setTick(value => value + 1) };
}

const WORKERS = 6;

/** Each underlying's futures: read six at a time, and again every minute or two while the numbers move. */
export function useFuturesFeed(symbols: readonly string[], enabled: boolean, status: FeedStatus | null, segment: Segment = 'fno') {
  const [series, setSeries] = useState<ReadonlyMap<string, FuturesSeries | null>>(new Map());
  const [failed, setFailed] = useState<ReadonlySet<string>>(new Set());
  const [done, setDone] = useState(0);
  const [tick, setTick] = useState(0);
  // The provider's session: today's, or the recorded day it replays.
  const session = sessionOfStatus(status, segment);
  const key = symbols.join(',');
  const statusRef = useRef(status);
  statusRef.current = status;

  // A new session (the status is now read again every minute): what was read for the last one is dropped, not shown as today's.
  const sessionRef = useRef(session);
  useEffect(() => {
    if (sessionRef.current === session) return;
    sessionRef.current = session;
    setSeries(new Map());
    setFailed(new Set());
    setDone(0);
    setTick(0);
  }, [session]);

  useEffect(() => {
    if (!enabled) return undefined;
    const every = statusRef.current?.provider.alwaysLive ? 60_000 : 120_000;
    const timer = window.setInterval(() => { if (visible() && moving(statusRef.current, segment)) setTick(value => value + 1); }, every);
    return () => window.clearInterval(timer);
  }, [enabled, status, segment]);

  useEffect(() => {
    if (!enabled || !symbols.length) return undefined;
    let cancelled = false;
    let cursor = 0;
    // A first pass counts up from nothing; a refresh keeps the count full and swaps the readings in place.
    if (tick === 0) setDone(0);
    const read = async (symbol: string) => {
      let result: FuturesSeries | null = null;
      let ok = true;
      try { result = await fetchFutures(symbol, session); } catch { ok = false; }
      if (cancelled) return;
      if (ok || tick === 0) setSeries(current => new Map(current).set(symbol, result));
      setFailed(current => {
        if (ok ? !current.has(symbol) : current.has(symbol)) return current;
        const next = new Set(current);
        if (ok) next.delete(symbol); else next.add(symbol);
        return next;
      });
      if (tick === 0) setDone(value => value + 1);
    };
    const worker = async () => { while (cursor < symbols.length && !cancelled) await read(symbols[cursor++]); };
    void Promise.all(Array.from({ length: Math.min(WORKERS, symbols.length) }, worker));
    return () => { cancelled = true; };
    // `key` stands for the symbol list.
  }, [key, enabled, session, tick]);

  return { series, failed, read: tick === 0 ? Math.min(done, symbols.length) : symbols.length, total: symbols.length, session };
}

export type { Underlying };
