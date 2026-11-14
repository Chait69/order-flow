import { Button } from '@/components/common/Button';
import { describeDataAge } from './dataAge';
import { clockOf, type MarketFlow } from './marketFlowModel';

const dateFormat = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });

interface FlowStatusProps {
  flow: MarketFlow | null;
  /** When this server built the market file (retrieval time); null until something has been read. */
  at: number | null;
  /** When the prices were observed: the vendor's own time on them. Shown apart from `at`. */
  observedAt?: number | null;
  /** Underlyings priced out of those in scope. */
  coverage?: { have: number; of: number } | null;
  /** What is wrong with the live data (from the server), shown even while older data is on screen. */
  problem?: string | null;
  loading: boolean;
  /** What the server said when the market could not be read. */
  error?: string | null;
  /** Where the numbers come from: the demo market or a broker. */
  provider?: { id: string; label: string; alwaysLive: boolean } | null;
  futuresRead: number;
  futuresTotal: number;
  onRescan: () => void;
  /** Overridable for tests; the real clock otherwise. */
  now?: number;
}

/**
 * The board's one line of status: how the market split and of how many, and
 * the time the board stands for (the market file's, and the futures' last
 * minute). While futures are still loading the counts are marked as
 * updating, since a spot change stands in for each future not yet read. A
 * file from an earlier session says so.
 */
export function FlowStatus({ flow, at, observedAt, coverage, problem, loading, error, provider, futuresRead, futuresTotal, onRescan, now }: FlowStatusProps) {
  // Short on the page (the status column is narrow); the server's own words are the tooltip and the accessible label.
  const detail = problem ? problem.replace(/[.\s]+$/, '') : '';
  const alert = problem
    ? <span className="mf-status__warn" role="alert" title={detail} aria-label={`Live feed problem: ${detail}${flow ? '. Showing the last data that arrived' : ''}`}>
      Live feed problem{flow ? ' · showing the last data' : ''}
    </span>
    : null;
  const source = provider ? (
    <span className={`mf-status__source${provider.alwaysLive ? ' is-demo' : ''}`}>
      <i aria-hidden="true" />{provider.id === 'recorded' || provider.id === 'archive' ? `${provider.label} · replay` : provider.alwaysLive ? `${provider.label} · live` : provider.label}
    </span>
  ) : null;
  if (!flow) {
    return (
      <p className="mf-status" role="status">
        {source}
        {alert}
        {error
          ? <span>{error} <Button size="S" intent="secondary" onClick={onRescan}>Try again</Button></span>
          : loading
            ? <span>Loading the market…</span>
            : <span>Could not load data. <Button size="S" intent="secondary" onClick={onRescan}>Try again</Button></span>}
      </p>
    );
  }
  const age = (observedAt ?? at) != null ? describeDataAge((observedAt ?? at) as number, now, flow.segment) : null;
  const updating = futuresRead < futuresTotal || flow.provisional;
  const total = flow.futures.total;
  const stampOf = (ms: number) => `${dateFormat.format(ms)}, ${clockOf(ms)}`;
  const stamp = at != null ? stampOf(at) : null;
  return (
    <p className={`mf-status${updating ? ' is-updating' : ''}`} role="status">
      {source}
      {alert}
      <span className="mf-status__counts">
        <b className="mf-tone is-bullish">{flow.bullish.length} up</b>
        <span aria-hidden="true"> · </span><span>{flow.rangebound.length} flat</span>
        <span aria-hidden="true"> · </span><b className="mf-tone is-bearish">{flow.bearish.length} down</b>
        <span> of {total}</span>
        {coverage && coverage.have < coverage.of && <> · <span className="mf-status__warn">{coverage.have} of {coverage.of} underlyings priced</span></>}
      </span>
      {updating ? (
        <span className="mf-status__load">
          <span className="mf-status__bar" aria-hidden="true"><i style={{ transform: `scaleX(${futuresRead / Math.max(1, futuresTotal)})` }} /></span>
          Updating · futures {futuresRead} of {futuresTotal}
        </span>
      ) : (
        <span className="mf-status__time">
          {observedAt != null ? <>Prices observed {stampOf(observedAt)}{stamp && <> · fetched {stamp}</>}</> : stamp && <>As of {stamp}</>}
          {flow.futures.latestAt != null && <> · futures to {clockOf(flow.futures.latestAt)}</>}
          {flow.futures.failed > 0 && <> · <span className="mf-status__warn">{flow.futures.failed} could not load</span></>}
        </span>
      )}
      {/* A replay (the demo, a recorded day) says what it is in its source label instead. */}
      {age?.aged && !provider?.alwaysLive && <span className="mf-status__aged">{updating && (observedAt ?? at) != null ? `As of ${stampOf((observedAt ?? at) as number)}, ` : ''}an earlier session</span>}
    </p>
  );
}
