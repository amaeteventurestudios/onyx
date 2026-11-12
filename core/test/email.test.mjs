// The email block: double opt-in, verified joins, newsletters to a tagged audience in batches, scheduled sends, automations,
// counted opens and clicks, unsubscribe (page and one-click), the off switch, other products kept apart, and deleting an account.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, CLIENTS, SECRETS, api } from './helpers.mjs';
import { sha } from '../lib/util.mjs';
import { pbDate } from '../lib/pb.mjs';
import { render, cleanTags, personalise } from '../lib/email.mjs';

const NEWS = { id: 'news', name: 'News', product: 'news', guests: false, color: '#FF5B2E', home: 'https://news.test', redirect_uris: ['https://news.test/cb'], secretHash: sha(SECRETS.shop),
  email: { on: true, from: 'News <hello@news.test>', reply_to: 'owner@news.test', address: '1 Main St, Springfield', monthly: 100,
    lists: { tips: { name: 'News tips', double_opt_in: true, public: true }, quiet: { name: 'Quiet', double_opt_in: false } } } };
const OFF = { ...NEWS, id: 'off', product: 'off', email: { ...NEWS.email, on: false } };
SECRETS.news = SECRETS.off = SECRETS.shop;
let t;
before(async () => { t = await start({ clients: { ...CLIENTS, news: NEWS, off: OFF }, mailBatch: 2 }); });
after(() => t.stop());
const news = (m, p, b) => api(t, NEWS, m, p, b);
const sent = () => t.cfg.mail.sent ?? [];
const clear = () => { t.cfg.mail.sent = []; };
const linkIn = (m, re) => (m.text.match(re) ?? m.html.match(re))?.[0];
const get = (path, opts = {}) => fetch(t.base + path, { redirect: 'manual', ...opts });
const drain = async () => { for (let i = 0; i < 20; i++) await t.core.email.tick(); };

test('the body turns into email-safe HTML and plain text, with only web links and the reader\'s name', () => {
  const r = render({ client: NEWS, subject: 'Hi', body: '# Hello {name|friend}\n\nRead **this** [here](https://x.test/a?b=1&c=2) or [bad](javascript:alert(1)).\n\n- one\n- two\n\n> wise\n\n---\n\n[[Open it](https://x.test/go)]\n\n<script>x</script>', name: 'Ada Obi', foot: { list: 'News tips', unsub: 'https://u.test', address: '1 Main St' } });
  assert.match(r.html, /Hello Ada</); assert.match(r.html, /<strong>this<\/strong>/);
  assert.match(r.html, /href="https:\/\/x\.test\/a\?b=1&amp;c=2"/);
  assert.doesNotMatch(r.html, /javascript:/); assert.doesNotMatch(r.html, /<script>/); assert.match(r.html, /&lt;script&gt;/);
  assert.match(r.html, /<li[^>]*>one<\/li>/); assert.match(r.html, /<blockquote/); assert.match(r.html, /href="https:\/\/x\.test\/go"[^>]*>Open it</);
  assert.match(r.text, /HELLO ADA/); assert.match(r.text, /here \(https:\/\/x\.test\/a\?b=1&c=2\)/); assert.match(r.text, /Unsubscribe: https:\/\/u\.test/); assert.match(r.text, /1 Main St/);
  assert.equal(personalise('Hi {name|friend}', ''), 'Hi friend');
  assert.deepEqual(cleanTags(['VIP', ' vip ', 'From_Quiz!', '']), ['vip', 'fromquiz']);
});

