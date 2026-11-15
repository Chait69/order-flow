import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BuildUpTracker, TradeTagsBadges } from './BuildUpTracker';

describe('BuildUpTracker Tag Badges (R2 & T2)', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('R2: badge elements carry class names and NO inline style attribute', () => {
    const { container } = render(
      <TradeTagsBadges
        tags={{
          cost_ok: true,
          quote_ok: true,
          ohlc_basis: true,
          orb_side: 'agree',
          vwap_side: 'agree',
          rs_side: 'agree',
          or_side: 'agree',
        }}
        side="long"
      />
    );

    const badges = container.querySelectorAll('.mf-tag-badge');
    expect(badges.length).toBeGreaterThan(0);

    badges.forEach(badge => {
      // Must not have an inline style attribute
      expect(badge.getAttribute('style')).toBeNull();
      // Must have classes
      expect(badge.className).toContain('mf-tag-badge');
    });
  });

  it('R2: snapshot-free check that no element in tags group has inline color or border style', () => {
    const { container } = render(
      <TradeTagsBadges
        tags={{
          cost_ok: false,
          quote_ok: false,
          ohlc_basis: false,
          orb_side: 'oppose',
          vwap_side: 'oppose',
          rs_side: 'oppose',
          or_side: 'oppose',
        }}
        side="long"
      />
    );

    const allElements = container.querySelectorAll('.mf-tag-groups *');
    allElements.forEach(el => {
      const style = el.getAttribute('style');
      if (style) {
        expect(style).not.toMatch(/color/i);
        expect(style).not.toMatch(/#[0-9a-fA-F]{3,6}/);
      }
    });
  });

  it('T2: toggle off -> no green/red classes anywhere in the DOM', () => {
    const { container } = render(
      <TradeTagsBadges
        tags={{
          orb_side: 'agree',
          vwap_side: 'agree',
          cost_ok: true,
        }}
        side="long"
      />
    );

    // By default colourTags is false
    expect(container.querySelectorAll('.is-coloured').length).toBe(0);
    expect(container.querySelectorAll('.is-agree').length).toBe(0);
    expect(container.querySelectorAll('.is-oppose').length).toBe(0);
  });

  it('T2: unknown renders dashed (is-unknown)', () => {
    const { container } = render(
      <TradeTagsBadges
        tags={{
          cost_ok: null,
          quote_ok: null,
          ohlc_basis: null,
          orb_side: null,
          vwap_side: null,
          rs_side: null,
          or_side: null,
        }}
        side="long"
      />
    );

    const unknownBadges = container.querySelectorAll('.is-unknown');
    expect(unknownBadges.length).toBe(7); // 4 direction + 3 data
  });

  it('T2: old rows (orb_agree key) render correctly: true -> agree, false -> none, null -> null', () => {
    const { rerender } = render(
      <TradeTagsBadges tags={{ orb_agree: true }} side="long" />
    );
    expect(screen.getByText('ORB long')).toBeDefined();

    rerender(<TradeTagsBadges tags={{ orb_agree: false }} side="long" />);
    expect(screen.getByText('no ORB trigger')).toBeDefined();

    rerender(<TradeTagsBadges tags={{ orb_agree: null }} side="long" />);
    expect(screen.getByText('ORB n/a')).toBeDefined();
  });

  it('T2: api payload with tags missing renders n/a without errors', () => {
    const { container } = render(<TradeTagsBadges tags={null} side="long" />);
    expect(screen.getByText('ORB n/a')).toBeDefined();
    expect(screen.getByText('VWAP n/a')).toBeDefined();
    expect(screen.getByText('RS n/a')).toBeDefined();
    expect(screen.getByText('OR n/a')).toBeDefined();
    const naBadges = screen.getAllByText('n/a');
    expect(naBadges.length).toBe(3); // cost, quote, ohlc
    expect(container.querySelectorAll('.is-unknown').length).toBe(7);
  });

  it('T2: no tag count or tag sorting exists in the DOM', () => {
    const mockData = {
      asof: 1794700000000,
      lists: {},
      trades: [
        {
          id: 1,
          day: '2026-11-15',
          symbol: 'INFY',
          kind: 'stock',
          side: 'long' as const,
          score: 80,
          entryAt: 1794701000000,
          entry: 1800,
          cmp: 1810,
          atr: 20,
          buildUp: 'Long build-up',
          reasons: ['Strong volume'],
          levels: { main: { tight: { stop: 1785, t1: 1810, t2: 1820, t3: 1830 }, us: { stop: 1780, t1: 1815, t2: 1830, t3: 1845 } } },
          result: { tight: { outcome: 'pending' as const, time: null, exit_price: null, level: 0, stop_after: null } },
          closed: false,
          tags: {
            orb_side: 'agree',
            vwap_side: 'agree',
            rs_side: 'agree',
            or_side: 'agree',
            cost_ok: true,
            quote_ok: true,
            ohlc_basis: true,
          },
        },
      ],
      minScore: 50,
      recommendedScore: 70,
      rules: { fno: { entries: '09:45-13:30', squareOff: '15:15' } },
      note: 'test',
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });

    const { container } = render(<BuildUpTracker />);

    // Verify no sum/count or sort by tags
    expect(container.textContent).not.toMatch(/\d+\s+of\s+\d+\s+agree/i);
    expect(container.textContent).not.toMatch(/tag\s+score/i);
    expect(container.textContent).not.toMatch(/sort\s+by\s+tags/i);
  });

  it('T2: toggle on in BuildUpTracker -> only ORB badge is coloured; other badges remain neutral', async () => {
    const mockData = {
      asof: 1794700000000,
      lists: {},
      trades: [
        {
          id: 1,
          day: '2026-11-15',
          symbol: 'RELIANCE',
          kind: 'stock',
          side: 'long' as const,
          score: 85,
          entryAt: 1794701000000,
          entry: 2500,
          cmp: 2510,
          atr: 30,
          buildUp: 'Long build-up',
          reasons: ['Strong volume'],
          levels: { main: { tight: { stop: 2470, t1: 2515, t2: 2530, t3: 2545 }, us: { stop: 2460, t1: 2520, t2: 2540, t3: 2560 } } },
          result: { tight: { outcome: 'pending' as const, time: null, exit_price: null, level: 0, stop_after: null } },
          closed: false,
          tags: {
            orb_side: 'agree',
            vwap_side: 'agree',
            rs_side: 'agree',
            or_side: 'agree',
            cost_ok: true,
            quote_ok: true,
            ohlc_basis: true,
          },
        },
      ],
      minScore: 50,
      recommendedScore: 70,
      rules: { fno: { entries: '09:45-13:30', squareOff: '15:15' } },
      note: 'test',
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });

    const { container } = render(<BuildUpTracker />);

    // Wait for tracker to finish loading
    const tradesTab = await screen.findByRole('button', { name: /My trades/i });
    fireEvent.click(tradesTab);

    // Wait for trades tab to display RELIANCE
    await screen.findByText('RELIANCE');

    // Initial state: toggle is OFF
    const toggle = screen.getByLabelText(/Colour tags/i) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(container.querySelectorAll('.is-coloured').length).toBe(0);

    // Turn toggle ON
    act(() => {
      fireEvent.click(toggle);
    });

    expect(toggle.checked).toBe(true);
    // Legend and caption should appear
    expect(screen.getByText(/Colours show only whether a recorded fact points the same way as the trade/i)).toBeDefined();

    // In the trade row, ONLY the ORB badge has .is-coloured (not vwap, rs, or, cost, quote, ohlc)
    const tradeWho = container.querySelector('.mf-ttrade__who');
    expect(tradeWho).toBeDefined();

    const colouredBadges = tradeWho!.querySelectorAll('.is-coloured');
    expect(colouredBadges.length).toBe(1);
    expect(colouredBadges[0].className).toContain('is-orb');
    expect(colouredBadges[0].className).toContain('is-agree');

    // Non-ORB badges in tradeWho must not be coloured
    const nonOrbBadges = tradeWho!.querySelectorAll('.mf-tag-badge:not(.is-orb)');
    nonOrbBadges.forEach(b => {
      expect(b.className).not.toContain('is-coloured');
      expect(b.className).not.toContain('is-agree');
      expect(b.className).not.toContain('is-oppose');
    });
  });

  it('Step 4d: Colour tags toggle state survives reload when localStorage is available', async () => {
    localStorage.setItem('orderFlow:tracker:colourTags', 'true');
    localStorage.setItem('orderFlow:tracker:tab', 'trades');

    const mockData = {
      asof: 1794700000000,
      lists: {},
      trades: [],
      minScore: 50,
      recommendedScore: 70,
      rules: { fno: { entries: '09:45-13:30', squareOff: '15:15' } },
      note: 'test',
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });

    const { unmount } = render(<BuildUpTracker />);
    const toggle = await screen.findByLabelText(/Colour tags/i) as HTMLInputElement;
    expect(toggle.checked).toBe(true);

    // Uncheck and verify persisted to localStorage
    act(() => {
      fireEvent.click(toggle);
    });
    expect(toggle.checked).toBe(false);
    expect(localStorage.getItem('orderFlow:tracker:colourTags')).toBe('false');

    unmount();

    // Re-render and confirm it survives reload as false
    render(<BuildUpTracker />);
    const reloadedToggle = await screen.findByLabelText(/Colour tags/i) as HTMLInputElement;
    expect(reloadedToggle.checked).toBe(false);
  });

  it('Step 4d: Page renders cleanly without errors when localStorage throws', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError: The operation is insecure.');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });

    const mockData = {
      asof: 1794700000000,
      lists: {},
      trades: [],
      minScore: 50,
      recommendedScore: 70,
      rules: { fno: { entries: '09:45-13:30', squareOff: '15:15' } },
      note: 'test',
    };

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => mockData,
    });

    // Should render without throwing
    const { container } = render(<BuildUpTracker />);
    const tradesTab = await screen.findByRole('button', { name: /My trades/i });
    expect(tradesTab).toBeDefined();

    act(() => {
      fireEvent.click(tradesTab);
    });

    const toggle = (await screen.findByLabelText(/Colour tags/i)) as HTMLInputElement;
    expect(toggle.checked).toBe(false);

    // Toggling should also not throw even when setItem throws
    expect(() => {
      act(() => {
        fireEvent.click(toggle);
      });
    }).not.toThrow();
    expect(toggle.checked).toBe(true);
  });
});
