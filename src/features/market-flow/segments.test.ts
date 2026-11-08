import { describe, expect, it } from 'vitest';
import type { Underlying } from '@/lib/underlyings';
import type { ContractMarket, ContractQuote, ContractSeries } from '../options-scanner/contractScanModel';
import type { FuturesSeries } from '../options-scanner/futuresModel';
import { MCX_SESSION } from '@/lib/segmentSession';
import { describeDataAge } from './dataAge';
import { chartSpan } from './flowChartModel';
import { buildMarketFlow, DEFAULT_FLOW_SETTINGS, nearSeries, trimToSession } from './marketFlowModel';
import { inUniverse, loadUniverse, saveUniverse, segmentOfUniverse } from './nifty50';

/** The MCX segment on the board (9 Nov 2026): its own universe, clock, expiry cut-off and chart span. */

const MINUTE = 60_000;
const DATE = '2026-11-09';
const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);

describe('the MCX universe', () => {
  const nifty = { symbol: 'NIFTY', exch: 'NSE' };
  const reliance = { symbol: 'RELIANCE', exch: 'NSE' };
  const sensex = { symbol: 'SENSEX', exch: 'BSE' };
  const crude = { symbol: 'CRUDE', exch: 'MCX' };

  it('keeps commodities out of All F&O and Nifty 50, and F&O out of MCX', () => {
    expect(inUniverse(crude, 'mcx')).toBe(true);
    expect(inUniverse(crude, 'fno')).toBe(false);
    expect(inUniverse(crude, 'nifty50')).toBe(false);
    for (const item of [nifty, reliance, sensex]) expect(inUniverse(item, 'mcx')).toBe(false);
    expect(inUniverse(reliance, 'fno')).toBe(true);
    expect(inUniverse(sensex, 'fno')).toBe(true);
  });

  it('still reads Nifty 50 as the constituents and NIFTY itself', () => {
    expect(inUniverse(nifty, 'nifty50')).toBe(true);
    expect(inUniverse(reliance, 'nifty50')).toBe(true);
    expect(inUniverse({ symbol: 'ZYDUSLIFE', exch: 'NSE' }, 'nifty50')).toBe(false);
  });

  it('names the segment each universe is read from', () => {
    expect(segmentOfUniverse('mcx')).toBe('mcx');
    expect(segmentOfUniverse('fno')).toBe('fno');
    expect(segmentOfUniverse('nifty50')).toBe('fno');
  });

  it('remembers MCX, and any unknown value falls back to All F&O', () => {
    saveUniverse('mcx');
    expect(loadUniverse()).toBe('mcx');
    localStorage.setItem('orderFlow:universe:v1', 'bogus');
    expect(loadUniverse()).toBe('fno');
    saveUniverse('fno');
  });
});

