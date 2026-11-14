import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { feedProblem, observedAtOf, useFeedStatus, useFuturesFeed, type FeedStatus } from './feed';

const status = (session: string, extra: Partial<FeedStatus> = {}): FeedStatus => ({
  provider: { id: 'http', label: 'ICICI Breeze live', alwaysLive: false }, ready: true, session, lastError: null,
  segments: { fno: { enabled: true, session }, mcx: { enabled: true, session } }, ...extra,
});

afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('observedAtOf', () => {
  it('is the newest time the vendor stamped on a series, not the time the file was built', () => {
    const market = { at: 9_000_000, series: [{ tape: 5_000 }, { tape: 7_000 }, { tape: null }, {}] } as never;
    expect(observedAtOf(market)).toBe(7_000);
  });
  it('is null when nothing carries a vendor time (and for no market)', () => {
    expect(observedAtOf({ at: 1, series: [{ tape: null }] } as never)).toBeNull();
    expect(observedAtOf(null)).toBeNull();
  });
});

describe('feedProblem', () => {
  it('names a failed build of the segment, and an unreachable server', () => {
    expect(feedProblem(null)).toBeNull();
    expect(feedProblem(status('2026-11-16'))).toBeNull();
    expect(feedProblem(status('2026-11-16', { segments: { mcx: { enabled: true, lastError: { at: 1, message: 'The data provider did not answer.' } } } }), 'mcx')).toBe('The data provider did not answer.');
    expect(feedProblem(status('2026-11-16', { unreachable: true }))).toMatch(/did not answer its last status check/);
  });
});

describe('useFeedStatus', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('asks again every minute, so a session change reaches a tab that was left open', async () => {
    const answers = [status('2026-11-13'), status('2026-11-16')];
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => answers.shift() ?? status('2026-11-16') })));
    const { result } = renderHook(() => useFeedStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(result.current?.session).toBe('2026-11-13');
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current?.session).toBe('2026-11-16');
  });

  it('keeps the last good status and marks it unreachable when a check fails, then recovers', async () => {
    let up = true;
    vi.stubGlobal('fetch', vi.fn(async () => { if (!up) throw new Error('down'); return { ok: true, json: async () => status('2026-11-13') }; }));
    const { result } = renderHook(() => useFeedStatus());
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(result.current?.unreachable).toBeUndefined();
    up = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current?.session).toBe('2026-11-13');
    expect(result.current?.unreachable).toBe(true);
    up = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(result.current?.unreachable).toBeUndefined();
  });
});

describe('useFuturesFeed across a session change', () => {
  it('stops asking for the old session and asks for the new one', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { urls.push(url); return { ok: true, json: async () => ({ months: [] }) }; }));
    const { rerender } = renderHook(({ s }) => useFuturesFeed(['AAA'], true, s), { initialProps: { s: status('2026-11-13') } });
    await waitFor(() => expect(urls.some(u => u.includes('session=2026-11-13'))).toBe(true));
    urls.length = 0;
    rerender({ s: status('2026-11-16') });
    await waitFor(() => expect(urls.some(u => u.includes('session=2026-11-16'))).toBe(true));
    expect(urls.every(u => u.includes('session=2026-11-16'))).toBe(true);
  });
});
