/**
 * Order Flow's server: the page's only data source, and its host.
 *
 *   GET /api/status                  which provider, its clock, what the last build did
 *   GET /api/market                  the market file: every underlying's nearest-expiry chain
 *   GET /api/market/<date>/<HHMM>    an earlier minute of today (the 15m / 1h windows)
 *   GET /api/futures/<SYMBOL>?session=YYYY-MM-DD   its futures months and 1-minute candles
 *   GET /*                           the built page from dist/ (npm run build)
 *
 * Where the numbers come from is a provider (server/providers): the built-in
 * demo market by default, or a broker adapter chosen with MF_PROVIDER. The
 * collector asks the provider for each underlying's expiries once a session
 * and its nearest live chain each minute, eight at a time, and writes the
 * market file. Futures are read on demand and kept briefly. Session rules
 * (holidays, the close, settled expiries) come from the page's own
 * src/lib/marketSession.ts, so the server and the page never disagree.
 *
 *   PORT=8787  HOST=127.0.0.1  MF_PROVIDER=demo  MF_DATA_DIR=server/data
 *
 * Security. It listens on this machine only (HOST=127.0.0.1) unless told
 * otherwise. MF_BASIC_AUTH=user:password puts every route behind a password.
 * Only GET and HEAD; only the routes below; the futures route reads only the
 * current session; no cross-origin reads unless MF_CORS_ORIGIN names one;
 * strict security headers on every answer; provider errors are logged here,
 * never sent to the browser.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeSeries, marketFile } from './marketFile.mjs';
import { createProvider } from './providers/index.mjs';
import { marketParts } from '../src/lib/marketSession.ts';
import { SESSION_PROFILES, segmentOfExchange } from '../src/lib/segmentSession.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8787;
const HOST = process.env.HOST || '127.0.0.1';
const AUTH = process.env.MF_BASIC_AUTH || '';
const CORS_ORIGIN = process.env.MF_CORS_ORIGIN || '';
if (AUTH && !/^[^:]+:.{8,}$/.test(AUTH)) throw new Error('MF_BASIC_AUTH must be user:password, with a password of at least 8 characters.');
const DATA_DIR = path.resolve(ROOT, process.env.MF_DATA_DIR || 'server/data');
const DIST = path.join(ROOT, 'dist');
const WORKERS = 8;
/** A futures read is kept this long: the page asks again every two minutes. */
const FUTURES_KEEP_MS = 60_000;

const log = (...args) => console.log(new Date().toISOString(), ...args);

const universe = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/underlyings.json'), 'utf8')).underlyings
  .filter(u => u && typeof u.symbol === 'string' && u.lot > 0);
const bySymbol = new Map(universe.map(u => [u.symbol, u]));
// `--recorded` (npm run dev:recorded / start:recorded) and `--archive` (npm run dev:archive) are shortcuts for MF_PROVIDER.
const flagged = ['recorded', 'archive'].find(id => process.argv.includes(`--${id}`));
const provider = createProvider(universe, flagged);
const SCAN_DIR = path.join(DATA_DIR, provider.id);

// ── Collectors: one per segment, each on its own clock ─────────────────────────

/**
 * The board has one collector per exchange segment. `fno` (NSE and BSE F&O) is what the server always did; `mcx` (commodities) runs the
 * same build on MCX's session: its own session date, live hours, expiry cut-off, and its own stored minutes. A provider says which
 * segments it can supply (`provider.segments`, default `['fno']`); a segment it does not supply is simply not served, never faked.
 */
const SEGMENTS = provider.segments ?? ['fno'];
const clockOf = segment => (provider.now ? provider.now(segment) : Date.now());

