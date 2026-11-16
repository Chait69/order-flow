import {
  getLatestTradingSessionDate, isExpirySettled as nseExpirySettled, isMarketSessionTime, isTradingDay as nseTradingDay,
  marketCloseMinuteFor, marketParts, MARKET_OPEN_MINUTE, marketSessionBounds as nseSessionBounds,
} from './marketSession.ts';

/**
 * The exchange segments the board can show, each with its OWN session clock.
 *
 * `fno` is NSE and BSE equity derivatives: 09:15 to 15:40 (the readings and the chart span 09:15 to 15:30), the NSE holiday
 * calendar. Every function here delegates to marketSession.ts, so the F&O board behaves exactly as it did before segments.
 *
 * `mcx` is MCX commodity futures and options: 09:00 to 23:30 IST on weekdays, to 23:55 while US daylight saving is in force
 * (the exchange moves its close with it) and, as an exception, through the winter of 2026-27 (see MCX_LATE_CLOSE_RANGES), and its own holidays. The two segments never share a session date, a
 * live-hours test or an expiry cut-off: at 20:00 the F&O board is closed and the commodity board is live.
 */

export type Segment = 'fno' | 'mcx';

export interface SessionProfile {
  id: Segment;
  label: string;
  /** Minute of the IST day the session opens. */
  openMinute: number;
  /** Minute of the IST day the instruments stop trading on the date of `time`. */
  closeMinuteFor(time: number | Date): number;
  /** Minute the readings and the chart end at: the last print of the session proper. */
  readingEndMinuteFor(time: number | Date): number;
  isTradingDay(time: number | Date): boolean;
  isSessionTime(time: number | Date): boolean;
  /** The most recent session date (IST `YYYY-MM-DD`): today's once the session has opened, else the previous trading day's. */
  latestSessionDate(from?: Date): string;
  /** The session's open and close as epoch ms, on the IST date of `time`. */
  sessionBounds(time: number | Date): { open: number; close: number };
  isExpirySettled(expiry: string, time?: number | Date): boolean;
  filterLiveExpiries(expiries: string[], time?: number | Date): string[];
}

const DAY_MS = 86_400_000;
const midnightOf = (dateKey: string) => Date.parse(`${dateKey}T00:00:00+05:30`);
const dateKeyOf = (time: number | Date) => marketParts(time).dateKey;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function liveExpiries(profile: Pick<SessionProfile, 'isExpirySettled'>, expiries: string[], time: number | Date): string[] {
  return Array.from(new Set(expiries))
    .filter(expiry => ISO_DATE.test(expiry) && !profile.isExpirySettled(expiry, time))
    .sort((a, b) => a.localeCompare(b));
}

// ── NSE / BSE F&O ───────────────────────────────────────────────────────────

/** The F&O readings and chart end at 15:30 IST: later candles belong to the closing session. */
const FNO_READING_END_MINUTE = 15 * 60 + 30;

export const FNO_SESSION: SessionProfile = {
  id: 'fno',
  label: 'NSE F&O',
  openMinute: MARKET_OPEN_MINUTE,
  closeMinuteFor: marketCloseMinuteFor,
  readingEndMinuteFor: () => FNO_READING_END_MINUTE,
  isTradingDay: nseTradingDay,
  isSessionTime: isMarketSessionTime,
  latestSessionDate: getLatestTradingSessionDate,
  sessionBounds: nseSessionBounds,
  isExpirySettled: nseExpirySettled,
  filterLiveExpiries: (expiries, time = Date.now()) => liveExpiries({ isExpirySettled: nseExpirySettled }, expiries, time),
};

// ── MCX commodities ─────────────────────────────────────────────────────────

export const MCX_OPEN_MINUTE = 9 * 60;
const MCX_CLOSE_MINUTE = 23 * 60 + 30;
/** MCX's close while US daylight saving is in force. */
const MCX_CLOSE_MINUTE_US_DST = 23 * 60 + 55;
/**
 * MCX Calendar Status: the 23:55 close is CONFIRMED BY OBSERVATION; the circular text itself was never read.
 * MCX circular MCX/TRD/550/2026 could not be fetched (HTTP 403). The owner stated that it sets non-agricultural trading
 * 09:00-23:55 IST for 2 November 2026 through 12 March 2027 inclusive (MCX/TRD/068/2026 set a 23:30 close from 9 March 2026).
 * Checked on 16 Nov 2026: the live feed ticked at full rate (~1,000/s) through 23:30 and dropped to ~25/s at 23:55.
 * The implemented range, 2026-11-02 to 2027-03-13, comes from the US daylight-saving calendar and is one day longer than the
 * stated range; the days after 12 March 2027 have not been observed.
 */
