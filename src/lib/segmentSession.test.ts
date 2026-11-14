import { describe, expect, it } from 'vitest';
import { isMarketSessionTime, getLatestTradingSessionDate } from './marketSession';
import { FNO_SESSION, MCX_SESSION, profileFor, segmentOfExchange, sessionMinutes, usDaylightSaving } from './segmentSession';

const ist = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+05:30`);

describe('the F&O profile', () => {
  it('is the existing NSE clock, unchanged', () => {
    for (const [date, hhmm] of [['2026-11-09', '09:14'], ['2026-11-09', '09:15'], ['2026-11-09', '15:40'], ['2026-11-09', '15:41'], ['2026-11-07', '11:00'], ['2026-11-10', '11:00']]) {
      expect(FNO_SESSION.isSessionTime(ist(date, hhmm))).toBe(isMarketSessionTime(ist(date, hhmm)));
    }
    expect(FNO_SESSION.latestSessionDate(new Date(ist('2026-11-07', '12:00')))).toBe(getLatestTradingSessionDate(new Date(ist('2026-11-07', '12:00'))));
  });

  it('reads and charts to 15:30 for a 375-minute day', () => {
    expect(sessionMinutes(FNO_SESSION, '2026-11-09')).toBe(375);
    expect(FNO_SESSION.openMinute).toBe(9 * 60 + 15);
  });
});

describe('the MCX profile', () => {
  it('is live in the evening, when the F&O board is closed', () => {
    expect(MCX_SESSION.isSessionTime(ist('2026-11-09', '20:00'))).toBe(true);
    expect(FNO_SESSION.isSessionTime(ist('2026-11-09', '20:00'))).toBe(false);
    expect(MCX_SESSION.isSessionTime(ist('2026-11-09', '09:00'))).toBe(true);
    expect(MCX_SESSION.isSessionTime(ist('2026-11-09', '08:59'))).toBe(false);
  });

  it('closes at 23:55 while US daylight saving is in force and through the winter of 2026-27, at 23:30 otherwise', () => {
    expect(MCX_SESSION.isSessionTime(ist('2026-10-15', '23:50'))).toBe(true);
    expect(MCX_SESSION.isSessionTime(ist('2026-10-15', '23:56'))).toBe(false);
    expect(MCX_SESSION.isSessionTime(ist('2026-11-09', '23:55'))).toBe(true);        // the winter exception
    expect(MCX_SESSION.isSessionTime(ist('2026-11-09', '23:56'))).toBe(false);
    expect(MCX_SESSION.isSessionTime(ist('2027-02-10', '23:50'))).toBe(true);
    expect(MCX_SESSION.isSessionTime(ist('2027-11-15', '23:30'))).toBe(true);        // after the exception and outside daylight saving: 23:30 again
    expect(MCX_SESSION.isSessionTime(ist('2027-11-15', '23:31'))).toBe(false);
    expect(sessionMinutes(MCX_SESSION, '2026-11-09')).toBe(895);
    expect(sessionMinutes(MCX_SESSION, '2026-10-15')).toBe(895);
    expect(sessionMinutes(MCX_SESSION, '2027-11-15')).toBe(870);
  });

  it('holds the winter exception from 2 November 2026 to 13 March 2027 and no longer', () => {
    expect(MCX_SESSION.isSessionTime(ist('2026-11-02', '23:55'))).toBe(true);
    expect(MCX_SESSION.isSessionTime(ist('2027-03-12', '23:55'))).toBe(true);
    expect(MCX_SESSION.isSessionTime(ist('2027-03-15', '23:55'))).toBe(true);        // US daylight saving began on 14 March 2027
    expect(MCX_SESSION.isSessionTime(ist('2027-11-15', '23:55'))).toBe(false);
  });

  it('follows the US clock change on the right Sundays (8 March and 1 November 2026)', () => {
    expect(usDaylightSaving('2026-03-07')).toBe(false);
    expect(usDaylightSaving('2026-03-08')).toBe(true);
    expect(usDaylightSaving('2026-10-31')).toBe(true);
    expect(usDaylightSaving('2026-11-01')).toBe(false);
  });

  it('is shut at weekends and on its full holidays', () => {
    expect(MCX_SESSION.isSessionTime(ist('2026-11-07', '12:00'))).toBe(false);   // Saturday
    expect(MCX_SESSION.isSessionTime(ist('2026-11-08', '20:00'))).toBe(false);   // Sunday
    expect(MCX_SESSION.isTradingDay(ist('2026-12-25', '12:00'))).toBe(false);
  });

  it('has its own latest session date: Diwali (10 Nov) closes NSE but not the commodity evening session', () => {
    expect(FNO_SESSION.latestSessionDate(new Date(ist('2026-11-10', '12:00')))).toBe('2026-11-09');
    expect(MCX_SESSION.latestSessionDate(new Date(ist('2026-11-10', '12:00')))).toBe('2026-11-10');
  });

  it('keeps the previous session until it opens, and over a weekend', () => {
    expect(MCX_SESSION.latestSessionDate(new Date(ist('2026-11-09', '08:00')))).toBe('2026-11-06');
    expect(MCX_SESSION.latestSessionDate(new Date(ist('2026-11-09', '09:00')))).toBe('2026-11-09');
    expect(MCX_SESSION.latestSessionDate(new Date(ist('2026-11-07', '12:00')))).toBe('2026-11-06');
    expect(MCX_SESSION.latestSessionDate(new Date(ist('2026-11-08', '23:00')))).toBe('2026-11-06');
  });

  it('settles an expiry at its own close, not at NSE’s', () => {
    expect(MCX_SESSION.isExpirySettled('2026-11-09', ist('2026-11-09', '20:00'))).toBe(false);
    expect(FNO_SESSION.isExpirySettled('2026-11-09', ist('2026-11-09', '20:00'))).toBe(true);
    expect(MCX_SESSION.isExpirySettled('2026-11-09', ist('2026-11-09', '23:58'))).toBe(true);
    expect(MCX_SESSION.filterLiveExpiries(['2026-11-19', '2026-11-09', '2026-11-19', '2026-12-18', 'junk'], ist('2026-11-09', '20:00')))
      .toEqual(['2026-11-09', '2026-11-19', '2026-12-18']);
  });

  it('gives the session bounds of the date', () => {
    const { open, close } = MCX_SESSION.sessionBounds(ist('2026-11-09', '12:00'));
    expect([open, close]).toEqual([ist('2026-11-09', '09:00'), ist('2026-11-09', '23:55')]);
  });
});

describe('choosing a profile', () => {
  it('maps exchanges to segments, and anything else to F&O', () => {
    expect(segmentOfExchange('MCX')).toBe('mcx');
    expect(segmentOfExchange('NSE')).toBe('fno');
    expect(segmentOfExchange('BSE')).toBe('fno');
    expect(segmentOfExchange(undefined)).toBe('fno');
    expect(profileFor('mcx').id).toBe('mcx');
    expect(profileFor(undefined).id).toBe('fno');
  });
});