function makeCollector(id) {
  const profile = SESSION_PROFILES[id];
  const rows = universe.filter(u => segmentOfExchange(u.exch) === id);
  return {
    id, profile, rows,
    enabled: SEGMENTS.includes(id) && rows.length > 0,
    /** The F&O segment keeps its original folder, so a restart still finds the day's stored minutes. */
    dir: id === 'fno' ? SCAN_DIR : path.join(SCAN_DIR, id),
    /** Expiries are read once a session: they change only when a contract lists or expires. */
    ladderCache: { session: '', bySymbol: new Map() },
    state: { ready: false, building: false, latestJson: null, latest: null, lastBuild: null, lastError: null },
    now() { return clockOf(id); },
    isLive() { return provider.alwaysLive || profile.isSessionTime(Date.now()); },
    session() { return profile.latestSessionDate(new Date(clockOf(id))); },
  };
}
const collectors = { fno: makeCollector('fno'), mcx: makeCollector('mcx') };
const collectorOf = segment => collectors[segment === 'mcx' ? 'mcx' : 'fno'];
const collectorForSymbol = symbol => collectorOf(segmentOfExchange(bySymbol.get(symbol)?.exch));

const hhmmOf = at => { const p = marketParts(at); return `${String(Math.floor(p.minuteOfDay / 60)).padStart(2, '0')}${String(p.minuteOfDay % 60).padStart(2, '0')}`; };

/** A collector's stored minutes for a date, ascending, as [HHMM, epoch ms]: an index beside them, not a read of every file. */
function readMinutes(c, date) {
  try { return JSON.parse(fs.readFileSync(path.join(c.dir, date, 'index.json'), 'utf8')); } catch { return []; }
}
function storeMinute(c, date, at, json) {
  const dir = path.join(c.dir, date);
  fs.mkdirSync(dir, { recursive: true });
  const hhmm = hhmmOf(at);
  fs.writeFileSync(path.join(dir, `${hhmm}.json`), json);
  const minutes = readMinutes(c, date).filter(entry => entry[0] !== hhmm);
  minutes.push([hhmm, at]);
  minutes.sort((a, b) => a[1] - b[1]);
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify(minutes));
  return minutes;
}

async function build(c) {
  const { state, ladderCache, profile } = c;
  if (!c.enabled || state.building) return;
  state.building = true;
  const started = Date.now();
  const clock = c.now();
  const session = profile.latestSessionDate(new Date(clock));
  if (ladderCache.session !== session) { ladderCache.session = session; ladderCache.bySymbol.clear(); }
  const series = [];
  const ladders = {};
  const failed = [];
  let firstError = null;
  let cursor = 0;
  const worker = async () => {
    while (cursor < c.rows.length) {
      const u = c.rows[cursor++];
      try {
        let ladder = ladderCache.bySymbol.get(u.symbol);
        if (!ladder) {
          ladder = await provider.expiries(u);
          if (ladder.length) ladderCache.bySymbol.set(u.symbol, ladder);
        }
        const live = profile.filterLiveExpiries(ladder, clock);
        ladders[u.symbol] = live;
        if (!live[0]) continue;
        const chain = await provider.optionChain(u, live[0]);
        const encoded = encodeSeries(u, { ...chain, expiry: chain.expiry || live[0] }, c.now());
        if (encoded) series.push(encoded); else failed.push(u.symbol);
      } catch (error) {
        failed.push(u.symbol);
        firstError ??= String(error?.message || error);
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: WORKERS }, worker));
    if (!series.length) throw new Error(firstError ? `No underlying answered: ${firstError}` : 'No underlying answered.');
    const at = c.now();
    const sorted = series.sort((a, b) => a.s.localeCompare(b.s));
    // Only a reading taken in session is a minute the windows can measure from.
    const minutes = profile.isSessionTime(at)
      ? storeMinute(c, session, at, JSON.stringify(marketFile({ at, date: session, series: sorted, minutes: [], ladders })))
      : readMinutes(c, session);
    const file = marketFile({ at, date: session, series: sorted, minutes, ladders });
    state.latest = file;
    state.latestJson = JSON.stringify(file);
    fs.mkdirSync(c.dir, { recursive: true });
    fs.writeFileSync(path.join(c.dir, 'latest.json'), state.latestJson);
    pruneOldDays(c, session);
    state.lastBuild = { at, ms: Date.now() - started, series: series.length, failed: failed.length, failedSymbols: failed.slice(0, 20), firstError };
    state.lastError = null;
    log(`${c.id} market file: ${series.length} series, ${failed.length} failed, ${Date.now() - started} ms${firstError ? ` (first error: ${firstError})` : ''}`);
  } catch (error) {
    // The detail (which may quote the provider's own error) stays in this log; the page gets a plain line.
    log(`${c.id} market file failed:`, String(error?.message || error));
    state.lastError = { at: Date.now(), message: 'The data provider did not answer. The server log has the detail.' };
  } finally {
    state.building = false;
  }
}

