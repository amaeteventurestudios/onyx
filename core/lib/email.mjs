// The email block: lists, double opt-in, newsletters, automations, unsubscribe, and open and click reports, for every
// product on Onyx. Moved from Pagneto (its dashboard/email and audience) and rebuilt on Core's shared store.
//
// A product turns it on in deploy/clients.json:
//   "email": { "on": false, "from": "SavvyMe <hello@...>", "reply_to": "...", "address": "postal address for the footer (newsletters
//              and automations wait until there is one: US and EU law ask for it)",
//              "monthly": 5000, "lists": { "news": { "name": "SavvyMe news", "double_opt_in": true, "public": false } } }
// While "on" is false nothing leaves Onyx for that product: drafts, previews and reports work, every send answers 409 OFF.
//
// Only the product's server calls the API (client id and secret), never a browser:
//   GET    /v1/email                                    overview: lists and counts, this month's use, sends, automations, tags
//   GET    /v1/email/people?list=&email= | &user_id=    one person's status on a list (or { person: null })
//   GET    /v1/email/people?list=&page=                 everyone on a list, 200 a page (for the owner's export)
//   POST   /v1/email/people { list, email, name?, user_id?, tags?, verified?, source? }   join (double opt-in unless verified)
//   POST   /v1/email/people/unsubscribe { list, email | user_id }
//   POST   /v1/email/people/tags { list, email | user_id, add?, remove? }               adding a tag can start automations
//   POST   /v1/email/event { email | user_id, event, list? }                            starts "event" automations
//   POST   /v1/email/preview { list, subject, preheader, body }                         { html, text } exactly as sent
//   POST   /v1/email/sends { id?, list, subject, preheader?, body, audience? }          save a newsletter draft
//   GET    /v1/email/sends/<id>                          the newsletter, its numbers and its top links
//   POST   /v1/email/sends/<id>/test { to }              one copy to the owner
//   POST   /v1/email/sends/<id>/send { when? }           now, or at a time up to 90 days ahead
//   POST   /v1/email/sends/<id>/unschedule
//   DELETE /v1/email/sends/<id>                          drafts and scheduled ones only
//   POST   /v1/email/autos { id?, list, name, trigger: join|tag|event, value?, steps: [{ delay, unit, subject, body }], active }
//   GET    /v1/email/autos/<id>                          with each step's sent, opens and clicks
//   DELETE /v1/email/autos/<id>
// People's own pages (on the accounts site, wearing the product's name and colour):
//   POST /mail/join (a public list's signup form), GET /mail/c/<token> (confirm), GET|POST /mail/u/<token> (unsubscribe,
//   one-click from the mail app too), GET /mail/o/<token> (open pixel), GET /mail/r/<token>?u= (counted link).
// Newsletter bodies are short plain text with a little markdown (see render()); Core turns them into email-safe HTML.
import { createHmac } from 'node:crypto';
import { q, pbDate, fromPb } from './pb.mjs';
import { sendMail } from './mail.mjs';
import { EMAIL_RE, esc, limited, same } from './util.mjs';
import * as P from './pages.mjs';

const SAFE = /^[a-z0-9]{15}$/;
const UNIT_MS = { minutes: 60e3, hours: 3600e3, days: 864e5 };
const BODY_MAX = 50_000;
const monthKey = (d = new Date()) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const monthStart = () => { const d = new Date(); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); return d; };
const clip = (v, n) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);

/** Tags are short lower-case labels ("vip", "from-quiz"): letters, digits, spaces and hyphens, 40 characters, 20 a person. */
export function cleanTags(raw, max = 20) {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  const out = [];
  for (const t of list) {
    const s = String(t ?? '').toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}
export function readAudience(raw) {
  const a = raw && typeof raw === 'object' ? raw : {};
  return { tags: cleanTags(a.tags), exclude: cleanTags(a.exclude), match: a.match === 'all' ? 'all' : 'any' };
}

// ---------- the body: a little markdown to email-safe HTML and plain text ----------
//   # Heading   ## Smaller heading   > a quote   - a list item   --- a line   [[Button text](https://...)] a button
//   **bold**, [link text](https://...), {name} or {name|friend} for the reader's name. Blank lines split paragraphs.
const okUrl = (u) => /^(https?:\/\/|mailto:)[^\s"'<>]{1,1900}$/i.test(u) ? u : null;
export function personalise(s, name) {
  return String(s ?? '').replace(/\{name(?:\|([^}]{0,40}))?\}/g, (_, fb) => clip(name, 60).split(' ')[0] || fb || 'there');
}
function blocks(body) {
  const out = [];
  let para = [];
  const flush = () => { if (para.length) out.push({ t: 'p', text: para.join('\n') }); para = []; };
  for (const raw of String(body ?? '').slice(0, BODY_MAX).split(/\r?\n/)) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { flush(); continue; }
    if ((m = line.match(/^(#{1,2})\s+(.+)$/))) { flush(); out.push({ t: m[1].length === 1 ? 'h1' : 'h2', text: m[2] }); continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { flush(); out.push({ t: 'hr' }); continue; }
    if ((m = line.match(/^\s*\[\[([^\]]{1,80})\]\(([^)\s]+)\)\]\s*$/))) { flush(); if (okUrl(m[2])) out.push({ t: 'button', text: m[1], url: m[2] }); continue; }
    if ((m = line.match(/^\s*>\s?(.*)$/))) { flush(); const last = out.at(-1); if (last?.t === 'quote') last.text += '\n' + m[1]; else out.push({ t: 'quote', text: m[1] }); continue; }
    if ((m = line.match(/^\s*[-*]\s+(.+)$/))) { flush(); const last = out.at(-1); if (last?.t === 'list') last.items.push(m[1]); else out.push({ t: 'list', items: [m[1]] }); continue; }
    para.push(line.trim());
  }
  flush();
  return out;
}
function inline(s, accent) {
  return esc(s)
    .replace(/\[([^\]]{1,200})\]\(([^)\s]{1,1900})\)/g, (all, text, url) => { const u = okUrl(url.replace(/&amp;/g, '&')); return u ? `<a href="${esc(u)}" style="color:${accent};text-decoration:underline">${text}</a>` : text; })
    .replace(/\*\*([^*]{1,500})\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}
const plainInline = (s) => String(s).replace(/\[([^\]]{1,200})\]\(([^)\s]{1,1900})\)/g, (all, t, u) => okUrl(u) ? `${t} (${u})` : t).replace(/\*\*([^*]+)\*\*/g, '$1');
/** True when a body has something to read. */
export const hasContent = (body) => blocks(body).length > 0;

