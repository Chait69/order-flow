import { useEffect, useMemo, useState } from 'react';

/**
 * Tracker: the strongest build-ups, scored and judged by the live feed service the way the India F&O app does it (see
 * research/flow_feed/flow_tracker.py in the Trading Terminal repo). The page only shows what the service answers at /api/tracker.
 *
 * One switch (Stocks / Commodities) and three tabs:
 *   Live picks      the top 5 bullish and top 5 bearish right now, each with its plan drawn as a price ladder
 *   My trades       every trade the service logged (first time a name entered the top 5 inside the entry window): entry, CMP, status, P/L
 *   Next-day focus  names whose build-up held into the close, with tomorrow's breakout trigger
 * "Bullish" is long build-up and short covering; "bearish" is short build-up and long unwinding, as in the India app.
 */
interface Levels { stop: number; t1: number; t2: number; t3: number }
type Ladder = { tight: Levels; us: Levels };
interface Pick {
  symbol: string; kind: string; score: number; recommended: boolean; buildup: string; chgPct: number; oiChgPct: number; ltp: number; cmp: number | null;
  atr: number | null; levels: Ladder | null; reasons: string[]; tracked: boolean;
}
type OutcomeName = 'pending' | 'target_hit' | 'stop_hit' | 'squared_off' | 'no_data';
interface Outcome { outcome: OutcomeName; time: number | null; exit_price: number | null; level: number; stop_after: number | null; following?: boolean; pct?: number; r?: number | null; pts?: number }
interface TradeTags {
  cost_ok?: boolean | null;
  quote_ok?: boolean | null;
  orb_agree?: boolean | null;
  ohlc_basis?: boolean | null;
  [key: string]: any;
}
interface Trade {
  id: number; day: string; symbol: string; kind: string; side: 'long' | 'short'; score: number; entryAt: number; entry: number; cmp: number | null; atr: number;
  buildUp: string; reasons: string[]; levels: { main: Ladder }; result: Record<string, Outcome>; closed: boolean;
  tags?: TradeTags | null;
}
interface FocusResult { outcome?: string; evalDay?: string; triggeredAt?: number; entry?: number; gap?: boolean; tight?: Outcome & { levels: Levels }; us?: Outcome }
interface FocusItem {
  id: number; day: string; seg: 'fno' | 'mcx'; symbol: string; kind: string; side: 'long' | 'short'; score: number; buildUp: string; chgPct: number; oiChgPct: number;
  close: number; high: number; low: number; pos: number; atr: number; trigger: number; levels: Ladder; result: FocusResult; closed: boolean;
}
interface ShadowSetupItem {
  symbol: string; orHigh: number; orLow: number; orSpan: number; atr: number; barsCount: number;
  qualified: boolean; disqualificationReason: string | null; costGatePassed: boolean; costInR: number; costToT1: number;
}
interface ShadowTradeItem {
  id: number; symbol: string; side: 'long' | 'short'; triggerAt: number; entryAt: number;
  entryPrice: number; stopPrice: number; t1Price: number; t2Price: number; costInR: number;
  outcome: OutcomeName; exitPrice: number | null; exitAt: number | null; levelReached: number;
  grossR: number | null; netR: number | null; settled: boolean;
  tags?: TradeTags | null;
}
interface ShadowOrbData {
  version: string; status: string; rules: { orInterval: string; entries: string; squareOff: string };
  setups: ShadowSetupItem[]; trades: ShadowTradeItem[];
}
interface TrackerData {
  focus?: { latest: FocusItem[]; history: FocusItem[]; day: string | null };
  shadowOrb?: ShadowOrbData;
  asof: number | null; pricedAt?: number; cadence?: { rankEveryMin: number; confirmReads: number; cooldownMin: number };
  lists: Record<string, Pick[]>; trades: Trade[]; minScore: number; recommendedScore: number;
  rules: Record<string, { entries: string; squareOff: string }>; note: string; error?: string;
  /** Set by the server when the live feed service did not answer: this is the last good answer, as it was at `cachedAt`. */
  stale?: { cachedAt: number; reason: string };
}
type Seg = 'fno' | 'mcx';
type Tab = 'live' | 'trades' | 'focus' | 'shadow';

