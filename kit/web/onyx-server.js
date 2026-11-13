// Onyx kit, server half: sign-in, saved items and the pass for a product hosted outside the Onyx server (a Vercel site,
// any Node server). One file, no dependencies, Node 18 or newer. Copy it into the product (Prebuild keeps it at
// api/_onyx.js) and make one endpoint from it:
//
//   // api/account.js
//   const { createOnyxHandler } = require('./_onyx.js');
//   module.exports = createOnyxHandler({ clientId: 'prebuild', site: 'https://prebuild.amaete.com' });
//
// The client secret comes from the ONYX_CLIENT_SECRET setting (Vercel: Project settings, Environment Variables); its
// SHA-256 sits with the product in Onyx's core/deploy/clients.json ("secret_sha256"). The person's session is this
// product's own cookie, signed with a key made from the secret, so nothing else needs storing. Every action is ?do=<name>:
//   GET  me                          { signed_in, user, pro, plans, sell, mail }
//   POST email-start { email }       a 6-digit code by email (Onyx sends it, under the product's name)
//   POST email-verify { email, code } signed in, or { needs_profile, ticket } for a first visit
//   POST profile { ticket, name, handle }
//   GET  google?back=/path           to Google and back (Onyx's Google sign-in), then to `back`
//   GET  return                      where Onyx sends the person back (the redirect_uri in clients.json)
//   POST signout
//   GET  items[&kind=]  GET item&id=  POST save { kind, name, data, thumb?, id? } ({ full, limit } when the shelf is full)  POST delete { id }
//   POST checkout { plan, back }     { url } Stripe Checkout for the product's pass   POST manage { back }  { url }
// Browser calls must be same-origin JSON (checked by Origin), so another site can't act for a signed-in person.
'use strict';
const crypto = require('node:crypto');

const b64u = (b) => Buffer.from(b).toString('base64url');
const PATH = /^\/(?!\/)[A-Za-z0-9/_.-]{0,200}$/;

