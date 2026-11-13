// Prepares Onyx's own store (accounts.amaete.com) after its PocketBase starts: the "amaete" tenant every person belongs to,
// and, on the first run only, prints the email of whoever is Super Administrator on the games' accounts site, so the same
// person becomes the first Super Administrator here when they first sign in (CORE_OWNER_EMAILS). Nothing secret is printed
// except that email, which install-onyx.sh writes straight into the server's settings file.
// Run by deploy/onyx-install.sh as root: node onyx-seed.mjs <onyx env file> [games core env file] [palasora env file]
import { readEnvFile } from '../lib/config.mjs';
import { existsSync } from 'node:fs';

const [envFile, gamesEnv, palEnv] = process.argv.slice(2);
const env = readEnvFile(envFile);
async function client(url, email, password) {
  const call = async (method, path, body, token) => {
    const r = await fetch(url + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: token } : {}) }, body: body && JSON.stringify(body) });
    if (!r.ok) throw new Error(`${method} ${path.split('?')[0]}: ${r.status}`);
    return r.json();
  };
  const { token } = await call('POST', '/api/collections/_superusers/auth-with-password', { identity: email, password });
  return (method, path, body) => call(method, path, body, token);
}
const onyx = await client(env.PB_URL, env.PB_CORE_EMAIL, env.PB_CORE_PASSWORD);
const slug = env.CORE_REALM_SLUG || 'amaete';
const have = (await onyx('GET', `/api/collections/tenants/records?filter=${encodeURIComponent(`slug='${slug}'`)}`)).items[0];
if (!have) await onyx('POST', '/api/collections/tenants/records', { slug, name: env.CORE_BRAND || 'Amaete', status: 'active' });
console.error(`Onyx store: tenant "${slug}" ${have ? 'ready' : 'made'}.`);

// the games' Super Administrator(s), read with Palasora's service account (only when this site has no owner set yet)
if (!env.CORE_OWNER_EMAILS && gamesEnv && palEnv && existsSync(gamesEnv) && existsSync(palEnv)) {
  const pal = readEnvFile(palEnv), games = readEnvFile(gamesEnv);
  const g = await client(games.PB_URL || 'http://127.0.0.1:8190', pal.PB_SERVICE_EMAIL, pal.PB_SERVICE_PASSWORD);
  const rows = (await g('GET', `/api/collections/nv_roles/records?perPage=20&filter=${encodeURIComponent("product='platform' && role='super_admin'")}`)).items;
  const emails = [];
  for (const r of rows) { const u = await g('GET', `/api/collections/users/records/${r.user_id}`).catch(() => null); if (u?.email) emails.push(String(u.email).toLowerCase()); }
  process.stdout.write(emails.join(','));
}