const price = (v: number | null | undefined) => (v == null ? '—' : v.toLocaleString('en-IN', { maximumFractionDigits: v >= 1000 ? 1 : 2 }));
const sgn = (v: number) => (v > 0 ? '+' : v < 0 ? '−' : '');
const pct = (v: number, d = 2) => `${sgn(v)}${Math.abs(v).toFixed(d)}%`;
const pts = (v: number | null) => (v == null ? '—' : `${sgn(v)}${Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
const timeFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const dateFmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: '2-digit', month: 'short' });
const t = (ms: number | null | undefined) => (ms ? timeFmt.format(ms) : '—');
const tone = (v: number | null) => (v == null || v === 0 ? '' : v > 0 ? 'is-up' : 'is-down');
/** Points gained (+) or lost (−) from entry to a price, in the trade's own direction. */
const points = (side: 'long' | 'short', entry: number, at: number | null | undefined) => (at == null ? null : (at - entry) * (side === 'long' ? 1 : -1));
const STATUS: Record<OutcomeName, string> = { pending: 'Open', target_hit: 'Target hit', stop_hit: 'Stop hit', squared_off: 'Squared off', no_data: 'No price data' };
const CHIP: Record<OutcomeName, string> = { pending: 'is-open', target_hit: 'is-target', stop_hit: 'is-stop', squared_off: 'is-flat', no_data: 'is-flat' };
type Verdict = 'open' | 'win' | 'loss' | 'flat';
/** Did a trade make money? By its R (else the exit's % or points): a target hit is a win, a stop hit a loss, and a trade squared off at the close is a
 *  win or a loss by where it was closed. Open trades are neither. */
/** A trade with a result: decided, or squared off. A trade with no price data has no result (and none is made up), so it is not one of these. */
const settled = (o: Outcome | undefined) => !!o && o.outcome !== 'pending' && o.outcome !== 'no_data';
const verdictOf = (o: Outcome | undefined): Verdict => {
  if (!o || o.outcome === 'pending' || o.outcome === 'no_data') return 'open';
  const v = o.r ?? o.pct ?? o.pts ?? null;
  return v == null || v === 0 ? 'flat' : v > 0 ? 'win' : 'loss';
};
/** The status chip: a trade squared off at the close says whether it was closed in profit or in loss. */
const statusLabel = (o: Outcome | undefined): { text: string; kind: string } => {
  const out: OutcomeName = o?.outcome ?? 'pending';
  if (out === 'squared_off') {
    const v = verdictOf(o);
    if (v === 'win') return { text: 'Squared off · profit', kind: 'is-sqwin' };
    if (v === 'loss') return { text: 'Squared off · loss', kind: 'is-sqloss' };
    return { text: 'Squared off · flat', kind: 'is-flat' };
  }
  return { text: STATUS[out], kind: CHIP[out] };
};
const segOfKind = (kind: string): Seg => (kind === 'commodity' ? 'mcx' : 'fno');

const remembered = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
  try { const v = localStorage.getItem(key); return allowed.includes(v as T) ? (v as T) : fallback; } catch { return fallback; }
};
const remember = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* a private window keeps it for this visit */ } };

function useTracker(): { data: TrackerData | null; error: string | null } {
  const [data, setData] = useState<TrackerData | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/tracker', { cache: 'no-store' });
        const body = await res.json();
        if (!alive) return;
        if (!res.ok || body.error) setError(body.error ?? `HTTP ${res.status}`); else { setData(body); setError(null); }
      } catch (e) { if (alive) setError(String(e)); }
    };
    void load();
    const timer = window.setInterval(load, 20_000);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);
  return { data, error };
}

/** Where each label sits: under its own tick, nudged apart so two never overlap (ticks can be close when the price has run far). */
function labelSpots(xs: number[], gap = 17, lo = 8, hi = 92): number[] {
  const order = xs.map((x, i) => i).sort((a, b) => xs[a] - xs[b]);
  const out = [...xs];
  let prev = lo - gap;
  for (const i of order) { out[i] = Math.max(Math.min(xs[i], hi), prev + gap, lo); prev = out[i]; }
  let next = hi + gap;
  for (const i of [...order].reverse()) { out[i] = Math.min(out[i], next - gap, hi); next = out[i]; }
  return out;
}

/** The plan as a picture: red from entry back to the stop, green from entry out to the last target, ticks at T1 to T3, a dot where the price is now. */
function PriceLadder({ side, entry, lv, cmp, exit, reached = 0 }: { side: 'long' | 'short'; entry: number; lv: Levels; cmp?: number | null; exit?: number | null; reached?: number }) {
  const marks = [lv.stop, lv.t1, lv.t2, lv.t3, entry, ...(cmp != null ? [cmp] : []), ...(exit != null ? [exit] : [])];
  const lo = Math.min(...marks);
  const hi = Math.max(...marks);
  const span = hi - lo || 1;
  const x = (v: number) => 3 + ((v - lo) / span) * 94;
  const band = (a: number, b: number) => ({ left: `${x(Math.min(a, b))}%`, width: `${Math.abs(x(a) - x(b))}%` });
  return (
    <div className="mf-tlad" role="img" aria-label={`${side} plan: stop ${price(lv.stop)}, entry ${price(entry)}, targets ${price(lv.t1)}, ${price(lv.t2)}, ${price(lv.t3)}`}>
      <div className="mf-tlad__track">
        <i className="mf-tlad__risk" style={band(lv.stop, entry)} />
        <i className="mf-tlad__gain" style={band(entry, lv.t3)} />
        <i className="mf-tlad__tick is-stop" style={{ left: `${x(lv.stop)}%` }} title={`Stop ${price(lv.stop)}`} />
        <i className="mf-tlad__tick is-entry" style={{ left: `${x(entry)}%` }} title={`Entry ${price(entry)}`} />
        {[lv.t1, lv.t2, lv.t3].map((v, i) => <i key={i} className={`mf-tlad__tick is-target${i < reached ? ' is-hit' : ''}`} style={{ left: `${x(v)}%` }} title={`T${i + 1} ${price(v)}`} />)}
        {exit != null ? <i className="mf-tlad__exit" style={{ left: `${x(exit)}%` }} title={`Exit ${price(exit)}`} /> : null}
        {cmp != null ? <i className="mf-tlad__cmp" style={{ left: `${x(cmp)}%` }} title={`Now ${price(cmp)}`} /> : null}
      </div>
      <p className="mf-tlad__legend">
        {/* each label sits under its own tick (entry included), so a label can be read against the line above it */}
        {(() => {
          const items = [{ n: 'Stop', v: lv.stop, c: 'is-down', i: -1 }, { n: 'T1', v: lv.t1, c: 'is-up', i: 0 }, { n: 'T2', v: lv.t2, c: 'is-up', i: 1 }, { n: 'T3', v: lv.t3, c: 'is-up', i: 2 },
            { n: 'Entry', v: entry, c: 'is-entry', i: -1 }];
          const spots = labelSpots(items.map(m => x(m.v)));
          return items.map((m, k) => (
            <span key={m.n} className={`${m.c}${m.i >= 0 && m.i < reached ? ' is-hit' : ''}`} style={{ left: `${spots[k]}%` }}>
              <b>{m.n}{m.i >= 0 && m.i < reached ? ' ✓' : ''}</b><i>{price(m.v)}</i>
            </span>
          ));
        })()}
      </p>
    </div>
  );
}

function Chip({ kind, children }: { kind: string; children: React.ReactNode }) {
  return <span className={`mf-tchip ${kind}`}>{children}</span>;
}

function ScoreBadge({ score, strong }: { score: number; strong: boolean }) {
  return <span className={`mf-tscore${strong ? ' is-strong' : ''}`} title={strong ? 'Recommended (score at or above the threshold)' : 'Watch only (below the recommendation threshold)'}>{score}</span>;
}

function TagBadge({ label, isUnknown }: { label: string; isUnknown?: boolean }) {
  return (
    <span
      className="mf-tag-badge"
      style={{
        display: 'inline-block',
        fontSize: '10px',
        lineHeight: 1.2,
        padding: '1px 5px',
        borderRadius: '3px',
        border: '1px solid #71717a',
        color: isUnknown ? '#a1a1aa' : '#e4e4e7',
        backgroundColor: 'transparent',
        whiteSpace: 'nowrap',
        fontWeight: 400,
      }}
    >
      {label}
    </span>
  );
}

function TradeTagsBadges({ tags }: { tags?: TradeTags | null }) {
  const costLabel = tags?.cost_ok === true ? 'cost ok' : tags?.cost_ok === false ? 'cost high' : 'n/a';
  const quoteLabel = tags?.quote_ok === true ? 'quote ok' : tags?.quote_ok === false ? 'quote weak' : 'n/a';
  const orbLabel = tags?.orb_agree === true ? 'ORB agrees' : tags?.orb_agree === false ? 'no ORB' : 'n/a';
  const ohlcLabel = tags?.ohlc_basis === true ? 'ohlc' : tags?.ohlc_basis === false ? 'close-only' : 'n/a';

  return (
    <span style={{ display: 'inline-flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap', margin: '2px 0' }}>
      <TagBadge label={costLabel} isUnknown={tags?.cost_ok == null} />
      <TagBadge label={quoteLabel} isUnknown={tags?.quote_ok == null} />
      <TagBadge label={orbLabel} isUnknown={tags?.orb_agree == null} />
      <TagBadge label={ohlcLabel} isUnknown={tags?.ohlc_basis == null} />
    </span>
  );
}

function PickCard({ c, side, strongFrom }: { c: Pick; side: 'long' | 'short'; strongFrom: number }) {
  return (
    <li className="mf-tcard">
      <div className="mf-tcard__top">
        <ScoreBadge score={c.score} strong={c.score >= strongFrom} />
        <div className="mf-tcard__name"><b>{c.symbol}</b><span>{c.buildup}</span></div>
        {c.tracked ? <Chip kind="is-open">tracked</Chip> : null}
        <div className="mf-tcard__nums">
          <span className={`mf-num ${tone(c.chgPct)}`}>{pct(c.chgPct)}</span>
          <small>OI {pct(c.oiChgPct, 1)}</small>
        </div>
      </div>
      {c.levels ? <PriceLadder side={side} entry={c.ltp} lv={c.levels.tight} cmp={c.cmp ?? c.ltp} /> : <p className="mf-tcard__muted">No ATR yet, so no levels.</p>}
      <p className="mf-tcard__foot"><span>CMP <b>{price(c.cmp ?? c.ltp)}</b></span><span>Scored at {price(c.ltp)}</span>{c.atr ? <span>ATR {(c.atr / c.ltp * 100).toFixed(1)}%</span> : null}</p>
    </li>
  );
}

function Column({ title, tint, children, count }: { title: string; tint: 'up' | 'down'; children: React.ReactNode; count: number }) {
  return (
    <section className={`mf-tcol is-${tint}`}>
      <h3>{title}<small>{count}</small></h3>
      {count === 0 ? <p className="mf-tempty">Nothing qualifies right now.</p> : <ul className="mf-tcards">{children}</ul>}
    </section>
  );
}

function LivePicks({ data, seg }: { data: TrackerData; seg: Seg }) {
  const long = data.lists[`${seg}:long`] ?? [];
  const short = data.lists[`${seg}:short`] ?? [];
  return (
    <div className="mf-ttwo">
      <Column title="Bullish" tint="up" count={long.length}>{long.map(c => <PickCard key={c.symbol} c={c} side="long" strongFrom={data.recommendedScore} />)}</Column>
      <Column title="Bearish" tint="down" count={short.length}>{short.map(c => <PickCard key={c.symbol} c={c} side="short" strongFrom={data.recommendedScore} />)}</Column>
    </div>
  );
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function Scorecard({ trades }: { trades: Trade[] }) {
  const s = useMemo(() => {
    const done = trades.filter(x => settled(x.result.tight));
    const noData = trades.filter(x => x.result.tight?.outcome === 'no_data').length;
    const count = (o: OutcomeName) => done.filter(x => x.result.tight.outcome === o).length;
    const sqBy = (v: Verdict) => done.filter(x => x.result.tight.outcome === 'squared_off' && verdictOf(x.result.tight) === v).length;
    const wins = done.filter(x => verdictOf(x.result.tight) === 'win').length;
    const losses = done.filter(x => verdictOf(x.result.tight) === 'loss').length;
    const rs = (key: string) => done.map(x => x.result[key]?.r).filter((v): v is number => typeof v === 'number');
    const total = rs('tight').reduce((a, b) => a + b, 0);
    return {
      open: trades.filter(x => (x.result.tight?.outcome ?? 'pending') === 'pending').length, noData, target: count('target_hit'), stop: count('stop_hit'), all: trades.length,
      sqWin: sqBy('win'), sqLoss: sqBy('loss'), sqFlat: sqBy('flat'), wins, losses, closed: done.length,
      winRate: done.length ? (wins / done.length) * 100 : null, avg: mean(rs('tight')), opp: mean(rs('opp_tight')), total: done.length ? total : null,
    };
  }, [trades]);
  const fmt = (v: number | null, d = 2) => (v == null ? '—' : `${sgn(v)}${Math.abs(v).toFixed(d)}`);
  const tiles: Array<{ label: string; value: string; tone?: string; hint: string; sub?: string }> = [
    { label: 'Tracked', value: String(s.all), hint: 'Trades logged', sub: s.noData ? `${s.noData} with no price data, not counted` : undefined },
    { label: 'Open', value: String(s.open), hint: 'Still running' },
    { label: 'Target hit', value: String(s.target), tone: 'is-up', hint: 'Target 1 reached before the stop' },
    { label: 'Stop hit', value: String(s.stop), tone: 'is-down', hint: 'Stop reached first' },
    { label: 'Squared off in profit', value: String(s.sqWin), tone: 'is-up', hint: 'Neither level was reached; closed at the square-off time above the entry (below it for a short)' },
    { label: 'Squared off in loss', value: String(s.sqLoss), tone: 'is-down', hint: `Neither level was reached; closed at the square-off time on the wrong side of the entry${s.sqFlat ? ` (${s.sqFlat} more closed flat)` : ''}` },
    { label: 'Win rate', value: s.winRate == null ? '—' : `${s.winRate.toFixed(0)}%`, sub: s.closed ? `${s.wins} won · ${s.losses} lost · ${s.closed} closed` : undefined,
      hint: 'Closed trades that made money (a target hit, or squared off in profit) out of ALL closed trades. A trade squared off at a loss counts against it.' },
    { label: 'Total R', value: fmt(s.total), tone: tone(s.total), hint: 'Sum of R on closed trades. HYPOTHETICAL: no costs, no slippage. (Points are not added: each name has its own price scale)' },
    { label: 'Average R', value: fmt(s.avg), tone: tone(s.avg), hint: 'R per closed trade' },
    { label: 'Opposite R', value: fmt(s.opp), tone: tone(s.opp), hint: 'The same entries traded the other way: the picks should beat this' },
  ];
  return (
    <ul className="mf-ttiles">
      {tiles.map(x => (
        <li key={x.label} title={x.hint}><small>{x.label}</small><b className={x.tone}>{x.value}</b>{x.sub ? <small>{x.sub}</small> : null}</li>
      ))}
    </ul>
  );
}

function TradeRow({ x, open, onToggle }: { x: Trade; open: boolean; onToggle: () => void }) {
  const r = x.result.tight;
  const out: OutcomeName = r?.outcome ?? 'pending';
  const done = out !== 'pending' && out !== 'no_data';           // no_data: no exit was seen, so there is no exit price, P&L or R to show
  const lv = x.levels.main.tight;
  const pl = done ? (r.pts ?? points(x.side, x.entry, r.exit_price)) : points(x.side, x.entry, x.cmp);
  const wide = x.result.us;
  // booked at target 1 but the price may still be running: keep showing where it is and how far it got
  const following = done && !!r?.following;
  const reached = out === 'target_hit' ? r.level : 0;
  return (
    <li className={`mf-ttrade${open ? ' is-open' : ''}`}>
      <button type="button" className="mf-ttrade__main" onClick={onToggle} aria-expanded={open}>
        <span className="mf-ttrade__who">
          <b>{x.symbol}</b>
          <Chip kind={x.side === 'long' ? 'is-long' : 'is-short'}>{x.side}</Chip>
          <small>{t(x.entryAt)} · score {x.score}</small>
          <TradeTagsBadges tags={x.tags} />
        </span>
        <span className="mf-ttrade__px">
          <small>Entry</small><b>{price(x.entry)}</b>
        </span>
        <span className="mf-ttrade__px">
          <small>{done ? 'Exit' : 'CMP'}</small><b>{price(done ? r.exit_price : x.cmp)}</b>
          {following ? <small>CMP {price(x.cmp)}</small> : null}
        </span>
        <span className="mf-ttrade__ladder"><PriceLadder side={x.side} entry={x.entry} lv={lv} cmp={!done || following ? x.cmp : null} exit={done ? r.exit_price : null} reached={reached} /></span>
        <span className="mf-ttrade__status">
          <Chip kind={statusLabel(r).kind}>{statusLabel(r).text}</Chip>
          <small>{done ? `at ${t(r.time)}${out === 'target_hit' && r.level > 1 ? ` · reached T${r.level}` : ''}${following ? ' · still tracking' : out === 'target_hit' && r.stop_after ? ` · back to the stop at ${t(r.stop_after)}` : ''}` : 'running'}</small>
        </span>
        <span className={`mf-ttrade__pl ${tone(pl)}`}>
          <b>{pts(pl)}</b><small>{done ? `pts · ${r.r != null ? `${sgn(r.r)}${Math.abs(r.r).toFixed(2)}R` : ''}` : 'pts, running'}</small>
        </span>
      </button>
      {open ? (
        <div className="mf-ttrade__more">
          <dl>
            <div><dt>Build-up</dt><dd>{x.buildUp}</dd></div>
            <div><dt>Stop</dt><dd>{price(lv.stop)}</dd></div>
            <div><dt>Targets</dt><dd>{price(lv.t1)} · {price(lv.t2)} · {price(lv.t3)}</dd></div>
            <div><dt>Opposite trade</dt><dd>{x.result.opp_tight?.r != null ? `${sgn(x.result.opp_tight.r)}${Math.abs(x.result.opp_tight.r).toFixed(2)}R` : '—'}</dd></div>
            <div><dt>Wider ladder</dt><dd>{wide && wide.outcome !== 'pending' ? `${statusLabel(wide).text}${wide.r != null ? ` · ${sgn(wide.r)}${Math.abs(wide.r).toFixed(2)}R` : ''}` : 'Open'}</dd></div>
            <div><dt>Tags</dt><dd><TradeTagsBadges tags={x.tags} /></dd></div>
            {out === 'target_hit' && r.stop_after ? <div><dt>After target</dt><dd>stopped {t(r.stop_after)}</dd></div> : null}
          </dl>
          {x.reasons.length > 1 ? <ul className="mf-ttrade__why">{x.reasons.slice(1).map(w => <li key={w}>{w}</li>)}</ul> : null}
        </div>
      ) : null}
    </li>
  );
}

type StatusFilter = 'all' | 'open' | 'closed';
type SideFilter = 'all' | 'long' | 'short';

function Pills<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: string }>; label: string }) {
  return (
    <div className="mf-tpills" role="group" aria-label={label}>
      {options.map(o => <button key={o.value} type="button" className={o.value === value ? 'is-on' : ''} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>{o.label}</button>)}
    </div>
  );
}

function MyTrades({ trades }: { trades: Trade[] }) {
  const [status, setStatus] = useState<StatusFilter>('all');
  const [side, setSide] = useState<SideFilter>('all');
  const [openId, setOpenId] = useState<number | null>(null);
  const shown = trades.filter(x => {
    const isOpen = (x.result.tight?.outcome ?? 'pending') === 'pending';
    return (status === 'all' || (status === 'open') === isOpen) && (side === 'all' || x.side === side);
  });
  const days = useMemo(() => {
    const groups = new Map<string, Trade[]>();
    for (const x of shown) {
      const key = dateFmt.format(x.entryAt);
      groups.set(key, [...(groups.get(key) ?? []), x]);
    }
    return [...groups.entries()];
  }, [shown]);
  return (
    <>
      <Scorecard trades={trades} />
      <div className="mf-tfilters">
        <Pills label="Status" value={status} onChange={setStatus} options={[{ value: 'all', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'closed', label: 'Closed' }]} />
        <Pills label="Side" value={side} onChange={setSide} options={[{ value: 'all', label: 'Long + short' }, { value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }]} />
        <small>{shown.length} of {trades.length}</small>
      </div>
      <p className="mf-thint" style={{ margin: '8px 0 16px 0', fontSize: '12px' }}>
        Tags are recorded for research. They are not validated and do not change which trades are taken.
      </p>
      {days.length === 0 ? <p className="mf-tempty">No trades match. A pick is logged the first time it enters the top 5 with a high enough score, inside the entry window.</p> : null}
      {days.map(([day, list]) => {
        const closed = list.filter(x => settled(x.result.tight));
        const sum = closed.reduce((a, x) => a + (x.result.tight.r ?? 0), 0);
        const won = closed.filter(x => verdictOf(x.result.tight) === 'win').length;
        const lost = closed.filter(x => verdictOf(x.result.tight) === 'loss').length;
        return (
          <section key={day} className="mf-tday">
            <h3>{day}<small>{list.length} trade{list.length === 1 ? '' : 's'}{closed.length ? ` · ${won} won, ${lost} lost · ${sgn(sum)}${Math.abs(sum).toFixed(2)}R closed` : ''}</small></h3>
            <ul className="mf-trades">
              {list.map(x => <TradeRow key={x.id} x={x} open={openId === x.id} onToggle={() => setOpenId(openId === x.id ? null : x.id)} />)}
            </ul>
          </section>
        );
      })}
    </>
  );
}

function focusStatus(f: FocusItem): { text: string; kind: string; sub?: string } {
  const r = f.result;
  if (!r.outcome && !r.tight) return { text: 'Waiting', kind: 'is-open', sub: 'for the next session' };
  if (r.outcome === 'waiting') return { text: 'Waiting', kind: 'is-open', sub: 'not triggered yet' };
  if (r.outcome === 'not_triggered') return { text: 'Not triggered', kind: 'is-flat' };
  if (r.outcome === 'not_evaluated') return { text: 'No session seen', kind: 'is-flat' };
  const o = r.tight;
  if (!o) return { text: 'Waiting', kind: 'is-open' };
  return { text: statusLabel(o).text, kind: statusLabel(o).kind, sub: `triggered ${t(r.triggeredAt)}${r.gap ? ' (gap)' : ''}${o.r != null ? ` · ${sgn(o.r)}${Math.abs(o.r).toFixed(2)}R` : ''}` };
}

function FocusCard({ f }: { f: FocusItem }) {
  const st = focusStatus(f);
  const long = f.side === 'long';
  return (
    <li className="mf-tcard">
      <div className="mf-tcard__top">
        <ScoreBadge score={f.score} strong={false} />
        <div className="mf-tcard__name"><b>{f.symbol}</b><span>{f.buildUp}</span></div>
        <Chip kind={st.kind}>{st.text}</Chip>
        <div className="mf-tcard__nums">
          <span className={`mf-num ${tone(f.chgPct)}`}>{pct(f.chgPct)}</span>
          <small>OI {pct(f.oiChgPct, 1)}</small>
        </div>
      </div>
      <p className="mf-ttrigger">{long ? 'Buy on a close above' : 'Sell on a close below'} <b>{price(f.trigger)}</b><small>closed {Math.round(f.pos * 100)}% up its range at {price(f.close)}</small></p>
      <PriceLadder side={f.side} entry={f.trigger} lv={f.levels.tight} />
      {st.sub ? <p className="mf-tcard__foot"><span>{st.sub}</span></p> : null}
    </li>
  );
}

function Focus({ data, seg }: { data: TrackerData; seg: Seg }) {
  const focus = data.focus;
  if (!focus || !focus.day) {
    return <p className="mf-tempty">The list is drawn once after each close (stocks 15:31, commodities a minute after their close) from the day&apos;s final quotes. Nothing drawn yet.</p>;
  }
  const pick = (side: string) => focus.latest.filter(f => f.seg === seg && f.side === side);
  const earlier = focus.history.filter(f => f.seg === seg);
  return (
    <>
      <p className="mf-thint">Drawn after the close of <b>{focus.day}</b>. Names whose build-up held into the close (a long closing in the top 40% of the day&apos;s range, a short in the bottom 40%), not in the last 2 days before expiry. The plan is a breakout: enter only on a 1-minute close beyond the trigger inside the next session&apos;s entry window; a gap beyond it enters at the first close. A watchlist, not an order.</p>
      <div className="mf-ttwo">
        <Column title="Bullish" tint="up" count={pick('long').length}>{pick('long').map(f => <FocusCard key={f.id} f={f} />)}</Column>
        <Column title="Bearish" tint="down" count={pick('short').length}>{pick('short').map(f => <FocusCard key={f.id} f={f} />)}</Column>
      </div>
      {earlier.length ? (
        <section className="mf-tday">
          <h3>Earlier lists<small>{earlier.length} names</small></h3>
          <ul className="mf-trades">
            {earlier.map(f => {
              const st = focusStatus(f);
              return (
                <li key={f.id} className="mf-ttrade"><div className="mf-ttrade__main is-plain">
                  <span className="mf-ttrade__who"><b>{f.symbol}</b><Chip kind={f.side === 'long' ? 'is-long' : 'is-short'}>{f.side}</Chip><small>drawn {f.day}</small></span>
                  <span className="mf-ttrade__px"><small>Trigger</small><b>{price(f.trigger)}</b></span>
                  <span className="mf-ttrade__status"><Chip kind={st.kind}>{st.text}</Chip><small>{st.sub ?? ''}</small></span>
                </div></li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function ShadowView({ data }: { data: TrackerData }) {
  const orb = data.shadowOrb;
  const isFresh = Boolean(data.pricedAt && Date.now() - data.pricedAt < 180_000);
  const setups = orb?.setups ?? [];
  const trades = orb?.trades ?? [];

  return (
    <div className="mf-tshadow">
      <div className="mf-tbar-badges" style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '12px' }}>
        <Chip kind="is-flat">experimental / not validated</Chip>
        <Chip kind={data.stale ? 'is-flat' : 'is-target'}>{data.stale ? 'cached' : 'current'}</Chip>
        <Chip kind={isFresh ? 'is-target' : 'is-flat'}>{isFresh ? 'fresh' : 'incomplete / stale'}</Chip>
        <Chip kind="is-open">Setup: {orb?.version ?? 'ORB_FUT_V1'}</Chip>
        <Chip kind="is-flat">Universe: NSE Stock Futures</Chip>
      </div>

      <p className="mf-thint">
        <b>Frozen Setup Protocol (ORB_FUT_V1)</b>: Opening Range 09:15–09:30 IST (minimum 12 completed 1m bars), breakout entries 09:30–13:30, square-off 15:15 IST.
        Observation only in shadow mode. Minimum evaluation sample: &ge;200 shadow trades over &ge;30 trading sessions with &le;20% no_data rate.
        Recommendation scores reflect algorithmic ranking components, <i>not statistical win probabilities</i>.
      </p>

      <section className="mf-tsection" style={{ marginBottom: '20px' }}>
        <h3>Today&apos;s Setups &amp; Qualification <small>{setups.length} stocks</small></h3>
        {setups.length === 0 ? (
          <p className="mf-tempty">Opening range establishes at 09:30 IST on trading days. No setups evaluated yet.</p>
        ) : (
          <div className="mf-ttwo">
            <Column title="Qualified Setups" tint="up" count={setups.filter(s => s.qualified).length}>
              {setups.filter(s => s.qualified).map(s => (
                <li key={s.symbol} className="mf-tcard">
                  <div className="mf-tcard__top">
                    <div className="mf-tcard__name"><b>{s.symbol}</b><span>{s.costGatePassed ? 'Cost gate passed' : 'Cost policy flagged'}</span></div>
                    <Chip kind={trades.some(t => t.symbol === s.symbol) ? 'is-target' : 'is-open'}>
                      {trades.some(t => t.symbol === s.symbol) ? 'shadow entry' : 'waiting for trigger'}
                    </Chip>
                  </div>
                  <p className="mf-tcard__foot">
                    <span>OR <b>{price(s.orLow)} – {price(s.orHigh)}</b></span>
                    <span>Span <b>{s.orSpan}</b> pts ({(s.orSpan / (s.atr || 1) * 100).toFixed(0)}% ATR)</span>
                    <span>Cost <b>{s.costInR.toFixed(2)}R</b> ({Math.round(s.costToT1 * 100)}% T1)</span>
                  </p>
                </li>
              ))}
            </Column>
            <Column title="Disqualified / Data Blocked" tint="down" count={setups.filter(s => !s.qualified).length}>
              {setups.filter(s => !s.qualified).map(s => (
                <li key={s.symbol} className="mf-tcard">
                  <div className="mf-tcard__top">
                    <div className="mf-tcard__name"><b>{s.symbol}</b><span>{s.disqualificationReason ?? 'data blocked'}</span></div>
                    <Chip kind="is-stop">cancelled / data blocked</Chip>
                  </div>
                </li>
              ))}
            </Column>
          </div>
        )}
      </section>

      <section className="mf-tsection">
        <h3>Shadow Trades &amp; Settled Outcomes <small>{trades.length} trades</small></h3>
        <p className="mf-thint" style={{ margin: '4px 0 12px 0', fontSize: '12px' }}>
          Tags are recorded for research. They are not validated and do not change which trades are taken.
        </p>
        {trades.length === 0 ? (
          <p className="mf-tempty">No breakout triggers fired yet today. Waiting for trigger between 09:30 and 13:30 IST.</p>
        ) : (
          <ul className="mf-trades">
            {trades.map(tr => {
              const outKind = tr.outcome === 'target_hit' ? 'is-target' : tr.outcome === 'stop_hit' ? 'is-stop' : tr.outcome === 'pending' ? 'is-open' : 'is-flat';
              return (
                <li key={tr.id} className="mf-ttrade">
                  <div className="mf-ttrade__main is-plain">
                    <span className="mf-ttrade__who">
                      <b>{tr.symbol}</b>
                      <Chip kind={tr.side === 'long' ? 'is-long' : 'is-short'}>{tr.side}</Chip>
                      <small>{t(tr.entryAt)} · Cost {tr.costInR.toFixed(2)}R</small>
                      <TradeTagsBadges tags={tr.tags} />
                    </span>
                    <span className="mf-ttrade__px"><small>Entry</small><b>{price(tr.entryPrice)}</b></span>
                    <span className="mf-ttrade__px"><small>Stop</small><b>{price(tr.stopPrice)}</b></span>
                    <span className="mf-ttrade__px"><small>T1 / T2</small><b>{price(tr.t1Price)} · {price(tr.t2Price)}</b></span>
                    <span className="mf-ttrade__status">
                      <Chip kind={outKind}>{tr.outcome.replace('_', ' ')}</Chip>
                      <small>{tr.settled ? (tr.netR != null ? `Net ${sgn(tr.netR)}${Math.abs(tr.netR).toFixed(2)}R (Gross ${sgn(tr.grossR ?? 0)}${Math.abs(tr.grossR ?? 0).toFixed(2)}R)` : 'Settled') : 'Running'}</small>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

/** IST minutes since midnight, to say whether the entry window is open. */
function istMinute(): number {
  const p = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
  return Number(p.find(x => x.type === 'hour')?.value ?? 0) % 24 * 60 + Number(p.find(x => x.type === 'minute')?.value ?? 0);
}
const minutesOf = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

export function BuildUpTracker() {
  const { data, error } = useTracker();
  const [seg, setSegState] = useState<Seg>(() => remembered('orderFlow:tracker:seg', ['fno', 'mcx'] as const, 'fno'));
  const [tab, setTabState] = useState<Tab>(() => remembered('orderFlow:tracker:tab', ['live', 'trades', 'focus'] as const, 'live'));
  const setSeg = (v: Seg) => { setSegState(v); remember('orderFlow:tracker:seg', v); };
  const setTab = (v: Tab) => { setTabState(v); remember('orderFlow:tracker:tab', v); };

  if (!data) {
    return (
      <div className="mf-trk">
        <p className="mf-tempty">
          {error
            ? `The tracker is not available (${error}). It runs inside the live feed service, which starts on weekday mornings once the Breeze login is fresh; nothing is shown from before it stopped.`
            : 'Loading the tracker…'}
        </p>
      </div>
    );
  }

  const trades = data.trades.filter(x => segOfKind(x.kind) === seg);
  const rule = data.rules[seg];
  const [from, to] = (rule?.entries ?? '').split('-');
  const now = istMinute();
  const logging = Boolean(from && to) && now >= minutesOf(from) && now <= minutesOf(to);
  const openCount = trades.filter(x => (x.result.tight?.outcome ?? 'pending') === 'pending').length;
  const shadowTradesCount = (data.shadowOrb?.trades ?? []).filter(x => !x.settled).length;
  const tabs: Array<{ id: Tab; label: string; badge?: number }> = [
    { id: 'live', label: 'Live picks' },
    { id: 'trades', label: 'My trades', badge: openCount || undefined },
    { id: 'focus', label: 'Next-day focus' },
    { id: 'shadow', label: 'Shadow Setup (ORB)', badge: shadowTradesCount || undefined },
  ];

  return (
    <div className="mf-trk">
      {data.stale ? (
        <p className="mf-tstale" role="alert">
          Cached tracker from {dateFmt.format(data.stale.cachedAt)}, {t(data.stale.cachedAt)}. {data.stale.reason} The picks, CMP and open trades below are as they were then, not live;
          recorded trades and results are unchanged.
        </p>
      ) : null}
      <header className="mf-trk__head">
        <div className="mf-tpills is-big" role="group" aria-label="Segment">
          <button type="button" className={seg === 'fno' ? 'is-on' : ''} aria-pressed={seg === 'fno'} onClick={() => setSeg('fno')}>Stocks (F&amp;O)</button>
          <button type="button" className={seg === 'mcx' ? 'is-on' : ''} aria-pressed={seg === 'mcx'} onClick={() => setSeg('mcx')}>Commodities (MCX)</button>
        </div>
        <p className="mf-trk__status">
          <span className={`mf-tdot ${logging ? 'is-live' : ''}`} aria-hidden="true" />
          {logging ? `Logging new trades until ${to}` : `Not logging now: entries ${rule?.entries ?? '—'}`}
          <small>squares off {rule?.squareOff ?? '—'} IST{data.asof ? ` · ranked ${t(data.asof)}` : ''}{data.cadence ? ` (every ${data.cadence.rankEveryMin} min, order held between)` : ''}{data.pricedAt ? ` · prices ${t(data.pricedAt)}` : ''}</small>
        </p>
      </header>

      <nav className="mf-ttabs" aria-label="Tracker views">
        {tabs.map(x => (
          <button key={x.id} type="button" className={x.id === tab ? 'is-on' : ''} aria-current={x.id === tab ? 'page' : undefined} onClick={() => setTab(x.id)}>
            {x.label}{x.badge ? <em>{x.badge}</em> : null}
          </button>
        ))}
      </nav>

      {tab === 'live' ? <LivePicks data={data} seg={seg} /> : null}
      {tab === 'trades' ? <MyTrades trades={trades} /> : null}
      {tab === 'focus' ? <Focus data={data} seg={seg} /> : null}
      {tab === 'shadow' ? <ShadowView data={data} /> : null}

      <details className="mf-thow">
        <summary>How this works</summary>
        <p>
          Scored like the India F&amp;O app (:6699): build-up, size of the price and OI move, PCR and room to the option OI wall. A score of {data.recommendedScore} or more is a recommendation;
          from {data.minScore} a pick is logged. Stop and targets are its tight ATR ladder: stop 0.75 ATR away, targets 0.5, 1.0 and 1.5 ATR. Trades are judged on 1-minute closes and are intraday
          only: the first of target 1 or the stop to be reached decides it (a target fills at its level, a stop at the close that went through it), and what is still open at the close is squared off there;
          with no price near the close there is no outcome. Only finished minutes count, and a recorded outcome is never rewritten. R is profit or loss divided by the distance to the stop.
          These are HYPOTHETICAL research outcomes: no brokerage, taxes or slippage, and no check that you could have traded the size.
          Bullish means long build-up or short covering; bearish means short build-up or long unwinding. These are suggestions, not advice.
        </p>
      </details>
    </div>
  );
}