test('double opt-in: pending until the link is clicked; a verified join is in at once; joining twice keeps one row', async () => {
  clear();
  let r = await news('POST', '/v1/email/people', { list: 'tips', email: 'Ada@Example.com', name: 'Ada', tags: ['quiz'] });
  assert.equal(r.status, 201); assert.equal(r.body.person.status, 'pending'); assert.equal(r.body.confirm_sent, true);
  assert.equal(sent().length, 1); assert.equal(sent()[0].to, 'ada@example.com'); assert.equal(sent()[0].from, 'News <hello@news.test>');
  assert.match(sent()[0].text, /Please confirm that you want News tips from News/);
  const confirm = linkIn(sent()[0], /http:\/\/127\.0\.0\.1:\d+\/mail\/c\/[A-Za-z0-9._-]+/);
  assert.ok(confirm);
  const tampered = confirm.slice(0, -3) + 'xyz';
  assert.equal((await get(new URL(tampered).pathname)).status, 404);
  const page = await get(new URL(confirm).pathname);
  assert.equal(page.status, 200); assert.match(await page.text(), /You&#39;re in/);
  r = await news('GET', '/v1/email/people?list=tips&email=ada@example.com');
  assert.equal(r.body.person.status, 'active');
  r = await news('POST', '/v1/email/people', { list: 'tips', email: 'bo@example.com', name: 'Bo', verified: true, tags: ['vip'] });
  assert.equal(r.body.person.status, 'active'); assert.equal(r.body.confirm_sent, false);
  r = await news('POST', '/v1/email/people', { list: 'tips', email: 'bo@example.com', tags: ['quiz'] });
  assert.equal(r.status, 200); assert.deepEqual(r.body.person.tags, ['vip', 'quiz']);
  assert.equal((await news('POST', '/v1/email/people', { list: 'nope', email: 'x@example.com' })).status, 400);
  assert.equal((await news('POST', '/v1/email/people', { list: 'tips', email: 'not-an-email' })).status, 400);
});

test('a newsletter goes to the tagged audience in batches, with tracked links, an open pixel and one-click unsubscribe', async () => {
  for (const e of ['c1@example.com', 'c2@example.com', 'c3@example.com']) await news('POST', '/v1/email/people', { list: 'tips', email: e, verified: true, tags: ['vip'] });
  await news('POST', '/v1/email/people', { list: 'tips', email: 'skip@example.com', verified: true, tags: ['vip', 'staff'] });
  let r = await news('POST', '/v1/email/sends', { list: 'tips', subject: 'Hello {name|friend}', preheader: 'Inside', body: '# This week\n\nSee [the lesson](https://news.test/lesson).', audience: { tags: ['vip'], exclude: ['staff'] } });
  assert.equal(r.status, 201);
  const id = r.body.send.id;
  r = await news('GET', `/v1/email/sends/${id}`);
  assert.equal(r.body.audience_count, 4, 'bo and c1-c3, not the staff one');
  clear();
  r = await news('POST', `/v1/email/sends/${id}/test`, { to: 'owner@news.test' });
  assert.equal(r.status, 200); assert.equal(sent()[0].subject, '[Test] Hello friend');
  clear();
  r = await news('POST', `/v1/email/sends/${id}/send`, {});
  assert.equal(r.body.send.status, 'sending'); assert.equal(r.body.send.recipients, 4);
  await drain();
  r = await news('GET', `/v1/email/sends/${id}`);
  assert.equal(r.body.send.status, 'sent'); assert.equal(r.body.send.delivered, 4);
  assert.deepEqual(sent().map((m) => m.to).sort(), ['bo@example.com', 'c1@example.com', 'c2@example.com', 'c3@example.com']);
  const m = sent().find((x) => x.to === 'bo@example.com');
  assert.equal(m.subject, 'Hello Bo'); assert.equal(m.replyTo, 'owner@news.test');
  assert.match(m.headers['List-Unsubscribe'], /\/mail\/u\//); assert.equal(m.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  assert.match(m.html, /1 Main St, Springfield/);
  const click = m.html.match(/href="([^"]*\/mail\/r\/[^"]+)"/)[1].replace(/&amp;/g, '&');
  const pixel = m.html.match(/src="([^"]*\/mail\/o\/[^"]+)"/)[1];
  const unsub = m.headers['List-Unsubscribe'].slice(1, -1);
  assert.ok(m.html.includes(`href="${unsub}"`), 'the unsubscribe link is not rewritten');
  let res = await get(new URL(click).pathname + new URL(click).search);
  assert.equal(res.status, 302); assert.equal(res.headers.get('location'), 'https://news.test/lesson');
  res = await get(new URL(click).pathname + '?u=' + encodeURIComponent('https://evil.test/'));
  assert.equal(res.status, 404, 'the signed link can\'t be pointed elsewhere');
  await get(new URL(pixel).pathname); await get(new URL(pixel).pathname);
  r = await news('GET', `/v1/email/sends/${id}`);
  assert.equal(r.body.send.opens, 1); assert.equal(r.body.send.clicks, 1); assert.deepEqual(r.body.links, [{ url: 'https://news.test/lesson', people: 1 }]);
  assert.equal((await news('POST', `/v1/email/sends/${id}/send`, {})).status, 409, 'never twice');
  assert.equal((await news('DELETE', `/v1/email/sends/${id}`)).status, 409);
  // one-click unsubscribe from the mail app
  res = await get(new URL(unsub).pathname);
  assert.match(await res.text(), /Unsubscribe\?/);
  res = await get(new URL(unsub).pathname, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
  assert.match(await res.text(), /unsubscribed/);
  assert.equal((await news('GET', '/v1/email/people?list=tips&email=bo@example.com')).body.person.status, 'unsubscribed');
  r = await news('GET', '/v1/email');
  const tips = r.body.lists.find((l) => l.id === 'tips');
  assert.equal(tips.unsubscribed, 1); assert.ok(r.body.month.used >= 4);
});

test('scheduling, the monthly limit, and unscheduling', async () => {
  const id = (await news('POST', '/v1/email/sends', { list: 'quiet', subject: 'Later', body: 'Soon.' })).body.send.id;
  assert.equal((await news('POST', `/v1/email/sends/${id}/send`, {})).status, 400, 'nobody on the quiet list yet');
  await news('POST', '/v1/email/people', { list: 'quiet', email: 'q@example.com' });
  assert.equal((await news('POST', `/v1/email/sends/${id}/send`, { when: new Date(Date.now() + 10_000).toISOString() })).status, 400, 'at least a minute ahead');
  let r = await news('POST', `/v1/email/sends/${id}/send`, { when: new Date(Date.now() + 3600e3).toISOString() });
  assert.equal(r.body.send.status, 'scheduled');
  assert.equal((await news('POST', `/v1/email/sends/${id}/unschedule`)).body.send.status, 'draft');
  await news('POST', `/v1/email/sends/${id}/send`, { when: new Date(Date.now() + 3600e3).toISOString() });
  await t.pb.update('nv_mail_sends', id, { scheduled_for: pbDate(new Date(Date.now() - 1000)) });   // the hour passes
  clear(); await drain();
  assert.equal((await news('GET', `/v1/email/sends/${id}`)).body.send.status, 'sent');
  assert.deepEqual(sent().map((m) => m.to), ['q@example.com']);
  assert.equal((await news('GET', `/v1/email/sends/${id}`)).body.send.recipients, 1);
  const big = (await news('POST', '/v1/email/sends', { list: 'quiet', subject: 'Big', body: 'x' })).body.send.id;
  await t.pb.create('nv_mail_sends', { product: 'news', list: 'quiet', subject: 'old', status: 'sent', recipients: 99, sent_at: pbDate() });
  r = await news('POST', `/v1/email/sends/${big}/send`, {});
  assert.equal(r.status, 402); assert.equal(r.body.error.code, 'LIMIT');
});

test('automations: a welcome series on joining, a tag series, an event, each once per person, with step numbers', async () => {
  await t.pb.create('nv_mail_sends', { product: 'news', list: 'quiet', subject: 'reset', status: 'sent', recipients: -99, sent_at: pbDate() });   // undo the limit test
  let r = await news('POST', '/v1/email/autos', { list: 'quiet', name: 'Welcome', trigger: 'join', active: true,
    steps: [{ delay: 0, unit: 'minutes', subject: 'Welcome {name|friend}', body: 'Glad you came. [Start](https://news.test/start)' }, { delay: 2, unit: 'days', subject: 'Day two', body: 'More.' }] });
  assert.equal(r.status, 201);
  const welcome = r.body.auto.id;
  assert.equal((await news('POST', '/v1/email/autos', { list: 'quiet', name: 'Bad', trigger: 'join', active: true, steps: [{ subject: '', body: '' }] })).status, 400);
  const pro = (await news('POST', '/v1/email/autos', { list: 'quiet', name: 'Pro', trigger: 'event', value: 'went-pro', active: true, steps: [{ delay: 0, subject: 'Thanks', body: 'Thank you.' }] })).body.auto.id;
  await news('POST', '/v1/email/autos', { list: 'quiet', name: 'VIP', trigger: 'tag', value: 'vip', active: true, steps: [{ delay: 0, subject: 'VIP', body: 'You are VIP.' }] });
  clear();
  await news('POST', '/v1/email/people', { list: 'quiet', email: 'w@example.com', name: 'Wale Ade' });
  await news('POST', '/v1/email/people', { list: 'quiet', email: 'w@example.com' });   // twice: still one welcome
  await drain();
  assert.deepEqual(sent().map((m) => m.subject), ['Welcome Wale']);
  const run = await t.pb.first('nv_mail_runs', `auto_id='${welcome}'`);
  assert.equal(run.step, 1);
  await t.pb.update('nv_mail_runs', run.id, { next_at: pbDate(new Date(Date.now() - 1000)) });   // two days pass
  await drain();
  assert.deepEqual(sent().map((m) => m.subject), ['Welcome Wale', 'Day two']);
  clear();
  await news('POST', '/v1/email/people/tags', { list: 'quiet', email: 'w@example.com', add: ['vip'] });
  r = await news('POST', '/v1/email/event', { email: 'w@example.com', event: 'went-pro' });
  assert.equal(r.body.started, 1);
  assert.equal((await news('POST', '/v1/email/event', { email: 'w@example.com', event: 'went-pro' })).body.started, 0, 'once per person');
  await drain();
  assert.deepEqual(sent().map((m) => m.subject).sort(), ['Thanks', 'VIP']);
  const open = sent().find((m) => m.subject === 'Thanks').html.match(/src="([^"]*\/mail\/o\/[^"]+)"/)[1];
  await get(new URL(open).pathname);
  r = await news('GET', `/v1/email/autos/${pro}`);
  assert.deepEqual(r.body.steps, [{ sent: 1, waiting: 0, opens: 1, clicks: 0 }]); assert.equal(r.body.auto.enrolled, 1);
  r = await news('GET', `/v1/email/autos/${welcome}`);
  assert.equal(r.body.steps[0].sent, 1); assert.equal(r.body.steps[1].sent, 1);
});

test('the public signup form, its honeypot, and closed lists', async () => {
  clear();
  const post = (body) => get('/mail/join', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  let res = await post({ product: 'news', list: 'tips', email: 'form@example.com', name: 'Form' });
  assert.match(await res.text(), /Check your email/); assert.equal(sent().length, 1);
  res = await post({ product: 'news', list: 'tips', email: 'bot@example.com', website: 'spam' });
  assert.equal(sent().length, 1, 'robots get no email');
  res = await post({ product: 'news', list: 'quiet', email: 'x@example.com' });
  assert.equal(res.status, 404, 'a list that is not public takes no form signups');
});

test('switched off: nothing leaves, but drafts and previews work; other products see nothing of this one', async () => {
  const off = (m, p, b) => api(t, OFF, m, p, b);
  clear();
  assert.equal((await off('POST', '/v1/email/people', { list: 'tips', email: 'a@example.com' })).status, 409);
  const id = (await off('POST', '/v1/email/sends', { list: 'tips', subject: 'S', body: 'B' })).body.send.id;
  assert.equal((await off('POST', `/v1/email/sends/${id}/test`, { to: 'o@example.com' })).status, 409);
  assert.equal((await off('POST', `/v1/email/sends/${id}/send`, {})).status, 409);
  const pv = await off('POST', '/v1/email/preview', { list: 'tips', subject: 'S', body: '# Hi' });
  assert.match(pv.body.html, /Hi<\/h1>/);
  assert.equal((await off('GET', '/v1/email')).body.on, false);
  assert.equal(sent().length, 0);
  assert.equal((await off('GET', `/v1/email/sends/${(await news('GET', '/v1/email')).body.sends[0].id}`)).status, 404, 'another product\'s newsletter');
  assert.equal((await api(t, CLIENTS.agp, 'GET', '/v1/email')).status, 403, 'a product without the block');
});

test('deleting an account takes the person off every list', async () => {
  const uid = (await api(t, CLIENTS.agp, 'POST', '/v1/guests', {})).body.user.id;
  await news('POST', '/v1/email/people', { list: 'quiet', email: 'gone@example.com', user_id: uid, verified: true });
  assert.ok((await news('GET', `/v1/email/people?list=quiet&user_id=${uid}`)).body.person);
  await t.core.accounts.erase(uid);
  assert.equal((await news('GET', `/v1/email/people?list=quiet&user_id=${uid}`)).body.person, null);
});

test('with no sender of its own, a product sends from the shared mailbox under its own name; no postal address, no newsletter', async () => {
  const BARE = { ...NEWS, id: 'bare', product: 'bare', email: { on: true, lists: { l: { name: 'L', double_opt_in: false } } } };
  const t2 = await start({ clients: { bare: BARE }, mail: { ...t.cfg.mail, provider: 'sink', from: 'Accounts <accounts@shared.test>', sent: [] } });
  SECRETS.bare = SECRETS.shop;
  try {
    const b = (m, p, body) => api(t2, BARE, m, p, body);
    await b('POST', '/v1/email/people', { list: 'l', email: 'p@example.com' });
    const id = (await b('POST', '/v1/email/sends', { list: 'l', subject: 'S', body: 'B' })).body.send.id;
    assert.equal((await b('POST', `/v1/email/sends/${id}/send`, {})).body.error.code, 'NO_ADDRESS');
    assert.equal((await b('POST', `/v1/email/sends/${id}/test`, { to: 'o@example.com' })).status, 200);
    assert.equal(t2.cfg.mail.sent.at(-1).from, '"News" <accounts@shared.test>');
  } finally { t2.stop(); }
});
