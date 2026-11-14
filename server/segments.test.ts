import { describe, expect, it } from 'vitest';
import { parseMarketFile } from '../src/features/options-scanner/contractScanModel';
import { encodeSeries, marketFile } from './marketFile.mjs';
import { createDemoProvider, demoNow } from './providers/demo.mjs';
import { createHttpProvider } from './providers/http.mjs';

/** The MCX segment on the server (9 Nov 2026): its own clock in the demo, commodity rows in the market file, and which providers supply it. */

const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);
const MINUTE = 60_000;

const universe = [
  { symbol: 'NIFTY', name: 'Nifty 50', kind: 'index', exch: 'NSE', lot: 65 },
  { symbol: 'CRUDE', name: 'Crude Oil', kind: 'commodity', exch: 'MCX', lot: 100, sector: 'mcx-energy' },
  { symbol: 'GOLD', name: 'Gold', kind: 'commodity', exch: 'MCX', lot: 1000, sector: 'mcx-bullion' },
  { symbol: 'GOLDMI', name: 'Gold Mini', kind: 'commodity', exch: 'MCX', lot: 100, sector: 'mcx-bullion' },
] as const;
const [nifty, crude, gold, goldMini] = universe;
const demo = createDemoProvider(universe as never);

describe('the demo clocks', () => {
  it('runs MCX live in the evening while NSE is replaying its day', () => {
    const evening = ist('2026-11-09', '20:00');
    expect(demoNow(evening, 'mcx')).toBe(evening);
    const replay = demoNow(evening, 'fno');
    expect(replay).not.toBe(evening);
    expect(replay).toBeGreaterThanOrEqual(ist('2026-11-09', '09:15'));
    expect(replay).toBeLessThanOrEqual(ist('2026-11-09', '15:31'));
  });

  it('replays the latest MCX session inside its own hours when the market is shut', () => {
    const sunday = ist('2026-11-08', '12:00');
    const replay = demoNow(sunday, 'mcx');
    expect(replay).toBeGreaterThanOrEqual(ist('2026-11-06', '09:00'));
    expect(replay).toBeLessThanOrEqual(ist('2026-11-06', '23:55'));
  });

  it('supplies both segments', () => {
    expect(demo.segments).toEqual(['fno', 'mcx']);
  });
});

describe('the demo commodities', () => {
  it('lists monthly expiries on weekdays, ascending', async () => {
    const dates = await demo.expiries(crude as never);
    expect(dates.length).toBe(3);
    expect([...dates].sort()).toEqual(dates);
    for (const date of dates) expect([0, 6]).not.toContain(new Date(`${date}T00:00:00Z`).getUTCDay());
  });

  it('prices a chain the market file accepts as a commodity, on the commodity strike step', async () => {
    const [expiry] = await demo.expiries(gold as never);
    const chain = await demo.optionChain(gold as never, expiry);
    expect(chain.spot).toBeGreaterThan(100_000);
    const strikes = chain.strikes.map(s => s.strike);
    expect(strikes[1] - strikes[0]).toBe(500);
    const series = encodeSeries(gold, chain, chain.at)!;
    expect(series.k).toBe('commodity');
    const parsed = parseMarketFile(marketFile({ at: chain.at, date: '2026-11-06', series: [series], minutes: [], ladders: {} }))!;
    expect(parsed.series[0].kind).toBe('commodity');
  });

  it('gives futures candles from the MCX open, a minute apart, with previous open interest in whole lots', async () => {
    const months = await demo.futures(crude as never, '2026-11-06');
    const { candles, prevOi } = months[0];
    expect(candles.length).toBeGreaterThan(0);
    expect(candles.length).toBeLessThanOrEqual(895);
    expect(candles[0].at).toBe(ist('2026-11-06', '09:00'));
    candles.forEach((c, i) => { if (i) expect(c.at - candles[i - 1].at).toBe(MINUTE); });
    expect(prevOi % crude.lot).toBe(0);
    expect(candles.at(-1)!.oi).toBeGreaterThan(0);
  });

  it('moves a mini contract with its parent', async () => {
    const [a] = await demo.futures(gold as never, '2026-11-06');
    const [b] = await demo.futures(goldMini as never, '2026-11-06');
    const n = Math.min(a.candles.length, b.candles.length);
    expect(n).toBeGreaterThan(5);
    // Same market, so the previous closes differ only by the two contracts' own base levels (142,500 against 142,100), not by random noise.
    expect(a.prevClose / b.prevClose).toBeCloseTo(142500 / 142100, 3);
    const ratios = a.candles.slice(0, n).map((c, i) => c.close / b.candles[i].close);
    expect(Math.max(...ratios) / Math.min(...ratios)).toBeLessThan(1.02);
  });

  it('leaves the F&O simulation as it was: NIFTY still opens at 09:15 with expiries on Tuesdays', async () => {
    const [first] = await demo.futures(nifty as never, '2026-11-06');
    expect(first.candles[0].at).toBe(ist('2026-11-06', '09:15'));
    for (const date of await demo.expiries(nifty as never)) expect(new Date(`${date}T00:00:00Z`).getUTCDay()).toBe(2);
  });
});

describe('which providers supply MCX', () => {
  const U = { symbol: 'CRUDE', name: 'Crude Oil', kind: 'commodity', exch: 'MCX', lot: 100, apiKey: 'MCX:CRUDE' };
  it('an HTTP source supplies F&O only until it says otherwise', () => {
    expect(createHttpProvider([U], {}).segments).toEqual(['fno']);
    expect(createHttpProvider([U], { MF_HTTP_SEGMENTS: 'fno, mcx' }).segments).toEqual(['fno', 'mcx']);
  });
});