export const MCX_CALENDAR_STATUS = {
  verified: true,
  circular: 'MCX/TRD/550/2026',
  status: 'close 23:55 confirmed from live ticks on 2026-11-16; circular text not read',
  statedRange: ['2026-11-02', '2027-03-12'] as const,
  implementedRange: ['2026-11-02', '2027-03-13'] as const,
  empiricalCheckPending: false,
};

const MCX_LATE_CLOSE_RANGES: ReadonlyArray<readonly [string, string]> = [['2026-11-02', '2027-03-13']];

/**
 * Days MCX is shut for BOTH sessions. PROVISIONAL: only the closures that are the same every year (Republic Day, Good Friday,
 * Christmas); on other exchange holidays MCX usually keeps its evening session, so those are treated as trading days. The
 * live feed supplies the real calendar (the India F&O app exports MCX's); replace this set with it.
 */
export const MCX_FULL_HOLIDAYS: ReadonlySet<string> = new Set([
  '2026-01-26', '2026-04-03', '2026-12-25',
  '2027-01-26', '2027-03-26', '2027-12-25',
]);

/** The n-th Sunday of a month (n = 1, 2, …), as `YYYY-MM-DD`. */
function nthSunday(year: number, month: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const day = 1 + ((7 - first.getUTCDay()) % 7) + (n - 1) * 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** US daylight saving: from the second Sunday of March to the first Sunday of November (dates, not instants: close enough for a close time). */
export function usDaylightSaving(dateKey: string): boolean {
  const year = Number(dateKey.slice(0, 4));
  return dateKey >= nthSunday(year, 3, 2) && dateKey < nthSunday(year, 11, 1);
}

function mcxCloseMinute(time: number | Date): number {
  const key = dateKeyOf(time);
  const late = usDaylightSaving(key) || MCX_LATE_CLOSE_RANGES.some(([from, to]) => key >= from && key <= to);
  return late ? MCX_CLOSE_MINUTE_US_DST : MCX_CLOSE_MINUTE;
}

function mcxTradingDay(time: number | Date): boolean {
  const parts = marketParts(time);
  return parts.weekday !== 0 && parts.weekday !== 6 && !MCX_FULL_HOLIDAYS.has(parts.dateKey);
}

function mcxSessionTime(time: number | Date): boolean {
  const parts = marketParts(time);
  return mcxTradingDay(time) && parts.minuteOfDay >= MCX_OPEN_MINUTE && parts.minuteOfDay <= mcxCloseMinute(time);
}

function mcxLatestSessionDate(from: Date = new Date()): string {
  const parts = marketParts(from);
  let ms = from.getTime();
  // Before the open (or on a closed day) the latest session is the previous trading day's. Bounded: a calendar never closes a month.
  if (!mcxTradingDay(ms) || parts.minuteOfDay < MCX_OPEN_MINUTE) {
    for (let i = 0; i < 20; i += 1) {
      ms -= DAY_MS;
      if (mcxTradingDay(ms)) break;
    }
  }
  return dateKeyOf(ms);
}

function mcxExpirySettled(expiry: string, time: number | Date = Date.now()): boolean {
  if (!ISO_DATE.test(expiry)) return false;
  const parts = marketParts(time);
  if (expiry < parts.dateKey) return true;
  if (expiry > parts.dateKey) return false;
  return parts.minuteOfDay > mcxCloseMinute(time);
}

export const MCX_SESSION: SessionProfile = {
  id: 'mcx',
  label: 'MCX',
  openMinute: MCX_OPEN_MINUTE,
  closeMinuteFor: mcxCloseMinute,
  readingEndMinuteFor: mcxCloseMinute,
  isTradingDay: mcxTradingDay,
  isSessionTime: mcxSessionTime,
  latestSessionDate: mcxLatestSessionDate,
  sessionBounds: time => {
    const midnight = midnightOf(dateKeyOf(time));
    return { open: midnight + MCX_OPEN_MINUTE * 60_000, close: midnight + mcxCloseMinute(time) * 60_000 };
  },
  isExpirySettled: mcxExpirySettled,
  filterLiveExpiries: (expiries, time = Date.now()) => liveExpiries({ isExpirySettled: mcxExpirySettled }, expiries, time),
};

export const SESSION_PROFILES: Readonly<Record<Segment, SessionProfile>> = { fno: FNO_SESSION, mcx: MCX_SESSION };

export const profileFor = (segment: Segment | undefined | null): SessionProfile => SESSION_PROFILES[segment === 'mcx' ? 'mcx' : 'fno'];

/** The segment an underlying belongs to: MCX commodities are their own; everything else trades with NSE/BSE F&O. */
export const segmentOfExchange = (exch: string | undefined | null): Segment => (exch === 'MCX' ? 'mcx' : 'fno');

/** Minutes a day's readings and chart span: from the open to the last reading minute. */
export function sessionMinutes(profile: SessionProfile, dateKey: string): number {
  return profile.readingEndMinuteFor(midnightOf(dateKey) + 12 * 60 * 60_000) - profile.openMinute;
}
