/** `npm run dev`: the API (server/index.mjs) and Vite together; Vite proxies data to the API. */
import { spawn } from 'node:child_process';
import path from 'node:path';

const VITE_BIN = path.resolve('node_modules/vite/bin/vite.js');
const run = (args) => spawn(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });

// `npm run dev:recorded` replays a recorded real session instead of the demo market.
const api = run(['server/index.mjs', ...process.argv.slice(2)]);
const web = run([VITE_BIN]);

const stop = () => {
  try { api.kill(); } catch {}
  try { web.kill(); } catch {}
  process.exit();
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
api.on('exit', code => { if (code) { console.error(`API exited (${code})`); try { web.kill(); } catch {} process.exit(code); } });
web.on('exit', code => { try { api.kill(); } catch {} process.exit(code ?? 0); });