describe('the MCX session on the board', () => {
  const quote = (strike: number, side: 'CE' | 'PE', oi: number): ContractQuote => ({
    strike, side, ltp: 10, prevClose: 9, oi, prevOi: oi, volume: 100, prevVolumeLots: 1, avgPrice: 10, iv: 30, bid: 9.9, ask: 10.1, bidQty: 1, askQty: 1,
    dayHigh: 11, dayLow: 9, lastTradeAt: ist(DATE, '20:00'), delta: 0.5,
  });
  const crudeSeries = (expiry: string): ContractSeries => ({
    symbol: 'CRUDE', kind: 'commodity', expiry, lot: 100, lotSource: 'catalogue', at: ist(DATE, '20:00'), spot: 8400, spotPrevClose: 8300, atm: 8400,
    quotes: [quote(8300, 'PE', 900), quote(8500, 'CE', 800)],
  });
  const market = (list: ContractSeries[], at = ist(DATE, '20:00')): ContractMarket => ({ at, date: DATE, series: list, minutes: [], ladders: {} });
  const crude: Underlying = { symbol: 'CRUDE', name: 'Crude Oil', apiKey: 'MCX:CRUDE', lot: 100, kind: 'commodity', exch: 'MCX', sector: 'mcx-energy' };

  it('keeps an expiry dated today live in the evening, where NSE would already have settled it', () => {
    const file = market([crudeSeries(DATE), crudeSeries('2026-11-19')]);
    const evening = ist(DATE, '20:00');
    expect(nearSeries(file, 'CRUDE', evening, MCX_SESSION)?.expiry).toBe(DATE);
    expect(nearSeries(file, 'CRUDE', evening)?.expiry).toBe('2026-11-19');                     // the F&O profile, for contrast
    expect(nearSeries({ ...file, at: ist(DATE, '23:45') }, 'CRUDE', ist(DATE, '23:45'), MCX_SESSION)?.expiry).toBe('2026-11-19');
  });

  it('reads futures through the evening, where F&O trims at 15:30', () => {
    const evening: FuturesSeries = {
      symbol: 'CRUDE', contractDate: '2026-11-19', months: ['2026-11-19'], prevClose: 8300, prevOi: 1000,
      candles: Array.from({ length: 30 }, (_, i) => ({ at: ist(DATE, '21:00') + i * MINUTE, close: 8400 + i, oi: 1000 + i })),
    };
    expect(trimToSession(evening, DATE, MCX_SESSION).candles).toHaveLength(30);
    expect(trimToSession(evening, DATE).candles).toHaveLength(0);
  });

  it('charts the commodity session from 09:00 to its close, and F&O from 09:15 to 15:30', () => {
    const none = { read: 0, unavailable: 0, failed: 0, pending: 0, total: 0, latestAt: null };
    expect(chartSpan({ date: DATE, window: 'day', futures: none, segment: 'mcx' })).toEqual([ist(DATE, '09:00'), ist(DATE, '23:30')]);
    expect(chartSpan({ date: DATE, window: 'day', futures: none })).toEqual([ist(DATE, '09:15'), ist(DATE, '15:30')]);
    expect(chartSpan({ date: '2026-10-15', window: 'day', futures: none, segment: 'mcx' })[1]).toBe(ist('2026-10-15', '23:55'));
  });

  it('builds a board for the commodities with their own sector, labelled with the segment', () => {
    const file = market([crudeSeries('2026-11-19')]);
    const reads = new Map<string, FuturesSeries | null>([['CRUDE', {
      symbol: 'CRUDE', contractDate: '2026-11-19', months: ['2026-11-19'], prevClose: 8300, prevOi: 1000,
      candles: Array.from({ length: 60 }, (_, i) => ({ at: ist(DATE, '09:00') + i * MINUTE, close: 8300 + i * 2, oi: 1000 + i * 5 })),
    }]]);
    const flow = buildMarketFlow(file, reads, [crude], { 'mcx-energy': 'Energy' }, DEFAULT_FLOW_SETTINGS, { segment: 'mcx', now: ist(DATE, '20:00') });
    expect(flow.segment).toBe('mcx');
    expect(flow.stocks).toHaveLength(1);
    expect(flow.stocks[0]).toMatchObject({ symbol: 'CRUDE', kind: 'commodity', sector: 'mcx-energy', sectorLabel: 'Energy', side: 'bullish', buildUp: 'LONG_BUILD' });
  });

  it('says a reading is from an earlier session by each segment’s own calendar', () => {
    // Tuesday 10 Nov 2026 is Diwali: NSE is shut, MCX trades. At noon the latest NSE session is Monday's, MCX's is Tuesday's.
    const monday = ist(DATE, '20:00');
    const tuesdayNoon = ist('2026-11-10', '12:00');
    expect(describeDataAge(monday, tuesdayNoon, 'fno').aged).toBe(false);
    expect(describeDataAge(monday, tuesdayNoon, 'mcx').aged).toBe(true);
  });
});