/** Earlier sessions' minutes are never read again: keep today only. */
function pruneOldDays(c, today) {
  if (!fs.existsSync(c.dir)) return;
  for (const entry of fs.readdirSync(c.dir)) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(entry) && entry < today) fs.rmSync(path.join(c.dir, entry), { recursive: true, force: true });
  }
}

/** Live (in this segment's session, or a provider that is always live): every minute, a few seconds past the boundary. Otherwise every 5 minutes:
 *  an hourly wait could straddle the open (or follow a build that failed while the feed was still warming up) and leave the board empty for up to an hour. */
function schedule(c) {
  const wait = c.isLive() ? 60_000 - (Date.now() % 60_000) + 3_000 : 5 * 60_000;
  setTimeout(async () => { await build(c); schedule(c); }, wait);
}

// ── Futures, on demand ──────────────────────────────────────────────────────

const futuresCache = new Map();
let trackerCachedAt = 0;
async function futuresFor(c, symbol, session) {
  const key = `${symbol}|${session}`;
  const held = futuresCache.get(key);
  const live = c.isLive();
  if (held && (!live || Date.now() - held.at < FUTURES_KEEP_MS)) return held.value;
  const value = provider.futures(bySymbol.get(symbol), session).then(months => ({ symbol, session, months }));
  futuresCache.set(key, { at: Date.now(), value });
  value.catch(() => futuresCache.delete(key));
  if (futuresCache.size > 4000) futuresCache.delete(futuresCache.keys().next().value);
  return value;
}
  // After the close an answer is kept for the rest of the session, so one without its previous close (the service had not ticked yet) must not be.
  value.then(v => { if (!v.months?.some(m => m.prevClose != null)) futuresCache.delete(key); }, () => {});

// ── HTTP ──────────────────────────────────────────────────────────────────

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ico': 'image/x-icon' };

/** On every answer. The page loads nothing from elsewhere, so the policy allows only this origin. */
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': CORS_ORIGIN ? 'cross-origin' : 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  ...(CORS_ORIGIN ? { 'Access-Control-Allow-Origin': CORS_ORIGIN, Vary: 'Origin' } : {}),
};

