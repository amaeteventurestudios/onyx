// Starts Novenique Core: node core/server.mjs (settings from the environment; see lib/config.mjs).
import { loadConfig } from './lib/config.mjs';
import { makeCore } from './lib/app.mjs';

const cfg = loadConfig();
const core = makeCore(cfg);
for (let i = 1; ; i++) {   // the database may still be starting after a reboot
  try { await core.ensureSchema(); await core.accounts.realm(); break; }
  catch (e) { if (i >= 30) throw e; console.error(`waiting for the database (${e.message})`); await new Promise((r) => setTimeout(r, 2000)); }
}
await core.listen();
// the email block's background work: scheduled newsletters, newsletters going out in batches, automation steps
setInterval(() => core.email.tick().catch((e) => console.error('[email] tick', e.message)), Number(process.env.MAIL_TICK_SECONDS || 30) * 1000).unref?.();
console.log(`${cfg.brand} accounts on http://${cfg.host}:${cfg.port} (${cfg.mode}; public ${cfg.publicUrl}; Google ${cfg.google ? 'on' : 'off'}; email ${cfg.mail.on ? cfg.mail.provider : 'off'})`);