function createOnyxHandler(opts) {
  const o = { core: 'https://accounts.noveniqe.com', cookie: 'onyx_s', days: 30, after: '/', ...opts };
  const secret = () => o.secret || process.env.ONYX_CLIENT_SECRET || '';
  const core = () => (process.env.ONYX_CORE_URL || o.core).replace(/\/$/, '');
  const key = () => crypto.createHmac('sha256', secret()).update('onyx-kit-session').digest();
  const secure = o.site.startsWith('https://');
  const name = (n) => (secure ? '__Host-' : '') + o.cookie + n;
  const returnUri = o.returnUri || `${o.site}/api/account?do=return`;

  // ---- signed cookies ----
  const seal = (obj) => { const p = b64u(JSON.stringify(obj)); return p + '.' + b64u(crypto.createHmac('sha256', key()).update(p).digest()); };
  const open = (raw) => {
    const [p, s] = String(raw || '').split('.');
    if (!p || !s) return null;
    const want = b64u(crypto.createHmac('sha256', key()).update(p).digest());
    if (s.length !== want.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want))) return null;
    try { const v = JSON.parse(Buffer.from(p, 'base64url').toString()); return v.exp > Date.now() ? v : null; } catch { return null; }
  };
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((x) => x[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const cookieLine = (n, v, maxAge) => `${name(n)}=${encodeURIComponent(v)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
  const addCookie = (res, line) => { const had = res.getHeader('set-cookie'); res.setHeader('set-cookie', [...(Array.isArray(had) ? had : had ? [had] : []), line]); };
  const session = (req) => open(cookies(req)[name('')]);
  const startSession = (res, r) => addCookie(res, cookieLine('', seal({ u: r.user.id, n: r.user.display_name, h: r.user.handle, exp: Date.now() + o.days * 864e5 }), o.days * 86400));

  // ---- Onyx ----
  async function call(method, path, body) {
    const r = await fetch(core() + path, { method, headers: { authorization: 'Basic ' + Buffer.from(`${o.clientId}:${secret()}`).toString('base64'),
      ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    let j = {}; try { j = await r.json(); } catch { /* empty */ }
    return { status: r.status, body: j };
  }

  // ---- small helpers ----
  const send = (res, status, obj) => { res.statusCode = status; res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); res.end(JSON.stringify(obj)); };
  const go = (res, to) => { res.statusCode = 303; res.setHeader('location', to); res.setHeader('cache-control', 'no-store'); res.end(); };
  const pass = (res, r) => send(res, r.status, r.body);
  const ipOf = (req) => String(req.headers['x-real-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0] || '').trim();
  const backOf = (v) => (PATH.test(String(v || '')) ? String(v) : o.after);
  async function bodyOf(req) {
    if (req.body !== undefined) return typeof req.body === 'string' ? JSON.parse(req.body || '{}') : req.body || {};
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 1_200_000) throw Object.assign(new Error('too large'), { status: 413 }); chunks.push(c); }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  }
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (origin) return origin === o.site || (o.devOrigins || []).includes(origin);
    return req.headers['sec-fetch-site'] === 'same-origin';
  };
  const signedIn = (res, r) => { startSession(res, r.body); return send(res, 200, { signed_in: true, user: r.body.user }); };
  const afterSignIn = (res, r) => {
    if (r.status !== 200) return pass(res, r);
    if (r.body.merge_needed) return send(res, 200, { merge_needed: true, who: r.body.who, ticket: r.body.ticket });
    if (r.body.needs_profile) return send(res, 200, { needs_profile: true, ticket: r.body.ticket, suggest: r.body.user?.display_name || '' });
    return signedIn(res, r);
  };

  return async function handler(req, res) {
    const url = new URL(req.url, o.site), act = url.searchParams.get('do') || '';
    try {
      if (!secret()) return send(res, 503, { error: { code: 'NOT_SET_UP', message: 'Accounts are not switched on here yet.' } });
      if (req.method === 'GET' && act === 'me') {
        const s = session(req);
        const p = await call('GET', `/v1/pass?user_id=${s ? s.u : 'x'.repeat(15)}`);
        if (p.status !== 200 && p.status !== 404) throw Object.assign(new Error('pass ' + p.status), { status: 503 });   // the page lets people through
        const base = { plans: p.body.plans || [], sell: !!p.body.sell };
        if (!s) return send(res, 200, { signed_in: false, ...base });
        if (p.status === 404) { addCookie(res, cookieLine('', '', 0)); return send(res, 200, { signed_in: false, ...base }); }
        return send(res, 200, { signed_in: true, user: { id: s.u, display_name: s.n, handle: s.h }, ...base,
          pro: { active: !!p.body.active, until: p.body.until, renews: !!p.body.renews, plan: p.body.plan, manage: !!p.body.manage } });
      }
      if (req.method === 'GET' && act === 'google') {
        const verifier = b64u(crypto.randomBytes(48)), state = b64u(crypto.randomBytes(12));
        addCookie(res, cookieLine('_f', seal({ v: verifier, s: state, b: backOf(url.searchParams.get('back')), exp: Date.now() + 15 * 60_000 }), 900));
        const q = new URLSearchParams({ response_type: 'code', client_id: o.clientId, redirect_uri: returnUri, state, via: 'google',
          code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256' });
        return go(res, `${core()}/authorize?${q}`);
      }
      if (req.method === 'GET' && act === 'return') {
        const f = open(cookies(req)[name('_f')]);
        addCookie(res, cookieLine('_f', '', 0));
        const back = f ? f.b : o.after, sep = back.includes('?') ? '&' : '?';
        if (!f || url.searchParams.get('state') !== f.s || !url.searchParams.get('code')) return go(res, `${back}${sep}signin=failed`);
        const r = await fetch(core() + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Basic ' + Buffer.from(`${o.clientId}:${secret()}`).toString('base64') },
          body: new URLSearchParams({ grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: returnUri, code_verifier: f.v }), signal: AbortSignal.timeout(15000) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.user) return go(res, `${back}${sep}signin=failed`);
        if (j.needs_profile) return go(res, `${back}${sep}profile=${encodeURIComponent(j.ticket)}`);
        startSession(res, { user: j.user });
        return go(res, `${back}${sep}signin=ok`);
      }
      if (req.method !== 'POST' && req.method !== 'GET') return send(res, 405, { error: { code: 'METHOD', message: 'Not allowed' } });

      // everything below acts for a person: same-origin only
      if (!sameOrigin(req)) return send(res, 403, { error: { code: 'FORBIDDEN', message: 'Not from this site' } });
      const b = req.method === 'POST' ? await bodyOf(req) : {};
      if (req.method === 'POST' && act === 'email-start') return pass(res, await call('POST', '/v1/signin/email/start', { email: String(b.email || ''), ip: ipOf(req) }));
      if (req.method === 'POST' && act === 'email-verify') return afterSignIn(res, await call('POST', '/v1/signin/email/verify', { email: String(b.email || ''), code: String(b.code || ''), ip: ipOf(req) }));
      if (req.method === 'POST' && act === 'profile') return afterSignIn(res, await call('POST', '/v1/signin/profile', { ticket: String(b.ticket || ''), display_name: String(b.name || ''), handle: String(b.handle || '') }));
      if (req.method === 'POST' && act === 'signout') { addCookie(res, cookieLine('', '', 0)); return send(res, 200, { signed_in: false }); }

      const s = session(req);
      if (!s) return send(res, 401, { error: { code: 'SIGN_IN', message: 'Sign in first' } });
      const uid = s.u;
      if (req.method === 'GET' && act === 'items') return pass(res, await call('GET', `/v1/items?user_id=${uid}${url.searchParams.get('kind') ? '&kind=' + encodeURIComponent(url.searchParams.get('kind')) : ''}`));
      if (req.method === 'GET' && act === 'item') return pass(res, await call('GET', `/v1/items/${encodeURIComponent(url.searchParams.get('id') || '')}?user_id=${uid}`));
      if (req.method === 'POST' && act === 'save') {
        const r = await call('POST', '/v1/items', { user_id: uid, kind: b.kind, name: b.name, data: b.data, thumb: b.thumb, id: b.id || undefined });
        // a full shelf is an answer, not a failure: the page offers the pass
        return r.status === 402 ? send(res, 200, { full: true, limit: r.body.limit, pass: r.body.pass }) : pass(res, r);
      }
      if (req.method === 'POST' && act === 'delete') return pass(res, await call('DELETE', `/v1/items/${encodeURIComponent(String(b.id || ''))}`, { user_id: uid }));
      if (req.method === 'POST' && act === 'checkout') return pass(res, await call('POST', '/v1/pass/checkout', { user_id: uid, plan: String(b.plan || 'month'), back: backOf(b.back) }));
      if (req.method === 'POST' && act === 'manage') return pass(res, await call('POST', '/v1/pass/manage', { user_id: uid, back: backOf(b.back) }));
      return send(res, 404, { error: { code: 'NOT_FOUND', message: 'No such action' } });
    } catch (e) {
      console.error('onyx', act, e.message);
      return send(res, e.status || 502, { error: { code: 'UNAVAILABLE', message: 'Accounts are not answering. Please try again in a minute.' } });
    }
  };
}

module.exports = { createOnyxHandler };
