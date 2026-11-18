// The people admin: the owner (platform Super Administrator) runs a product's people at /admin/<product>; invitations are
// emailed and become a role on the invited person's first sign-in to the product; the product reads the role from /token
// and the /v1 people calls; admins, support and a customer's admins each see and do only what the role table allows.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, browser, csrfOf, emailSignIn, exchange, api, CLIENTS, SECRETS } from './helpers.mjs';
import { resetLimits, sha } from '../lib/util.mjs';
import * as totp from '../lib/totp.mjs';

let t;
const OWNER = 'owner@example.com';
const SHOP = { id: 'shop', name: 'Shop', product: 'shop', guests: false, color: '#ED4B44', home: 'https://shop.test', redirect_uris: ['https://shop.test/cb'],
  secretHash: sha(SECRETS.shop), share_email: true, people: true };
before(async () => { t = await start({ brand: 'Amaete', owners: [OWNER], clients: { ...CLIENTS, shop: SHOP } }); });
after(() => t.stop());
const uniq = () => Math.random().toString(36).slice(2, 8);
const shop = (m, p, b) => api(t, SHOP, m, p, b);
const msg = (r) => { const u = new URL(r.location, 'http://x'); return u.searchParams.get('ok') ?? u.searchParams.get('err') ?? r.location; };

/** Signs in on the accounts site itself (for the admin pages), answering the second step when asked. */
async function signInHere(b, email, { next = '/admin', mfaSecret } = {}) {
  resetLimits();
  let r = await b.get(next);
  assert.equal(r.location, '/signin');
  r = await b.get('/signin');
  r = await b.post('/email/start', { csrf: csrfOf(r.html), email });
  r = await b.post('/email/verify', { csrf: csrfOf(r.html), code: t.cfg.mail.last.code });
  if (r.location === '/profile') { const p = await b.get('/profile'); r = await b.post('/profile', { csrf: csrfOf(p.html), display_name: email.split('@')[0], handle: 'h_' + uniq() }); }
  if (mfaSecret) {
    const m = await b.get(next);
    if (m.location?.startsWith('/mfa')) { const f = await b.get(m.location); await b.post('/mfa', { csrf: csrfOf(f.html), code: totp.totp(mfaSecret), next }); }
  }
  return r;
}
/** Signs in to the product (the shop's sign-in), returning what /token gave the shop. */
async function productSignIn(email) {
  resetLimits();
  const s = await emailSignIn(t, browser(t.base), SHOP, email);
  return (await exchange(t, SHOP, s.final, s.verifier)).body;
}
const lastMail = (to) => [...(t.cfg.mail.sent ?? [])].reverse().find((m) => m.to === to && !m.code);

let ob, secret;
test('the owner opens the people admin after the second step, and sees the product as super admin', async () => {
  ob = browser(t.base);
  await signInHere(ob, OWNER, { next: '/admin/shop/team' });
  let r = await ob.get('/admin/shop/team');
  assert.equal(r.location, '/account?setup=mfa&next=%2Fadmin%2Fshop%2Fteam');
  r = await ob.get('/account?setup=mfa');
  r = await ob.post('/account/mfa/setup', { csrf: csrfOf(r.html) });
  secret = r.html.match(/<code>([A-Z2-7]+)<\/code>/)[1];
  r = await ob.post('/account/mfa/enable', { csrf: csrfOf(r.html), code: totp.totp(secret) });
  r = await ob.get('/admin');
  assert.equal(r.location, '/admin/shop/team', 'one product: straight to it');
  r = await ob.get('/admin/shop/team');
  assert.equal(r.status, 200);
  assert.match(r.html, /Shop people/);
  assert.match(r.html, /The Shop team/);
  assert.match(r.html, /Super admin<\/span><span class="pill">You/);
  assert.match(r.html, /Waiting to join/);
  assert.match(r.html, /Send invitation/);
  assert.ok(!/Noveniqe|Onyx/.test(r.html), 'the accounts site never names itself');
  r = await ob.get('/admin/shop/roles');
  assert.match(r.html, /Team roles/);
  assert.match(r.html, /Choose admins and support/);
});

