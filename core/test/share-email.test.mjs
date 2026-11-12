// A product that keeps its own accounts (SavvyMe, Isoteh) gets the verified email with "share_email": true, so it can
// find the account a person already made there. Every other product still never sees an email.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, browser, authorizeUrl, emailSignIn, exchange, api, CLIENTS, SECRETS } from './helpers.mjs';
import { resetLimits, sha } from '../lib/util.mjs';

SECRETS.savvyme = 'savvyme-test-secret-0123456789';
const savvyme = { id: 'savvyme', name: 'SavvyMe', product: 'savvyme', guests: false, home: 'https://savvyme.test',
  redirect_uris: ['https://savvyme.test/cb'], share_email: true, secretHash: sha(SECRETS.savvyme) };
let t;
before(async () => { t = await start({ clients: { ...CLIENTS, savvyme } }); });
after(() => t?.stop());
const uniq = () => Math.random().toString(36).slice(2, 8);

test('email code on the product screen: the sharing product gets the email, others do not', async () => {
  resetLimits();
  const email = `Kofi.${uniq()}@Example.com`;
  assert.equal((await api(t, savvyme, 'POST', '/v1/signin/email/start', { email, ip: '10.2.0.1' })).status, 200);
  const v = await api(t, savvyme, 'POST', '/v1/signin/email/verify', { email, code: t.cfg.mail.last.code });
  assert.equal(v.status, 200);
  assert.equal(v.body.user.email, email.toLowerCase());
  const p = await api(t, savvyme, 'POST', '/v1/signin/profile', { ticket: v.body.ticket, display_name: 'Kofi', handle: 'kofi_' + uniq() });
  assert.equal(p.body.user.email, email.toLowerCase(), 'still there after the name step');

  await api(t, CLIENTS.agp, 'POST', '/v1/signin/email/start', { email, ip: '10.2.0.2' });
  const a = await api(t, CLIENTS.agp, 'POST', '/v1/signin/email/verify', { email, code: t.cfg.mail.last.code });
  assert.equal(a.body.user.id, v.body.user.id, 'one account across products');
  assert.equal(a.body.user.email, undefined, 'a product without share_email never sees it');
});

test('redirect sign-in: the token answer carries the email only for the sharing product', async () => {
  resetLimits();
  const b = browser(t.base), email = `ama.${uniq()}@example.com`;
  const s = await emailSignIn(t, b, savvyme, email);
  const x = await exchange(t, savvyme, s.final, s.verifier);
  assert.equal(x.status, 200);
  assert.equal(x.body.user.email, email);
  const o = authorizeUrl(CLIENTS.palasora);
  const y = await exchange(t, CLIENTS.palasora, await b.get(o.url), o.verifier);
  assert.equal(y.body.user.id, x.body.user.id);
  assert.equal(y.body.user.email, undefined);
});