function send(res, status, body, type = 'application/json', extra = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function serveFile(res, file, cache = 'no-cache') {
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': cache });
  const stream = fs.createReadStream(file);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/** Basic auth, compared in constant time; on when MF_BASIC_AUTH is set. */
const authDigest = AUTH ? crypto.createHash('sha256').update(AUTH).digest() : null;
function authorised(req) {
  if (!authDigest) return true;
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const given = crypto.createHash('sha256').update(Buffer.from(header.slice(6), 'base64').toString('utf8')).digest();
  return crypto.timingSafeEqual(given, authDigest);
}

/** A path under `base`, or null when it would leave it. */
function inside(base, rel) {
  const full = path.normalize(path.join(base, rel));
  return full.startsWith(base + path.sep) || full === base ? full : null;
}

const server = http.createServer((req, res) => {
  // A bad request never takes the server down: anything thrown is answered, and logged here.
  handle(req, res).catch(error => {
    log('request failed:', req.method, String(req.url).slice(0, 200), error?.message || error);
    if (!res.headersSent) send(res, 500, { error: 'Something went wrong.' });
    else res.destroy();
  });
});
// Slow or idle clients are cut off rather than held open.
server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.keepAliveTimeout = 5_000;

async function handle(req, res) {
  if (!authorised(req)) return send(res, 401, { error: 'Sign in.' }, 'application/json', { 'WWW-Authenticate': 'Basic realm="Order Flow", charset="UTF-8"' });
  if (req.method === 'OPTIONS' && CORS_ORIGIN) return send(res, 204, '', 'text/plain', { 'Access-Control-Allow-Methods': 'GET, HEAD', 'Access-Control-Max-Age': '600' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Use GET.' }, 'application/json', { Allow: 'GET, HEAD' });
  let url;
  let p;
  try {
    url = new URL(req.url, 'http://localhost');
    p = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, { error: 'Bad request.' });
  }
  if (p.includes('\0')) return send(res, 400, { error: 'Bad request.' });

  // One answer per segment. `fno` is the original shape at the top level (older pages read only that); `segments` has each one.
  const statusOf = c => ({
    enabled: c.enabled, ready: c.state.ready, clock: c.now(), session: c.session(), live: Boolean(c.isLive()), open: c.profile.isSessionTime(c.now()),
    market: c.state.latest ? { at: c.state.latest.t, date: c.state.latest.date, series: c.state.latest.series.length } : null,
    lastBuild: c.state.lastBuild && { at: c.state.lastBuild.at, series: c.state.lastBuild.series, failed: c.state.lastBuild.failed },
    lastError: c.state.lastError && { at: c.state.lastError.at, message: c.state.lastError.message }, underlyings: c.rows.length,
  });
  if (p === '/api/status') {
    const main = statusOf(collectors.fno);
    return send(res, 200, {
      provider: { id: provider.id, label: provider.label, alwaysLive: Boolean(provider.alwaysLive) },
      ready: main.ready, clock: main.clock, session: main.session, market: main.market, lastBuild: main.lastBuild, lastError: main.lastError,
      universe: universe.length,
      segments: { fno: main, mcx: statusOf(collectors.mcx) },
    });
  }

  // `?segment=mcx` picks the commodity board; the default is NSE/BSE F&O.
  const segmentParam = url.searchParams.get('segment');
  if (segmentParam !== null && segmentParam !== 'fno' && segmentParam !== 'mcx') return send(res, 400, { error: 'Unknown segment.' });
  const c = collectorOf(segmentParam);
  const unsupplied = () => send(res, 404, { error: `${provider.label} does not supply ${c.profile.label} data.` });

  if (p === '/api/market') {
    if (!c.enabled) return unsupplied();
    if (!c.state.latestJson) return send(res, 503, { error: c.state.lastError?.message ?? 'The first market file is still being built.' }, 'application/json', { 'Retry-After': '5' });
    return send(res, 200, c.state.latestJson);
  }
  const minute = p.match(/^\/api\/market\/(\d{4}-\d{2}-\d{2})\/(\d{4})$/);
  if (minute) {
    if (!c.enabled) return unsupplied();
    const file = path.join(c.dir, minute[1], `${minute[2]}.json`);
    return fs.existsSync(file) ? serveFile(res, file, 'public, max-age=86400') : send(res, 404, { error: 'No such minute.' });
  }

  const futures = p.match(/^\/api\/futures\/([A-Za-z0-9&._-]{1,40})$/);
  if (futures) {
    const symbol = futures[1].toUpperCase();
    if (!bySymbol.has(symbol)) return send(res, 404, { error: 'Unknown underlying.' });
    // The symbol decides the segment, and so the clock: a commodity's current session is MCX's, not NSE's.
    const owner = collectorForSymbol(symbol);
    if (!owner.enabled) return send(res, 404, { error: `${provider.label} does not supply ${owner.profile.label} data.` });
    // Only the current session: the page never asks for another, and no visitor can spend the provider's quota on history.
    const current = owner.session();
    const session = url.searchParams.get('session') ?? current;
    if (session !== current) return send(res, 400, { error: `Only the current session (${current}) is served.` });
    try {
      return send(res, 200, await futuresFor(owner, symbol, session));
    } catch (error) {
      log(`futures ${symbol} failed:`, error?.message || error);
      return send(res, 502, { error: 'The data provider did not answer for this underlying.' });
    }
  }

  if (p === '/underlyings.json') return serveFile(res, path.join(ROOT, 'public/underlyings.json'), 'public, max-age=3600');

  // The built page; any other path is the page itself (its router is in memory).
  if (fs.existsSync(DIST)) {
  // The tracker is the feed service's own (scored and judged with the India F&O app's functions): pass its answer through unchanged. The last good
  // answer is kept on disk, so while the feed service is down (a weekend, a restart, a failed login) the recorded trades are still readable, marked
  // `stale` with the time they were last read. Nothing in it is refreshed or invented.
  if (p === '/api/tracker') {
    const base = (process.env.MF_HTTP_BASE_URL || '').replace(/\/+$/, '');
    if (!base) return send(res, 404, { error: 'The tracker needs the live feed service (MF_HTTP_BASE_URL).' });
    const cacheFile = path.join(DATA_DIR, 'tracker-cache.json');
    try {
      const upstream = await fetch(`${base}/tracker`, { signal: AbortSignal.timeout(8000) });
      const body = await upstream.json();
      if (upstream.ok && !body?.error && Date.now() - trackerCachedAt > 60_000) {
        trackerCachedAt = Date.now();
        try {
          fs.mkdirSync(DATA_DIR, { recursive: true });
          fs.writeFileSync(cacheFile, JSON.stringify({ cachedAt: trackerCachedAt, body }));
        } catch (error) { log('tracker cache not saved:', error?.message || error); }
      }
      return send(res, upstream.status, body);
    } catch (error) {
      log('tracker failed:', error?.message || error);
      try {
        const held = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
        return send(res, 200, { ...held.body, stale: { cachedAt: held.cachedAt, reason: 'The live feed service did not answer.' } });
      } catch {
        return send(res, 502, { error: 'The tracker did not answer.' });
      }
    }
  }

    const file = inside(DIST, p === '/' ? 'index.html' : p.slice(1));
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return serveFile(res, file, p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    return serveFile(res, path.join(DIST, 'index.html'));
  }
  send(res, 404, { error: 'Not found. Run `npm run build` to serve the page from here, or `npm run dev`.' });
}

// Start from the file on disk so a restart serves at once.
for (const c of Object.values(collectors)) {
  try {
    c.state.latestJson = fs.readFileSync(path.join(c.dir, 'latest.json'), 'utf8');
    c.state.latest = JSON.parse(c.state.latestJson);
  } catch { /* first run */ }
}

const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
server.listen(PORT, HOST, async () => {
  log(`Order Flow on http://${HOST.includes(':') ? `[${HOST}]` : HOST}:${PORT} · provider: ${provider.label} (${provider.id}) · ${universe.length} underlyings${AUTH ? ' · password on' : ''}`);
  if (!LOOPBACK.includes(HOST) && !AUTH) log('WARNING: listening beyond this machine with no password. Set MF_BASIC_AUTH=user:password, or put the server behind a proxy that signs people in.');
  const active = Object.values(collectors).filter(c => c.enabled);
  try {
    await provider.init?.();
    for (const c of active) c.state.ready = true;
  } catch (error) {
    for (const c of active) c.state.lastError = { at: Date.now(), message: `Provider failed to start: ${error?.message || error}` };
    log(`Provider failed to start: ${error?.message || error}`);
    return;
  }
  for (const c of active) {
    await build(c);
    schedule(c);
  }
  const skipped = Object.values(collectors).filter(c => !c.enabled && c.rows.length);
  if (skipped.length) log(`${provider.label} does not supply: ${skipped.map(c => `${c.profile.label} (${c.rows.length} underlyings)`).join(', ')}`);
});