test('an invitation is emailed, waits, and becomes the role on first sign-in to the product', async () => {
  const bo = `bo.${uniq()}@example.com`;
  let r = await ob.get('/admin/shop/team');
  r = await ob.post('/admin/shop/team/add', { csrf: csrfOf(r.html), email: bo, name: 'Bo Ade', role: 'member', how: 'invite' });
  assert.equal(msg(r), `Invitation emailed to ${bo}.`);
  const m = lastMail(bo);
  assert.equal(m.subject, 'You are invited to Shop');
  assert.match(m.html, /https:\/\/shop\.test/);
  r = await ob.get('/admin/shop/invites');
  assert.ok(r.html.includes(bo) && /Cancel invitation/.test(r.html));
  const tok = await productSignIn(bo);
  assert.equal(tok.person.role, 'member');
  assert.equal(tok.person.email, bo, 'share_email product sees the email');
  assert.equal((await shop('GET', '/v1/invites')).body.invites.length, 0, 'the invitation is used up');
  r = await ob.get('/admin/shop/team');
  assert.ok(r.html.includes(bo) && r.html.includes('>Member<'));
  r = await ob.get('/admin/shop/activity');
  assert.match(r.html, /joined as member \(invited by owner@example\.com\)/);
  assert.match(r.html, /signed in/);
});

test('someone nobody invited gets no role, and a game without the people admin is unchanged', async () => {
  const stranger = await productSignIn(`x.${uniq()}@example.com`);
  assert.equal(stranger.person.role, null);
  resetLimits();
  const g = await emailSignIn(t, browser(t.base), CLIENTS.agp, `g.${uniq()}@example.com`);
  const tok = (await exchange(t, CLIENTS.agp, g.final, g.verifier)).body;
  assert.equal(tok.person, undefined);
  assert.equal((await api(t, CLIENTS.agp, 'GET', '/v1/people')).status, 403);
  assert.ok((await productSignIn(OWNER)).person.role === 'super_admin', 'the owner is super admin in every product');
});

test('the product server reads and changes its own people', async () => {
  const cy = `cy.${uniq()}@example.com`;
  let r = await shop('POST', '/v1/roles', { email: cy, role: 'support', by: 'shop-tool' });
  assert.equal(r.status, 200);
  assert.equal(r.body.person.role, 'support');
  r = await shop('GET', `/v1/person?email=${encodeURIComponent(cy)}`);
  assert.equal(r.body.person.role, 'support');
  assert.equal(r.body.person.id, null, 'not signed in yet');
  r = await shop('POST', '/v1/roles', { email: cy, role: 'super_admin' });
  assert.equal(r.status, 400);
  r = await shop('POST', '/v1/roles', { email: OWNER, role: 'member' });
  assert.equal(r.status, 403, "the owner's access cannot be changed");
  r = await shop('GET', '/v1/people');
  assert.ok(r.body.people.some((p) => p.email === OWNER && p.role === 'super_admin'));
  r = await shop('POST', '/v1/roles', { email: cy, role: '' });
  assert.equal(r.body.person, null);
  assert.equal((await shop('GET', `/v1/person?email=${encodeURIComponent(cy)}`)).status, 404);
  r = await shop('POST', '/v1/invites', { email: `inv.${uniq()}@example.com`, role: 'member', send_email: true });
  assert.equal(r.status, 201);
  assert.equal(r.body.emailed, true);
  r = await shop('POST', '/v1/invites/revoke', { id: r.body.invite.id });
  assert.equal(r.status, 200);
  r = await shop('POST', '/v1/activity', { by: 'shop', text: 'exported a report' });
  assert.equal(r.status, 201);
  assert.ok((await shop('GET', '/v1/activity')).body.activity.some((a) => a.text === 'exported a report'));
});

