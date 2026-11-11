// Saved items: each person keeps their own things in each product, up to the free limit or the pass limit; nobody reads
// another person's or another product's; a product hosted elsewhere signs in with the hash of its secret in clients.json.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, CLIENTS, SECRETS, api } from './helpers.mjs';
import { loadConfig } from '../lib/config.mjs';
import { sha } from '../lib/util.mjs';

const SHOP = { id: 'shop', name: 'Shop', product: 'shop', guests: false, color: '#333', home: 'https://shop.test', redirect_uris: ['https://shop.test/cb'],
  secretHash: sha(SECRETS.shop), items: { kinds: ['build', 'plan'], free: 2, pass: 5, max_kb: 2 },
  pass: { name: 'Pro', plans: { month: { cents: 4999, interval: 'month', count: 1, name: 'Monthly', on: true, trial_days: 14 } } } };
const calls = [];
let t;
before(async () => {
  t = await start({ clients: { ...CLIENTS, shop: SHOP }, stripe: { key: 'sk_test_x', hook: 'whsec_x', prices: {} },
    fetchStub: async (url, opts) => { calls.push({ url: String(url), body: String(opts.body) }); return new Response(JSON.stringify({ url: 'https://checkout.stripe.test/s2' }), { status: 200 }); } });
});
after(() => t.stop());
const person = async () => (await api(t, CLIENTS.agp, 'POST', '/v1/guests', {})).body.user.id;
const shop = (m, p, b) => api(t, SHOP, m, p, b);

test('save, list, open, rename and delete; the shelf fills at the free limit', async () => {
  const uid = await person();
  let r = await shop('POST', '/v1/items', { user_id: uid, kind: 'build', name: '  My   house ', data: { boxes: [1, 2] }, thumb: 'data:image/png;base64,iVBOR=' });
  assert.equal(r.status, 201);
  const id = r.body.item.id;
  assert.equal(r.body.item.name, 'My house');
  r = await shop('GET', `/v1/items?user_id=${uid}`);
  assert.equal(r.body.items.length, 1); assert.equal(r.body.used, 1); assert.equal(r.body.limit, 2); assert.equal(r.body.pass, false);
  assert.equal(r.body.items[0].data, undefined, 'the list leaves the data out');
  assert.equal(r.body.items[0].thumb, 'data:image/png;base64,iVBOR=');
  r = await shop('GET', `/v1/items/${id}?user_id=${uid}`);
  assert.deepEqual(r.body.item.data, { boxes: [1, 2] });
  r = await shop('POST', '/v1/items', { user_id: uid, id, kind: 'build', name: 'Renamed', data: { boxes: [3] } });
  assert.equal(r.status, 200); assert.equal(r.body.item.name, 'Renamed');
  assert.equal((await shop('POST', '/v1/items', { user_id: uid, kind: 'plan', name: 'P', data: {} })).status, 201);
  r = await shop('POST', '/v1/items', { user_id: uid, kind: 'plan', name: 'P2', data: {} });
  assert.equal(r.status, 402); assert.equal(r.body.error.code, 'LIMIT'); assert.equal(r.body.limit, 2);
  assert.equal((await shop('GET', `/v1/items?user_id=${uid}&kind=plan`)).body.items.length, 1);
  assert.equal((await shop('DELETE', `/v1/items/${id}`, { user_id: uid })).status, 200);
  assert.equal((await shop('GET', `/v1/items/${id}?user_id=${uid}`)).status, 404);
});

test('nobody reads or changes another person\'s or another product\'s items; bad input is refused', async () => {
  const a = await person(), b = await person();
  const id = (await shop('POST', '/v1/items', { user_id: a, kind: 'build', name: 'A', data: { x: 1 } })).body.item.id;
  assert.equal((await shop('GET', `/v1/items/${id}?user_id=${b}`)).status, 404);
  assert.equal((await shop('POST', '/v1/items', { user_id: b, id, kind: 'build', name: 'B', data: {} })).status, 404);
  assert.equal((await shop('DELETE', `/v1/items/${id}`, { user_id: b })).status, 404);
  assert.equal((await api(t, CLIENTS.agp, 'GET', `/v1/items?user_id=${a}`)).status, 403, 'a product without items has no shelf');
  assert.equal((await shop('POST', '/v1/items', { user_id: a, kind: 'car', name: 'X', data: {} })).status, 400);
  assert.equal((await shop('POST', '/v1/items', { user_id: a, kind: 'build', name: 'X', data: { s: 'x'.repeat(3000) } })).status, 413);
  assert.equal((await shop('GET', '/v1/items?user_id=nope')).status, 404);
  const r = await shop('POST', '/v1/items', { user_id: a, kind: 'build', name: 'T', data: {}, thumb: 'javascript:alert(1)' });
  assert.equal(r.body.item.thumb, '', 'only image data is kept as a thumbnail');
});

test('the pass raises the limit; checkout offers the trial, comes back to the given page and never to another site', async () => {
  const uid = await person();
  await t.pb.create('nv_passes', { user_id: uid, product: 'shop', plan: 'month', until_ms: Date.now() + 864e5, renews: true, source: 'test' });
  assert.equal((await shop('GET', `/v1/items?user_id=${uid}`)).body.limit, 5);
  const fresh = await person();
  let r = await shop('GET', `/v1/pass?user_id=${fresh}`);
  assert.equal(r.body.plans[0].trial_days, 14);
  calls.length = 0;
  r = await shop('POST', '/v1/pass/checkout', { user_id: fresh, plan: 'month', back: '/studio/' });
  assert.equal(r.status, 200);
  let sent = new URLSearchParams(calls.at(-1).body);
  assert.equal(sent.get('success_url'), 'https://shop.test/studio/?pass=ok');
  assert.equal(sent.get('subscription_data[trial_period_days]'), '14');
  await shop('POST', '/v1/pass/checkout', { user_id: fresh, plan: 'month', back: '//evil.test/x' });
  sent = new URLSearchParams(calls.at(-1).body);
  assert.equal(sent.get('success_url'), 'https://shop.test/?pass=ok');
  await shop('POST', '/v1/pass/checkout', { user_id: uid, plan: 'month' });
  assert.equal(new URLSearchParams(calls.at(-1).body).get('subscription_data[trial_period_days]'), null, 'no second trial');
});

test('a trial checkout grants the pass for the trial days', async () => {
  const uid = await person();
  const ev = { id: 'evt_trial_' + uid, type: 'checkout.session.completed', data: { object: { mode: 'subscription', payment_status: 'no_payment_required', metadata: { uid, plan: 'month', game: 'shop' }, subscription: 'sub_t' + uid, customer: 'cus_t' } } };
  const r = await t.core.billing.event(ev);
  assert.ok(r.active);
  assert.ok(r.until > Date.now() + 14 * 864e5 && r.until < Date.now() + 17 * 864e5);
});

test('a product hosted elsewhere is known by the hash of its secret, and the deploy makes no secret for it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nvcl-')), file = join(dir, 'clients.json');
  writeFileSync(file, JSON.stringify({ clients: [{ id: 'away', name: 'Away', product: 'away', redirect_uris: ['https://away.test/cb'], secret_sha256: sha('s3cret') }, { id: 'here', name: 'Here', product: 'here', redirect_uris: ['https://here.test/cb'] }] }));
  const cfg = loadConfig({ CORE_CLIENTS_FILE: file, CORE_CLIENT_SECRETS_DIR: dir });
  assert.equal(cfg.clients.away.secretHash, sha('s3cret'));
  assert.equal(cfg.clients.here.secretHash, null);
});
