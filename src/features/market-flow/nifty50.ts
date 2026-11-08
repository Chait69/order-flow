import { segmentOfExchange, type Segment } from '@/lib/segmentSession';

/**
 * The NIFTY 50's constituents, as F&O symbols in public/underlyings.json.
 *
 * As of the September 2025 rebalance (Tata Motors as TMPV after its
 * demerger). NSE reviews the index twice a year, in March and September:
 * update this list when it does.
 */

export const NIFTY_50 = [
  'ADANIENT', 'ADANIPORTS', 'APOLLOHOSP', 'ASIANPAINT', 'AXISBANK', 'BAJAJ-AUTO', 'BAJFINANCE', 'BAJAJFINSV', 'BEL', 'BHARTIARTL',
  'CIPLA', 'COALINDIA', 'DRREDDY', 'EICHERMOT', 'ETERNAL', 'GRASIM', 'HCLTECH', 'HDFCBANK', 'HDFCLIFE', 'HINDALCO',
  'HINDUNILVR', 'ICICIBANK', 'INDIGO', 'INFY', 'ITC', 'JIOFIN', 'JSWSTEEL', 'KOTAKBANK', 'LT', 'M&M',
  'MARUTI', 'MAXHEALTH', 'NESTLEIND', 'NTPC', 'ONGC', 'POWERGRID', 'RELIANCE', 'SBILIFE', 'SBIN', 'SHRIRAMFIN',
  'SUNPHARMA', 'TATACONSUM', 'TMPV', 'TATASTEEL', 'TCS', 'TECHM', 'TITAN', 'TRENT', 'ULTRACEMCO', 'WIPRO',
] as const;

/**
 * The board's universe: the NIFTY 50 (with NIFTY itself, the chart's reference line), every NSE/BSE F&O underlying, or the MCX
 * commodities. The first two are the `fno` segment and share its clock; `mcx` is a segment of its own (src/lib/segmentSession.ts).
 */
export type FlowUniverse = 'nifty50' | 'fno' | 'mcx';

/** The exchange segment a universe is read from. */
export const segmentOfUniverse = (universe: FlowUniverse): Segment => (universe === 'mcx' ? 'mcx' : 'fno');

const MEMBERS = new Set<string>([...NIFTY_50, 'NIFTY']);

/** Whether an underlying belongs to a universe. "All F&O" is NSE and BSE only: commodities are the MCX universe's. */
export function inUniverse(item: { symbol: string; exch?: string | null }, universe: FlowUniverse): boolean {
  const commodity = segmentOfExchange(item.exch) === 'mcx';
  if (universe === 'mcx') return commodity;
  if (commodity) return false;
  return universe === 'fno' || MEMBERS.has(item.symbol);
}

const KEY = 'orderFlow:universe:v1';
export function loadUniverse(): FlowUniverse {
  try {
    const held = localStorage.getItem(KEY);
    return held === 'nifty50' || held === 'mcx' ? held : 'fno';
  } catch { return 'fno'; }
}
export function saveUniverse(universe: FlowUniverse): void {
  try { localStorage.setItem(KEY, universe); } catch { /* A private window keeps the choice for this visit only. */ }
}