test('an admin invites members but cannot choose admins; support helps members only', async () => {
  const adm = `adm.${uniq()}@example.com`, sup = `sup.${uniq()}@example.com`, mem = `mem.${uniq()}@example.com`;
  let r = await ob.get('/admin/shop/team');
  for (const [email, role] of [[adm, 'admin'], [sup, 'support'], [mem, 'member']]) {
    r = await ob.post('/admin/shop/team/add', { csrf: csrfOf((await ob.get('/admin/shop/team')).html), email, role, how: 'now' });
    assert.match(msg(r), /can use Shop now/);
  }
  await productSignIn(mem);
  const ab = browser(t.base);
  await signInHere(ab, adm, { next: '/admin/shop/team' });
  r = await ab.get('/admin/shop/team');
  assert.equal(r.status, 200);
  assert.match(r.html, /You are admin here/);
  assert.ok(!r.html.includes('<option value="admin"'), 'an admin of the team cannot hand out admin');
  r = await ab.post('/admin/shop/team/add', { csrf: csrfOf(r.html), email: `x.${uniq()}@example.com`, role: 'admin', how: 'now' });
  assert.match(msg(r), /Only the super admin can choose admins and support/);
  r = await ab.post('/admin/shop/team/role', { csrf: csrfOf((await ab.get('/admin/shop/team')).html), email: sup, role: 'member' });
  assert.match(msg(r), /Only the super admin can change admins and support/);
  r = await ab.post('/admin/shop/team/role', { csrf: csrfOf((await ab.get('/admin/shop/team')).html), email: mem, role: 'member', view_only: '1' });
  assert.match(msg(r), /Saved/);
  assert.equal((await shop('GET', `/v1/person?email=${encodeURIComponent(mem)}`)).body.person.view_only, true);

  const sb = browser(t.base);
  await signInHere(sb, sup, { next: '/admin/shop/team' });
  r = await sb.get('/admin/shop/team');
  assert.ok(!r.html.includes('Send invitation'), 'support cannot invite');
  r = await sb.post('/admin/shop/team/add', { csrf: csrfOf(r.html), email: `y.${uniq()}@example.com`, role: 'member', how: 'now' });
  assert.match(msg(r), /Only admins can invite people/);
  r = await sb.post('/admin/shop/team/signout', { csrf: csrfOf((await sb.get('/admin/shop/team')).html), email: mem });
  assert.match(msg(r), /signed out everywhere/);
  assert.ok((await shop('GET', `/v1/person?email=${encodeURIComponent(mem)}`)).body.person.valid_after, 'products learn the sign-out');
  r = await sb.post('/admin/shop/team/signout', { csrf: csrfOf((await sb.get('/admin/shop/team')).html), email: adm });
  assert.match(msg(r), /Support can help members only/);

  // a member cannot open the admin at all
  const mb = browser(t.base);
  await signInHere(mb, mem, { next: '/admin/shop/team' });
  r = await mb.get('/admin/shop/team');
  assert.equal(r.status, 403);
  // a wrong form token changes nothing
  r = await ab.post('/admin/shop/team/remove', { csrf: 'nope', email: mem });
  assert.match(msg(r), /expired/);
});

test("a customer's admin only sees and manages that customer's people", async () => {
  let r = await ob.post('/admin/shop/customers/save', { csrf: csrfOf((await ob.get('/admin/shop/customers')).html), name: 'Acme', notes: 'pilot' });
  assert.match(msg(r), /Saved Acme/);
  const org = (await shop('GET', '/v1/orgs')).body.orgs.find((o) => o.name === 'Acme').id;
  const boss = `boss.${uniq()}@acme.test`, worker = `w.${uniq()}@acme.test`;
  r = await ob.post('/admin/shop/team/add', { csrf: csrfOf((await ob.get('/admin/shop/team')).html), email: boss, role: 'admin', org, how: 'now' });
  assert.match(msg(r), /can use Shop now/);
  const bb = browser(t.base);
  await signInHere(bb, boss, { next: '/admin/shop/team' });
  r = await bb.get('/admin/shop/team');
  assert.match(r.html, /Acme at Shop/);
  assert.ok(!r.html.includes(OWNER), 'the Shop team is not shown to a customer');
  r = await bb.post('/admin/shop/team/add', { csrf: csrfOf(r.html), email: worker, role: 'member', how: 'invite' });
  assert.match(msg(r), /Invitation emailed/);
  assert.equal((await shop('GET', '/v1/invites')).body.invites.find((i) => i.email === worker).org, org);
  const tok = await productSignIn(worker);
  assert.equal(tok.person.org, org);
  r = await bb.get('/admin/shop/customers');
  assert.equal(r.status, 200);
  r = await bb.post('/admin/shop/customers/delete', { csrf: csrfOf((await bb.get('/admin/shop/team')).html), id: org });
  assert.match(msg(r), /Only the team's admins can remove customers/);
  r = await ob.post('/admin/shop/customers/delete', { csrf: csrfOf((await ob.get('/admin/shop/customers')).html), id: org });
  assert.match(msg(r), /Remove its 2 people first/);
});

test('nobody signed out gets in, and a stranger is turned away', async () => {
  assert.equal((await browser(t.base).get('/admin/shop/team')).location, '/signin');
  const xb = browser(t.base);
  await signInHere(xb, `z.${uniq()}@example.com`, { next: '/admin' });
  const r = await xb.get('/admin');
  assert.equal(r.status, 403);
});