const HEX = /^#[0-9a-fA-F]{6}$/;
function inkOn(hex) {
  const n = parseInt(hex.slice(1), 16), [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#16181d' : '#ffffff';
}

/** The email as sent: { html, text }. `foot` carries the list's name, the unsubscribe address and the postal address. */
export function render({ client, subject, preheader = '', body, name, foot = {} }) {
  const accent = HEX.test(client.color ?? '') ? client.color : '#3D5AFE', ink = '#16181d', muted = '#5d6370';
  const bs = blocks(personalise(body, name));
  const F = 'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif';
  const html = bs.map((b) => {
    if (b.t === 'h1') return `<h1 style="margin:0 0 16px;${F};font-size:26px;line-height:1.25;color:${ink}">${inline(b.text, accent)}</h1>`;
    if (b.t === 'h2') return `<h2 style="margin:24px 0 12px;${F};font-size:20px;line-height:1.3;color:${ink}">${inline(b.text, accent)}</h2>`;
    if (b.t === 'hr') return `<hr style="border:0;border-top:1px solid #e3e4e8;margin:24px 0">`;
    if (b.t === 'quote') return `<blockquote style="margin:0 0 16px;padding:4px 0 4px 16px;border-left:4px solid ${accent};color:${muted};${F};font-size:16px;line-height:1.6">${inline(b.text, accent)}</blockquote>`;
    if (b.t === 'list') return `<ul style="margin:0 0 16px;padding-left:22px;${F};font-size:16px;line-height:1.6;color:${ink}">${b.items.map((i) => `<li style="margin:0 0 6px">${inline(i, accent)}</li>`).join('')}</ul>`;
    if (b.t === 'button') return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:8px auto 24px"><tr><td style="border-radius:999px;background:${accent}"><a href="${esc(b.url)}" style="display:inline-block;padding:14px 28px;${F};font-size:16px;font-weight:700;color:${inkOn(accent)};text-decoration:none;border-radius:999px">${esc(b.text)}</a></td></tr></table>`;
    return `<p style="margin:0 0 16px;${F};font-size:16px;line-height:1.6;color:${ink}">${inline(b.text, accent)}</p>`;
  }).join('\n');
  const why = foot.list ? `You get this because you joined ${esc(foot.list)} from ${esc(client.name)}.` : `Sent by ${esc(client.name)}.`;
  const footHtml = `<p style="margin:0 0 8px">${why}${foot.unsub ? ` <a href="${esc(foot.unsub)}" style="color:${muted};text-decoration:underline">Unsubscribe</a>` : ''}</p>${foot.address ? `<p style="margin:0">${esc(foot.address)}</p>` : ''}`;
  const full = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f2">${preheader ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(personalise(preheader, name))}</div>` : ''}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f2"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px">
<tr><td style="padding:0 4px 14px;${F};font-size:15px;font-weight:700;color:${ink}"><span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${accent};margin-right:8px;vertical-align:-1px"></span>${esc(client.name)}</td></tr>
<tr><td style="background:#ffffff;border:1px solid #e3e4e8;border-radius:16px;padding:28px 24px">${html}</td></tr>
<tr><td style="padding:16px 8px;${F};font-size:13px;line-height:1.5;color:${muted};text-align:center">${footHtml}</td></tr>
</table></td></tr></table></body></html>`;
  const text = bs.map((b) => {
    if (b.t === 'h1' || b.t === 'h2') return plainInline(b.text).toUpperCase();
    if (b.t === 'hr') return '----';
    if (b.t === 'quote') return b.text.split('\n').map((l) => '> ' + plainInline(l)).join('\n');
    if (b.t === 'list') return b.items.map((i) => '- ' + plainInline(i)).join('\n');
    if (b.t === 'button') return `${b.text}: ${b.url}`;
    return plainInline(b.text);
  }).join('\n\n') + `\n\n--\n${foot.list ? `You get this because you joined ${foot.list} from ${client.name}.` : `Sent by ${client.name}.`}${foot.unsub ? `\nUnsubscribe: ${foot.unsub}` : ''}${foot.address ? `\n${foot.address}` : ''}\n`;
  return { html: full, text };
}

// ---------- the block ----------
export function makeEmail({ cfg, pb, A }) {
  const mail = cfg.mail;
  const sig = (what) => createHmac('sha256', cfg.key).update(`mail:${what}`).digest('base64url').slice(0, 22);
  const confirmToken = (id) => `${id}.${sig('c:' + id)}`;
  const unsubToken = (id) => `${id}.${sig('u:' + id)}`;
  const checkId = (token, kind) => { const [id, s] = String(token ?? '').split('.'); return SAFE.test(id ?? '') && s && same(s, sig(kind + ':' + id)) ? id : null; };
  const sourceOf = (s) => `${s.send ? 'b' + s.send : `a${s.auto}s${s.step ?? 0}`}.${s.person}`;
  const parseSource = (src) => { const m = /^(?:b([a-z0-9]{15})|a([a-z0-9]{15})s(\d{1,2}))\.([a-z0-9]{15})$/.exec(src); return m ? (m[1] ? { send: m[1], person: m[4] } : { auto: m[2], step: Number(m[3]), person: m[4] }) : null; };
  const openUrl = (src) => `${cfg.publicUrl}/mail/o/${src}.${sig('o:' + src)}`;
  const clickUrl = (src, url) => `${cfg.publicUrl}/mail/r/${src}.${sig(`r:${src}:${url}`)}?u=${encodeURIComponent(url)}`;
  const unsubUrl = (id) => `${cfg.publicUrl}/mail/u/${unsubToken(id)}`;

  const conf = (c) => c?.email ?? null;
  const listOf = (c, id) => { const l = conf(c)?.lists?.[id]; return l ? { id, name: l.name ?? id, double_opt_in: l.double_opt_in !== false, public: !!l.public } : null; };
  // the product's own sender if it has one, else the shared mailbox under the product's name ("SavvyMe" <accounts@...>)
  const fromOf = (c) => conf(c).from || c.from || `"${String(c.name).replace(/["<>\r\n]/g, '')}" <${(String(mail.from).match(/<([^>]+)>/)?.[1] ?? mail.from).trim()}>`;
  const clientOfProduct = (product) => Object.values(cfg.clients).find((c) => c.product === product && c.email) ?? null;

  /** Rewrites links to count clicks (the unsubscribe link is left alone) and adds the open pixel. */
  function track(html, src, unsub) {
    const un = (s) => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const out = html.replace(/href="(https?:\/\/[^"]+)"/gi, (all, raw) => { const url = un(raw); return url === unsub ? all : `href="${esc(clickUrl(src, url))}"`; });
    return out.replace('</body>', `<img src="${esc(openUrl(src))}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;opacity:0"></body>`);
  }

  async function deliver(c, person, { subject, preheader, body, src }) {
    const list = listOf(c, person.list);
    const unsub = unsubUrl(person.id);
    const r = render({ client: c, subject, preheader, body, name: person.name, foot: { list: list?.name, unsub, address: conf(c).address } });
    return sendMail(mail, { to: person.email, from: fromOf(c), replyTo: conf(c).reply_to, subject: personalise(subject, person.name).trim(),
      html: src ? track(r.html, src, unsub) : r.html, text: r.text,
      headers: { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } });
  }

  async function sendConfirm(c, person) {
    const list = listOf(c, person.list), url = `${cfg.publicUrl}/mail/c/${confirmToken(person.id)}`;
    const body = `Please confirm that you want ${list.name} from ${c.name}.\n\n[[Yes, sign me up](${url})]\n\nIf you didn't sign up, ignore this email and you won't hear from us.`;
    const r = render({ client: c, subject: `Confirm: ${list.name}`, body, name: person.name, foot: { address: conf(c).address } });
    return sendMail(mail, { to: person.email, from: fromOf(c), subject: `Please confirm: ${list.name}`, html: r.html, text: r.text });
  }

  // ---------- people ----------
  const all = async (coll, filter, sort = 'id', fields) => {
    const out = [];
    for (let page = 1; page <= 500; page++) { const b = await pb.list(coll, { filter, sort, perPage: 500, page, fields }); out.push(...b); if (b.length < 500) break; }
    return out;
  };
  async function findPerson(c, list, { email, user_id }) {
    const base = `product=${q(c.product)} && list=${q(list)}`;
    if (email) return pb.first('nv_mail_people', `${base} && email=${q(String(email).trim().toLowerCase())}`);
    if (user_id && SAFE.test(String(user_id))) return pb.first('nv_mail_people', `${base} && user_id=${q(String(user_id))}`, '-updated');
    return null;
  }
  const viewPerson = (p) => p && { id: p.id, list: p.list, email: p.email, name: p.name || '', tags: p.tags || [], status: p.status, source: p.source || '', joined: p.created, confirmed_at: p.confirmed_at || null, unsubscribed_at: p.unsubscribed_at || null };
  function audienceFilter(c, list, a) {
    const has = (t) => `tags ~ ${q(`"${t}"`)}`;
    const parts = [`product=${q(c.product)}`, `list=${q(list)}`, "status='active'"];
    if (a.tags.length) parts.push(a.match === 'all' ? a.tags.map(has).join(' && ') : `(${a.tags.map(has).join(' || ')})`);
    for (const t of a.exclude) parts.push(`tags !~ ${q(`"${t}"`)}`);
    return parts.join(' && ');
  }
  const countAudience = async (c, list, a) => (await all('nv_mail_people', audienceFilter(c, list, a), 'id', 'id')).length;

  async function usedThisMonth(c) {
    const sends = await all('nv_mail_sends', `product=${q(c.product)} && sent_at >= ${q(pbDate(monthStart()))}`, 'id', 'recipients');
    const autos = await all('nv_mail_autos', `product=${q(c.product)}`, 'id', 'by_month');
    const k = monthKey();
    return sends.reduce((n, s) => n + (s.recipients || 0), 0) + autos.reduce((n, a) => n + Number((a.by_month || {})[k] || 0), 0);
  }
  const monthly = (c) => Number(conf(c).monthly ?? 5000);

  /** Starts matching automations for one active person. A person goes through each automation once. */
  async function enrol(c, person, trigger, value) {
    if (person.status !== 'active') return 0;
    const autos = await pb.list('nv_mail_autos', { filter: `product=${q(c.product)} && list=${q(person.list)} && trigger=${q(trigger)} && active=true`, perPage: 50 });
    let n = 0;
    for (const a of autos) {
      const steps = Array.isArray(a.steps) ? a.steps : [];
      if (!steps.length) continue;
      if (trigger !== 'join' && String(a.value || '').toLowerCase() !== String(value || '').toLowerCase()) continue;
      try {
        await pb.create('nv_mail_runs', { auto_id: a.id, person_id: person.id, step: 0, status: 'active', next_at: pbDate(new Date(Date.now() + delayMs(steps[0]))) });
        await pb.update('nv_mail_autos', a.id, { 'enrolled+': 1 });
        n++;
      } catch { /* already went through it (unique index) */ }
    }
    return n;
  }
  const delayMs = (s) => Math.max(0, Math.min(365, Number(s?.delay) || 0)) * (UNIT_MS[s?.unit] ?? UNIT_MS.days);

  async function join(c, form) {
    const list = listOf(c, String(form.list ?? ''));
    if (!list) return [400, { error: { code: 'BAD_LIST', message: 'This product has no such list' } }];
    const email = String(form.email ?? '').trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return [400, { error: { code: 'BAD_EMAIL', message: 'That email doesn\'t look right' } }];
    const user_id = SAFE.test(String(form.user_id ?? '')) ? String(form.user_id) : '';
    const name = clip(form.name, 80), tags = cleanTags(form.tags), source = clip(form.source, 80);
    const confirmed = !!form.verified || !list.double_opt_in;
    let p = await findPerson(c, list.id, { email });
    const wasActive = p?.status === 'active';
    const data = { ...(name ? { name } : {}), ...(user_id ? { user_id } : {}), tags: cleanTags([...(p?.tags || []), ...tags]) };
    if (p) {
      if (!wasActive) Object.assign(data, confirmed ? { status: 'active', confirmed_at: pbDate(), unsubscribed_at: '' } : { status: 'pending' });
      if (source && !wasActive) data.source = source;
      p = await pb.update('nv_mail_people', p.id, data);
    } else {
      p = await pb.create('nv_mail_people', { product: c.product, list: list.id, email, source, ...data, status: confirmed ? 'active' : 'pending', ...(confirmed ? { confirmed_at: pbDate() } : {}) });
    }
    if (p.status === 'pending') await sendConfirm(c, p);
    if (p.status === 'active' && !wasActive) await enrol(c, p, 'join');
    if (p.status === 'active') for (const t of tags) await enrol(c, p, 'tag', t);   // each automation runs once per person
    return [wasActive ? 200 : 201, { person: viewPerson(p), confirm_sent: p.status === 'pending' }];
  }

  // ---------- newsletters ----------
  const viewSend = (s) => ({ id: s.id, list: s.list, subject: s.subject, preheader: s.preheader || '', body: s.body || '', audience: readAudience(s.audience), status: s.status,
    scheduled_for: s.scheduled_for || null, sent_at: s.sent_at || null, recipients: s.recipients || 0, delivered: s.delivered || 0, opens: s.opens || 0, clicks: s.clicks || 0, created: s.created, updated: s.updated });
  const viewAuto = (a) => ({ id: a.id, list: a.list, name: a.name, trigger: a.trigger, value: a.value || '', steps: a.steps || [], active: !!a.active,
    enrolled: a.enrolled || 0, sent: a.sent || 0, opens: a.opens || 0, clicks: a.clicks || 0, created: a.created, updated: a.updated });
  const own = async (coll, c, id) => { if (!SAFE.test(id)) return null; const r = await pb.get(coll, id); return r && r.product === c.product ? r : null; };

  async function topLinks(filter, limit = 10) {
    const rows = await all('nv_mail_events', `type='link' && ${filter}`, 'id', 'url');
    const n = new Map(); for (const r of rows) n.set(r.url, (n.get(r.url) || 0) + 1);
    return [...n].map(([url, people]) => ({ url, people })).sort((a, b) => b.people - a.people).slice(0, limit);
  }

  /** Sends the next few people of one newsletter that is going out; returns true when it finished. */
  async function sendChunk(s) {
    const c = clientOfProduct(s.product);
    if (!c || !conf(c).on) return false;   // switched off part way: it waits, and carries on once it is back on
    const filter = audienceFilter(c, s.list, readAudience(s.audience)) + (s.cursor ? ` && id > ${q(s.cursor)}` : '');
    const batch = cfg.mailBatch ?? 40;
    const people = await pb.list('nv_mail_people', { filter, sort: 'id', perPage: batch });
    let delivered = 0;
    for (const p of people) if (await deliver(c, p, { subject: s.subject, preheader: s.preheader, body: s.body, src: sourceOf({ send: s.id, person: p.id }) }).catch(() => false)) delivered++;
    const done = people.length < batch;
    const patch = { 'delivered+': delivered, ...(people.length ? { cursor: people.at(-1).id } : {}) };
    if (done) Object.assign(patch, { status: (s.delivered || 0) + delivered || !s.recipients ? 'sent' : 'failed', sent_at: s.sent_at || pbDate() });
    await pb.update('nv_mail_sends', s.id, patch);
    return done;
  }

  async function runStep(run) {
    const stop = (status = 'stopped') => pb.update('nv_mail_runs', run.id, { status });
    const a = await pb.get('nv_mail_autos', run.auto_id), p = await pb.get('nv_mail_people', run.person_id);
    const c = a && clientOfProduct(a.product);
    if (!a || !a.active || !p || p.status !== 'active' || !c) return stop();
    if (!conf(c).on || !conf(c).address) return pb.update('nv_mail_runs', run.id, { next_at: pbDate(new Date(Date.now() + 3600e3)) });
    const steps = Array.isArray(a.steps) ? a.steps : [], i = run.step || 0, step = steps[i];
    if (!step) return stop('done');
    if ((await usedThisMonth(c)) >= monthly(c)) return pb.update('nv_mail_runs', run.id, { next_at: pbDate(new Date(Date.now() + 3600e3)) });
    const ok = await deliver(c, p, { subject: step.subject || a.name, preheader: step.preheader, body: step.body, src: sourceOf({ auto: a.id, step: i, person: p.id }) }).catch(() => false);
    if (!ok) return pb.update('nv_mail_runs', run.id, { next_at: pbDate(new Date(Date.now() + 15 * 60e3)) });
    const k = monthKey();
    await pb.update('nv_mail_autos', a.id, { 'sent+': 1, by_month: { ...(a.by_month || {}), [k]: Number((a.by_month || {})[k] || 0) + 1 } });
    const next = steps[i + 1];
    return pb.update('nv_mail_runs', run.id, next ? { step: i + 1, next_at: pbDate(new Date(Date.now() + delayMs(next))) } : { step: i + 1, status: 'done' });
  }

  let running = null;
  /** One pass of the background work: scheduled newsletters fall due, newsletters going out send a batch, automation steps that are due go out. */
  async function tick() {
    while (running) await running.catch(() => {});   // one pass at a time; a second caller waits and then runs its own
    running = pass();
    try { return await running; } finally { running = null; }
  }
  async function pass() {
    {
      const now = q(pbDate());
      for (const s of await pb.list('nv_mail_sends', { filter: `status='scheduled' && scheduled_for <= ${now}`, perPage: 20 })) {
        const c = clientOfProduct(s.product);
        if (!c || !conf(c).on) continue;   // waits until email is back on
        const count = await countAudience(c, s.list, readAudience(s.audience));
        await pb.update('nv_mail_sends', s.id, { status: 'sending', recipients: count, delivered: 0, cursor: '', sent_at: pbDate() });
      }
      let chunks = 0;
      for (const s of await pb.list('nv_mail_sends', { filter: "status='sending'", sort: 'updated', perPage: 10 })) { await sendChunk(s).catch((e) => console.error('[email] send', s.id, e.message)); chunks++; }
      const runs = await pb.list('nv_mail_runs', { filter: `status='active' && next_at <= ${now}`, sort: 'next_at', perPage: 100 });
      for (const r of runs) await runStep(r).catch((e) => console.error('[email] automation', r.id, e.message));
      return { chunks, steps: runs.length };
    }
  }

  // ---------- the API ----------
  async function api(req, res, url, form, c, json, fail) {
    const ec = conf(c);
    if (!ec) return fail(res, 403, 'FORBIDDEN', 'This product does not use the email block');
    const path = url.pathname.replace(/\/$/, ''), M = req.method;
    const off = () => fail(res, 409, 'OFF', 'Email is not switched on for this product yet');
    const lists = Object.keys(ec.lists ?? {});
    const listArg = (v) => listOf(c, String(v ?? '')) ?? null;
    const who = (src) => ({ email: src.email ? String(src.email) : '', user_id: src.user_id ? String(src.user_id) : '' });
    let m;

    if (M === 'GET' && path === '/v1/email') {
      const counts = [];
      for (const id of lists) {
        const rows = await all('nv_mail_people', `product=${q(c.product)} && list=${q(id)}`, 'id', 'status,tags');
        const n = (st) => rows.filter((r) => r.status === st).length;
        const tags = new Map(); for (const r of rows) if (r.status === 'active') for (const t of r.tags || []) tags.set(t, (tags.get(t) || 0) + 1);
        counts.push({ ...listOf(c, id), active: n('active'), pending: n('pending'), unsubscribed: n('unsubscribed'),
          tags: [...tags].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag)) });
      }
      const sends = await pb.list('nv_mail_sends', { filter: `product=${q(c.product)}`, sort: '-created', perPage: 50 });
      const autos = await pb.list('nv_mail_autos', { filter: `product=${q(c.product)}`, sort: '-created', perPage: 50 });
      return json(res, 200, { on: !!ec.on, lists: counts, month: { used: await usedThisMonth(c), limit: monthly(c) }, sends: sends.map((s) => ({ ...viewSend(s), body: undefined })), autos: autos.map(viewAuto) });
    }
    if (M === 'GET' && path === '/v1/email/people') {
      const list = listArg(url.searchParams.get('list'));
      if (!list) return fail(res, 400, 'BAD_LIST', 'This product has no such list');
      const w = { email: url.searchParams.get('email'), user_id: url.searchParams.get('user_id') };
      if (w.email || w.user_id) return json(res, 200, { person: viewPerson(await findPerson(c, list.id, w)) });
      const page = Math.max(1, Math.min(1000, Number(url.searchParams.get('page')) || 1));
      const rows = await pb.list('nv_mail_people', { filter: `product=${q(c.product)} && list=${q(list.id)}`, sort: 'created', perPage: 200, page });
      return json(res, 200, { people: rows.map(viewPerson), page, more: rows.length === 200 });
    }
    if (M === 'POST' && path === '/v1/email/people') {
      if (!ec.on) return off();
      const [status, out] = await join(c, form);
      return json(res, status, out);
    }
    if (M === 'POST' && path === '/v1/email/people/unsubscribe') {
      const list = listArg(form.list);
      if (!list) return fail(res, 400, 'BAD_LIST', 'This product has no such list');
      const p = await findPerson(c, list.id, who(form));
      if (!p) return json(res, 200, { person: null });
      const done = p.status === 'unsubscribed' ? p : await pb.update('nv_mail_people', p.id, { status: 'unsubscribed', unsubscribed_at: pbDate() });
      return json(res, 200, { person: viewPerson(done) });
    }
    if (M === 'POST' && path === '/v1/email/people/tags') {
      const list = listArg(form.list);
      if (!list) return fail(res, 400, 'BAD_LIST', 'This product has no such list');
      const p = await findPerson(c, list.id, who(form));
      if (!p) return fail(res, 404, 'NOT_FOUND', 'That person is not on this list');
      const add = cleanTags(form.add).filter((t) => !(p.tags || []).includes(t)), remove = cleanTags(form.remove);
      const tags = cleanTags([...(p.tags || []).filter((t) => !remove.includes(t)), ...add]);
      const done = await pb.update('nv_mail_people', p.id, { tags });
      if (ec.on) for (const t of add) await enrol(c, done, 'tag', t);
      return json(res, 200, { person: viewPerson(done) });
    }
    if (M === 'POST' && path === '/v1/email/event') {
      const event = clip(form.event, 60).toLowerCase();
      if (!event) return fail(res, 400, 'BAD_EVENT', 'Name the event');
      if (!ec.on) return json(res, 200, { started: 0 });
      let started = 0;
      for (const id of form.list ? [String(form.list)] : lists) {
        if (!listOf(c, id)) continue;
        const p = await findPerson(c, id, who(form));
        if (p) started += await enrol(c, p, 'event', event);
      }
      return json(res, 200, { started });
    }
    if (M === 'POST' && path === '/v1/email/preview') {
      const list = listArg(form.list) ?? listOf(c, lists[0]);
      return json(res, 200, render({ client: c, subject: clip(form.subject, 150), preheader: clip(form.preheader, 150), body: String(form.body ?? '').slice(0, BODY_MAX),
        name: clip(form.name, 80), foot: { list: list?.name, unsub: `${cfg.publicUrl}/mail/u/preview`, address: ec.address } }));
    }

    // newsletters
    if (M === 'POST' && path === '/v1/email/sends') {
      const list = listArg(form.list);
      if (!list) return fail(res, 400, 'BAD_LIST', 'This product has no such list');
      const data = { list: list.id, subject: clip(form.subject, 150), preheader: clip(form.preheader, 150), body: String(form.body ?? ''), audience: readAudience(form.audience) };
      if (data.body.length > BODY_MAX) return fail(res, 413, 'TOO_LARGE', 'This email is too long. Split it into two.');
      if (form.id) {
        const s = await own('nv_mail_sends', c, String(form.id));
        if (!s) return fail(res, 404, 'NOT_FOUND', 'No such newsletter');
        if (!['draft', 'scheduled'].includes(s.status)) return fail(res, 409, 'SENT', 'This newsletter was already sent');
        return json(res, 200, { send: viewSend(await pb.update('nv_mail_sends', s.id, data)) });
      }
      return json(res, 201, { send: viewSend(await pb.create('nv_mail_sends', { product: c.product, status: 'draft', ...data })) });
    }
    if ((m = path.match(/^\/v1\/email\/sends\/([^/]+)(?:\/(test|send|unschedule))?$/))) {
      const s = await own('nv_mail_sends', c, m[1]);
      if (!s) return fail(res, 404, 'NOT_FOUND', 'No such newsletter');
      const act = m[2];
      if (M === 'GET' && !act) return json(res, 200, { send: viewSend(s), links: await topLinks(`send_id=${q(s.id)}`), audience_count: await countAudience(c, s.list, readAudience(s.audience)) });
      if (M === 'DELETE' && !act) {
        if (!['draft', 'scheduled'].includes(s.status)) return fail(res, 409, 'SENT', 'A sent newsletter stays in the record');
        await pb.remove('nv_mail_sends', s.id);
        return json(res, 200, { deleted: s.id });
      }
      if (M === 'POST' && act === 'unschedule') {
        if (s.status !== 'scheduled') return fail(res, 409, 'NOT_SCHEDULED', 'This newsletter is not scheduled');
        return json(res, 200, { send: viewSend(await pb.update('nv_mail_sends', s.id, { status: 'draft', scheduled_for: '' })) });
      }
      if (M === 'POST' && (act === 'test' || act === 'send')) {
        if (!ec.on) return off();
        if (!s.subject) return fail(res, 400, 'NO_SUBJECT', 'Add a subject line');
        if (!hasContent(s.body)) return fail(res, 400, 'NO_BODY', 'Write the email first');
        if (act === 'test') {
          const to = String(form.to ?? '').trim().toLowerCase();
          if (!EMAIL_RE.test(to)) return fail(res, 400, 'BAD_EMAIL', 'Give an address for the test');
          if (limited(`mailtest:${c.id}`, 20, 3600_000)) return fail(res, 429, 'SLOW_DOWN', 'That is a lot of tests. Try again in an hour.');
          const r = render({ client: c, subject: s.subject, preheader: s.preheader, body: s.body, name: clip(form.name, 80), foot: { list: listOf(c, s.list)?.name, address: ec.address } });
          const ok = await sendMail(mail, { to, from: fromOf(c), replyTo: ec.reply_to, subject: `[Test] ${personalise(s.subject, form.name)}`, html: r.html, text: r.text });
          return ok ? json(res, 200, { sent: to }) : fail(res, 502, 'MAIL', 'The mail server did not take it');
        }
        if (!['draft', 'scheduled'].includes(s.status)) return fail(res, 409, 'SENT', 'This newsletter is already on its way');
        if (!ec.address) return fail(res, 409, 'NO_ADDRESS', 'Add a postal address for the footer first (the law asks for one in newsletters)');
        const count = await countAudience(c, s.list, readAudience(s.audience));
        if (!count) return fail(res, 400, 'NOBODY', 'Nobody on the list matches who you picked');
        const used = await usedThisMonth(c);
        if (used + count > monthly(c)) return json(res, 402, { error: { code: 'LIMIT', message: `This would go over the ${monthly(c)} emails a month (${used} used)` }, used, limit: monthly(c) });
        if (form.when) {
          const when = new Date(String(form.when));
          if (isNaN(when) || when < Date.now() + 60e3 || when > Date.now() + 90 * 864e5) return fail(res, 400, 'BAD_TIME', 'Pick a time between a minute and 90 days from now');
          return json(res, 200, { send: viewSend(await pb.update('nv_mail_sends', s.id, { status: 'scheduled', scheduled_for: pbDate(when) })) });
        }
        const r = await pb.update('nv_mail_sends', s.id, { status: 'sending', recipients: count, delivered: 0, cursor: '', sent_at: pbDate() });
        setTimeout(() => tick().catch(() => {}), 0);
        return json(res, 200, { send: viewSend(r) });
      }
    }

    // automations
    if (M === 'POST' && path === '/v1/email/autos') {
      const list = listArg(form.list);
      if (!list) return fail(res, 400, 'BAD_LIST', 'This product has no such list');
      const trigger = ['join', 'tag', 'event'].includes(form.trigger) ? form.trigger : 'join';
      const raw = Array.isArray(form.steps) ? form.steps.slice(0, 10) : [];
      const steps = raw.map((s) => ({ delay: Math.max(0, Math.min(365, Math.round(Number(s?.delay) || 0))), unit: UNIT_MS[s?.unit] ? s.unit : 'days',
        subject: clip(s?.subject, 150), preheader: clip(s?.preheader, 150), body: String(s?.body ?? '').slice(0, BODY_MAX) }));
      const name = clip(form.name, 80) || 'Untitled';
      const value = trigger === 'tag' ? cleanTags([form.value])[0] ?? '' : trigger === 'event' ? clip(form.value, 60).toLowerCase() : '';
      if (trigger !== 'join' && !value) return fail(res, 400, 'NO_VALUE', trigger === 'tag' ? 'Pick the tag that starts it' : 'Name the event that starts it');
      const active = form.active === true || form.active === 'true';
      if (active && (!steps.length || steps.some((s) => !s.subject || !hasContent(s.body)))) return fail(res, 400, 'INCOMPLETE', 'Every email needs a subject and some words before this can go live');
      const data = { list: list.id, name, trigger, value, steps, active };
      if (form.id) {
        const a = await own('nv_mail_autos', c, String(form.id));
        if (!a) return fail(res, 404, 'NOT_FOUND', 'No such automation');
        return json(res, 200, { auto: viewAuto(await pb.update('nv_mail_autos', a.id, data)) });
      }
      return json(res, 201, { auto: viewAuto(await pb.create('nv_mail_autos', { product: c.product, ...data, by_month: {} })) });
    }
    if ((m = path.match(/^\/v1\/email\/autos\/([^/]+)$/))) {
      const a = await own('nv_mail_autos', c, m[1]);
      if (!a) return fail(res, 404, 'NOT_FOUND', 'No such automation');
      if (M === 'DELETE') {
        for (const r of await all('nv_mail_runs', `auto_id=${q(a.id)}`, 'id', 'id')) await pb.remove('nv_mail_runs', r.id).catch(() => {});
        await pb.remove('nv_mail_autos', a.id);
        return json(res, 200, { deleted: a.id });
      }
      if (M === 'GET') {
        const ev = await all('nv_mail_events', `auto_id=${q(a.id)} && (type='open' || type='click')`, 'id', 'type,step');
        const runs = await all('nv_mail_runs', `auto_id=${q(a.id)}`, 'id', 'step,status');
        const stats = (a.steps || []).map((_, i) => ({ sent: runs.filter((r) => (r.step || 0) > i).length, waiting: runs.filter((r) => r.status === 'active' && (r.step || 0) === i).length,
          opens: ev.filter((e) => e.type === 'open' && e.step === i).length, clicks: ev.filter((e) => e.type === 'click' && e.step === i).length }));
        return json(res, 200, { auto: viewAuto(a), steps: stats, links: await topLinks(`auto_id=${q(a.id)}`) });
      }
    }
    return fail(res, 404, 'NOT_FOUND', 'No such endpoint');
  }

  // ---------- people's own pages ----------
  async function once(key, type, s, url, product) {
    try { await pb.create('nv_mail_events', { key, type, product, send_id: s.send ?? '', auto_id: s.auto ?? '', step: s.step ?? 0, person_id: s.person, url: url ?? '' }); return true; }
    catch { return false; }
  }
  const baseKey = (s) => `${s.send ? 'b' + s.send : `a${s.auto}s${s.step}`}:${s.person}`;
  async function productOfSource(s) { const r = s.send ? await pb.get('nv_mail_sends', s.send) : await pb.get('nv_mail_autos', s.auto); return r?.product ?? null; }
  async function recordOpen(s) {
    const product = await productOfSource(s);
    if (!product) return;
    if (await once(`o:${baseKey(s)}`, 'open', s, '', product)) await pb.update(s.send ? 'nv_mail_sends' : 'nv_mail_autos', s.send ?? s.auto, { 'opens+': 1 }).catch(() => {});
  }
  async function recordClick(s, url) {
    await recordOpen(s);   // a click means they opened it, even if their mail app blocked the pixel
    const product = await productOfSource(s);
    if (!product) return;
    if (await once(`c:${baseKey(s)}`, 'click', s, '', product)) await pb.update(s.send ? 'nv_mail_sends' : 'nv_mail_autos', s.send ?? s.auto, { 'clicks+': 1 }).catch(() => {});
    const h = createHmac('sha1', 'link').update(url).digest('base64url').slice(0, 12);
    await once(`l:${baseKey(s)}:${h}`, 'link', s, url.slice(0, 2000), product);
  }
  const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

  /** Handles /mail/*; returns false when the path isn't one of ours. */
  async function pages(req, res, url, form, { send, go, ipOf }) {
    const path = url.pathname, M = req.method;
    let m;
    const page = (c, title, text, link) => send(res, 200, P.message({ title, text, client: c, link }));
    const bad = (title = 'This link isn\'t valid', text = 'It may be old or cut short. You can reply to the email instead.') => send(res, 404, P.message({ title, text }));

    if ((m = path.match(/^\/mail\/o\/([a-z0-9.]+)\.([A-Za-z0-9_-]{22})$/))) {
      const src = m[1], s = same(m[2], sig('o:' + src)) ? parseSource(src) : null;
      if (s) await recordOpen(s).catch(() => {});
      res.writeHead(200, { 'content-type': 'image/gif', 'cache-control': 'no-store, private', 'content-length': GIF.length });
      res.end(GIF); return true;
    }
    if ((m = path.match(/^\/mail\/r\/([a-z0-9.]+)\.([A-Za-z0-9_-]{22})$/))) {
      const target = url.searchParams.get('u') ?? '';
      const src = m[1], s = /^https?:\/\//i.test(target) && same(m[2], sig(`r:${src}:${target}`)) ? parseSource(src) : null;
      if (!s) { bad(); return true; }
      await recordClick(s, target).catch(() => {});
      res.writeHead(302, { location: target, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return true;
    }
    if ((m = path.match(/^\/mail\/c\/([^/]+)$/)) && M === 'GET') {
      const id = checkId(m[1], 'c'), p = id ? await pb.get('nv_mail_people', id) : null, c = p && clientOfProduct(p.product);
      if (!p || !c) { bad('This link isn\'t valid', 'It may be old. Sign up again to get a new one.'); return true; }
      const list = listOf(c, p.list);
      if (p.status === 'pending') {
        const done = await pb.update('nv_mail_people', p.id, { status: 'active', confirmed_at: pbDate() });
        if (conf(c).on) { await enrol(c, done, 'join'); for (const t of done.tags || []) await enrol(c, done, 'tag', t); }
      } else if (p.status === 'unsubscribed') {
        page(c, 'You unsubscribed', `You left ${list?.name ?? 'this list'} after signing up. Sign up again if you'd like it back.`, c.home ? { href: c.home, label: `Back to ${c.name}` } : null); return true;
      }
      page(c, 'You\'re in', `Thanks for confirming. ${list?.name ?? c.name} will come to ${p.email}.`, c.home ? { href: c.home, label: `Back to ${c.name}` } : null); return true;
    }
    if ((m = path.match(/^\/mail\/u\/([^/]+)$/))) {
      const id = checkId(m[1], 'u'), p = id ? await pb.get('nv_mail_people', id) : null, c = p && clientOfProduct(p.product);
      if (!p || !c) { bad(); return true; }
      const list = listOf(c, p.list)?.name ?? c.name;
      if (M === 'POST') {
        if (p.status !== 'unsubscribed') await pb.update('nv_mail_people', p.id, { status: 'unsubscribed', unsubscribed_at: pbDate() });
        page(c, 'You\'re unsubscribed', `You won't get ${list} at ${p.email} any more.`, null); return true;
      }
      if (p.status === 'unsubscribed') { page(c, 'You\'re unsubscribed', `You won't get ${list} at ${p.email} any more.`, null); return true; }
      send(res, 200, P.layout({ title: 'Unsubscribe', brand: c.name, color: c.color, back: c.home, body: `<h1>Unsubscribe?</h1><p>Stop getting ${esc(list)} at ${esc(p.email)}.</p>
<form method="post" action="/mail/u/${esc(m[1])}"><button type="submit">Unsubscribe</button></form>` }));
      return true;
    }
    if (path === '/mail/join' && M === 'POST') {
      const c = clientOfProduct(String(form.product ?? '')), list = c && listOf(c, String(form.list ?? ''));
      if (!c || !list?.public || !conf(c).on) { send(res, 404, P.message({ title: 'Signup is closed', text: 'This list is not taking signups here.' })); return true; }
      if (form.website) { page(c, 'Check your email', 'We sent you a link to confirm.', null); return true; }   // the hidden field only robots fill in
      if (limited(`mailjoin:${ipOf(req)}`, 10, 3600_000)) { send(res, 429, P.message({ title: 'Slow down', text: 'Too many signups from here. Try again in an hour.', client: c })); return true; }
      const [status, out] = await join(c, { list: list.id, email: form.email, name: form.name, tags: form.tags, source: 'form' });
      if (status >= 400) { send(res, 400, P.message({ title: 'That didn\'t work', text: out.error.message, client: c })); return true; }
      page(c, out.confirm_sent ? 'Check your email' : 'You\'re in', out.confirm_sent ? `We sent a link to ${out.person.email}. Click it to confirm.` : `${list.name} will come to ${out.person.email}.`,
        c.home ? { href: c.home, label: `Back to ${c.name}` } : null);
      return true;
    }
    return false;
  }

  /** When an account is deleted: everyone on any list with that account id or email is removed. */
  async function forget(userId, email) {
    const f = [userId ? `user_id=${q(userId)}` : '', email ? `email=${q(String(email).toLowerCase())}` : ''].filter(Boolean).join(' || ');
    if (!f) return;
    for (const p of await all('nv_mail_people', f, 'id', 'id')) {
      for (const r of await all('nv_mail_runs', `person_id=${q(p.id)}`, 'id', 'id')) await pb.remove('nv_mail_runs', r.id).catch(() => {});
      await pb.remove('nv_mail_people', p.id).catch(() => {});
    }
  }

  return { api, pages, tick, forget, render: (o) => render(o), tokens: { confirmToken, unsubToken } };
}
