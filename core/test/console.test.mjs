// The console: the owner becomes Super Administrator on first sign-in (CORE_OWNER_EMAILS), needs the second step, then sees
// every product, the people who signed up and where, and can download them. Other people are turned away.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, browser, csrfOf, emailSignIn, exchange, CLIENTS } from './helpers.mjs';
import { resetLimits } from '../lib/util.mjs';
import * as totp from '../lib/totp.mjs';

let t;
const OWNER = 'owner@example.com';
before(async () => { t = await start({ brand: 'Amaete', owners: [OWNER] }); });
after(() => t.stop());
const uniq = () => Math.random().toString(36).slice(2, 8);

async function signInHere(b, email, handle) {
  let r = await b.get('/console');
  assert.equal(r.location, '/signin');
  r = await b.get('/signin');
  assert.match(r.html, /Amaete/);
  r = await b.post('/email/start', { csrf: csrfOf(r.html), email });
  r = await b.post('/email/verify', { csrf: csrfOf(r.html), code: t.cfg.mail.last.code });
  if (r.location === '/profile') { const p = await b.get('/profile'); r = await b.post('/profile', { csrf: csrfOf(p.html), display_name: 'Owner', handle }); }
  return r;
}

test('people from two products, then the owner opens the console', async () => {
  resetLimits();
  const ada = `ada.${uniq()}@example.com`, bo = `bo.${uniq()}@example.com`;
  const a = await emailSignIn(t, browser(t.base), CLIENTS.agp, ada);
  await exchange(t, CLIENTS.agp, a.final, a.verifier);
  const b1 = await emailSignIn(t, browser(t.base), CLIENTS.palasora, bo);
  await exchange(t, CLIENTS.palasora, b1.final, b1.verifier);
  // Bo later signs in on the other product too
  const b2 = await emailSignIn(t, browser(t.base), CLIENTS.agp, bo);
  await exchange(t, CLIENTS.agp, b2.final, b2.verifier);

  resetLimits();
  const ob = browser(t.base);
  const r = await signInHere(ob, OWNER, 'kemi_' + uniq());
  assert.equal(r.location, '/console');
  // Super Administrator now, but the console waits for the second step
  let page = await ob.get('/console');
  assert.equal(page.location, '/account?setup=mfa');
  page = await ob.get('/account?setup=mfa');
  assert.match(page.html, /console needs the second sign-in step/);
  assert.match(page.html, /Open the console/);
  page = await ob.post('/account/mfa/setup', { csrf: csrfOf(page.html) });
  assert.match(page.html, /issuer=Amaete/);
  const secret = page.html.match(/<code>([A-Z2-7]+)<\/code>/)[1];
  page = await ob.post('/account/mfa/enable', { csrf: csrfOf(page.html), code: totp.totp(secret) });
  assert.match(page.html, /Second step is on/);

  page = await ob.get('/console');
  assert.equal(page.status, 200);
  assert.match(page.html, /Amaete console/);
  assert.ok(page.html.includes(ada) && page.html.includes(bo), 'both emails listed in full');
  assert.match(page.html, /Agent Grand Prix/);

  // filter by product: Ada only used Agent Grand Prix
  page = await ob.get('/console?product=palasora');
  assert.ok(page.html.includes(bo) && !page.html.includes(ada));
  page = await ob.get('/console?q=' + encodeURIComponent(ada));
  assert.ok(page.html.includes(ada) && !page.html.includes(bo));

  const csv = await ob.get('/console/people.csv?product=agp');
  assert.equal(csv.status, 200);
  const lines = csv.html.trim().split('\r\n');
  assert.equal(lines[0], 'name,handle,email,signs_in_with,first_joined_from,uses,joined,last_sign_in');
  assert.ok(lines.some((l) => l.includes(ada) && l.includes('Agent Grand Prix')));
  assert.ok(lines.some((l) => l.includes(bo) && l.includes('Palasora; Agent Grand Prix')), 'Bo joined on Palasora and uses both');
});

test('the owner setting only makes the first Super Administrator', async () => {
  const rows = await t.pb.list('nv_roles', { filter: "role='super_admin'", perPage: 10 });
  assert.equal(rows.length, 1);
});

test('someone without a staff role is turned away, and nobody signed out gets in', async () => {
  resetLimits();
  assert.equal((await browser(t.base).get('/console/people.csv')).location, '/signin');
  const b = browser(t.base);
  await signInHere(b, `cy.${uniq()}@example.com`, 'cy_' + uniq());
  const page = await b.get('/console');
  assert.equal(page.status, 403);
  assert.equal((await b.get('/console/people.csv')).status, 403);
});
