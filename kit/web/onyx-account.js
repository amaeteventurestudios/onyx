// Onyx kit, browser half: the account button, the sign-in sheet (Google or a 6-digit email code), the person's saved
// items and the upgrade to the product's pass. Plain script, no dependencies; pairs with onyx-server.js. Copy it with
// onyx-account.css into the product, then:
//
//   <link rel="stylesheet" href="/assets/onyx-account.css">
//   <script src="/assets/onyx-account.js"></script>
//   Onyx.init({ api: '/api/account', brand: 'Prebuild', items: 'builds', button: '#account', onOpen: (item) => load(item.data) });
//
//   await Onyx.save({ kind: 'build', name, data, thumb })   // asks to sign in, or to upgrade when the shelf is full
//   Onyx.library()  Onyx.upgrade('year')  Onyx.account()  Onyx.signIn()  Onyx.ask('Name it', 'Name', 'My house')  Onyx.toast('Saved')
//   Onyx.me() -> { signed_in, user, pro: { active }, plans }   (also sent as the 'onyx:change' event on window)
//   if (!Onyx.gate('GLB export is part of Pro.')) return;   // a Pro-only tool: opens the Pro sheet for everyone else
//
// Colours follow the page: set --ox-bg, --ox-ink, --ox-soft, --ox-line, --ox-accent, --ox-accent-ink (they fall back to
// --paper, --ink, --soft, --line, --accent and --accent-ink, then to a light default).
(function () {
  'use strict';
  const O = { api: '/api/account', brand: 'this site', items: 'items', item: null, button: null, onOpen: null, back: null, me: null, pending: null };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const one = (s) => (O.item || s.replace(/s$/, ''));
  const back = () => O.back || location.pathname;

  async function call(act, body, method) {
    const m = method || (body ? 'POST' : 'GET');
    const r = await fetch(O.api + (O.api.includes('?') ? '&' : '?') + 'do=' + act, { method: m, credentials: 'same-origin',
      headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    let j = {}; try { j = await r.json(); } catch (e) { /* empty */ }
    return { status: r.status, ok: r.ok, body: j, msg: (j.error && j.error.message) || '' };
  }

  // ---------- state ----------
  async function me(fresh) {
    if (O.me && !fresh) return O.me;
    const r = await call('me').catch(() => null);
    O.me = r && r.ok ? r.body : { signed_in: false, plans: [], off: true };
    paintButton();
    window.dispatchEvent(new CustomEvent('onyx:change', { detail: O.me }));
    return O.me;
  }
  const pro = () => !!(O.me && O.me.pro && O.me.pro.active);
  /** For a Pro-only tool: true when the person may use it (Pro, or nothing on sale yet, or accounts not answering), otherwise
   * opens the Pro sheet with `why` and answers false. Synchronous, so it can sit in a click handler. */
  function gate(why) {
    const m = O.me;
    if (!m || m.off || !m.sell || pro()) return true;
    upgrade(null, why);
    return false;
  }

  // ---------- the sheet ----------
  let root = null, lastFocus = null;
  function sheet(html, cls) {
    if (!root) {
      root = document.createElement('div'); root.className = 'ox-root'; root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true');
      root.addEventListener('click', (e) => { if (e.target === root) close(); });
      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && root && root.classList.contains('on')) close(); });
      document.body.appendChild(root);
    }
    if (!root.classList.contains('on')) lastFocus = document.activeElement;
    root.innerHTML = `<div class="ox-card ${cls || ''}"><button class="ox-x" aria-label="Close">×</button>${html}</div>`;
    root.querySelector('.ox-x').onclick = close;
    root.classList.add('on');
    const f = root.querySelector('input,button.ox-main'); if (f) setTimeout(() => f.focus({ preventScroll: true }), 30);
    return root.querySelector('.ox-card');
  }
  function close() {
    const p = O.pending; O.pending = null; if (p) p(false);   // a sign-in someone walked away from answers no
    if (!root) return; root.classList.remove('on'); root.innerHTML = ''; if (lastFocus && lastFocus.focus) lastFocus.focus();
  }
  const err = (card, msg) => { const e = card.querySelector('.ox-err'); if (e) { e.textContent = msg || ''; e.hidden = !msg; } };
  const busy = (btn, on) => { if (btn) { btn.disabled = on; btn.classList.toggle('ox-busy', on); } };

  // ---------- signing in ----------
  function signIn(why) {
    return new Promise((resolve) => {
      O.pending = resolve;
      const card = sheet(`<h2>Sign in to ${esc(O.brand)}</h2>
        <p class="ox-sub">${esc(why || `Keep your ${O.items} and open them on any device.`)}</p>
        <button class="ox-btn ox-google" type="button"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="#4285F4" d="M22.6 12.3c0-.8-.1-1.5-.2-2.3H12v4.3h6a5 5 0 0 1-2.2 3.3v2.8h3.6c2-1.9 3.2-4.7 3.2-8.1z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.4-2.7l-3.6-2.8c-1 .7-2.3 1.1-3.8 1.1-2.9 0-5.4-2-6.3-4.6H2v2.9A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.7 14c-.2-.7-.4-1.3-.4-2s.1-1.4.4-2V7.1H2A11 11 0 0 0 1 12c0 1.8.4 3.4 1.2 4.9L5.7 14z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2 7.1L5.7 10c.9-2.6 3.4-4.6 6.3-4.6z"/></svg>Continue with Google</button>
        <div class="ox-or"><span>or use your email</span></div>
        <form class="ox-form"><label class="ox-lab">Email<input type="email" name="email" autocomplete="email" required placeholder="you@example.com"></label>
        <p class="ox-err" hidden></p><button class="ox-btn ox-main" type="submit">Email me a code</button></form>
        <p class="ox-fine">No password. We send a 6-digit code.</p>`, 'ox-signin');
      card.querySelector('.ox-google').onclick = () => { location.href = O.api + (O.api.includes('?') ? '&' : '?') + 'do=google&back=' + encodeURIComponent(back()); };
      card.querySelector('form').onsubmit = async (e) => {
        e.preventDefault();
        const email = e.target.email.value.trim(), btn = e.target.querySelector('button');
        busy(btn, true); err(card, '');
        const r = await call('email-start', { email }).catch(() => ({ msg: 'No connection. Try again.' }));
        busy(btn, false);
        if (!r.ok) return err(card, r.msg || 'Something went wrong. Try again.');
        codeStep(email, r.body.masked || email);
      };
    });
  }
  function codeStep(email, masked) {
    const card = sheet(`<h2>Check your email</h2><p class="ox-sub">We sent a 6-digit code to <b>${esc(masked)}</b>.</p>
      <form class="ox-form"><label class="ox-lab">Code<input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required placeholder="123456" class="ox-code"></label>
      <p class="ox-err" hidden></p><button class="ox-btn ox-main" type="submit">Sign in</button></form>
      <p class="ox-fine"><button class="ox-link" type="button" data-a="again">Send a new code</button> · <button class="ox-link" type="button" data-a="other">Use another email</button></p>`, 'ox-signin');
    const keep = O.pending;
    card.querySelector('[data-a=other]').onclick = () => { signIn(); O.pending = keep; };
    card.querySelector('[data-a=again]').onclick = async () => { const r = await call('email-start', { email }); err(card, r.ok ? '' : r.msg); if (r.ok) toast('New code sent'); };
    const input = card.querySelector('input');
    input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 6); if (input.value.length === 6) card.querySelector('form').requestSubmit(); });
    card.querySelector('form').onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector('button'); busy(btn, true); err(card, '');
      const r = await call('email-verify', { email, code: input.value }).catch(() => ({ msg: 'No connection. Try again.' }));
      busy(btn, false);
      if (!r.ok) return err(card, r.msg || 'That did not work. Try again.');
      afterSignIn(r.body, keep);
    };
  }
  function profileStep(ticket, suggest, keep) {
    const handle = String(suggest || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 14);
    const card = sheet(`<h2>Welcome</h2><p class="ox-sub">What should we call you?</p>
      <form class="ox-form"><label class="ox-lab">Your name<input name="name" autocomplete="name" required maxlength="40" value="${esc(suggest)}"></label>
      <label class="ox-lab">Username<span class="ox-at"><i>@</i><input name="handle" autocomplete="username" required maxlength="20" value="${esc(handle)}" placeholder="yourname"></span></label>
      <p class="ox-fine">One account works across the Amaete apps. Your username is how others find you.</p>
      <p class="ox-err" hidden></p><button class="ox-btn ox-main" type="submit">Continue</button></form>`, 'ox-signin');
    const f = card.querySelector('form');
    f.name.addEventListener('input', () => { if (!f.handle.dataset.touched) f.handle.value = f.name.value.toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 14); });
    f.handle.addEventListener('input', () => { f.handle.dataset.touched = 1; });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const btn = f.querySelector('button.ox-main'); busy(btn, true); err(card, '');
      const r = await call('profile', { ticket, name: f.name.value, handle: f.handle.value.replace(/^@/, '') }).catch(() => ({ msg: 'No connection. Try again.' }));
      busy(btn, false);
      if (!r.ok) return err(card, r.msg || 'That did not work. Try again.');
      afterSignIn(r.body, keep);
    };
  }
  async function afterSignIn(b, keep) {
    if (b.needs_profile) return profileStep(b.ticket, b.suggest, keep);
    await me(true);
    O.pending = null; close();
    toast(`Signed in as ${(O.me.user && (O.me.user.display_name || '@' + O.me.user.handle)) || 'you'}`);
    if (keep) keep(true);
  }
  async function needSignIn(why) { const m = await me(); if (m.signed_in) return true; return signIn(why); }

  // ---------- saved items ----------
  async function save({ kind, name, data, thumb, id }) {
    if (!(await needSignIn(`Sign in to keep this in your ${O.items}. It's free.`))) return null;
    const r = await call('save', { kind, name, data, thumb, id }).catch(() => ({ msg: 'No connection. Try again.' }));
    if (r.ok && r.body.full) { if (r.body.pass) toast(`Your ${O.items} are full (${r.body.limit}). Delete one to make room.`); else upgrade(null, `Free accounts keep ${r.body.limit} ${O.items}. Go Pro to keep as many as you like.`); return null; }
    if (r.status === 401) { O.me = null; return save({ kind, name, data, thumb, id }); }
    if (!r.ok) { toast(r.msg || 'Could not save. Try again.'); return null; }
    toast(`Saved to your ${O.items}`);
    return r.body.item;
  }
  async function load(id) { const r = await call('item&id=' + encodeURIComponent(id)); return r.ok ? r.body.item : null; }
  async function remove(id) { const r = await call('delete', { id }); return r.ok; }
  async function library(kind) {
    if (!(await needSignIn(`Sign in to see your ${O.items}.`))) return;
    const card = sheet(`<h2>Your ${esc(O.items)}</h2><div class="ox-shelf"><p class="ox-sub">Loading…</p></div>`, 'ox-wide');
    const r = await call('items' + (kind ? '&kind=' + encodeURIComponent(kind) : ''));
    const box = card.querySelector('.ox-shelf');
    if (!r.ok) { box.innerHTML = `<p class="ox-err">${esc(r.msg || 'Could not load. Try again.')}</p>`; return; }
    const { items, used, limit, pass } = r.body;
    const meter = `<div class="ox-meter"><span>${used} of ${limit} saved</span><i style="--w:${Math.min(100, (used / limit) * 100)}%"></i>${pass || !(O.me && O.me.sell) ? '' : `<button class="ox-link" data-a="pro">Go Pro for unlimited</button>`}</div>`;
    if (!items.length) { box.innerHTML = meter + `<p class="ox-empty">Nothing saved yet. Use <b>Save to my ${esc(O.items)}</b> and it shows up here on every device.</p>`; }
    else box.innerHTML = meter + `<ul class="ox-grid">${items.map((it) => `<li data-id="${esc(it.id)}"><button class="ox-open" title="Open">${it.thumb ? `<img src="${esc(it.thumb)}" alt="">` : '<span class="ox-ph"></span>'}<b>${esc(it.name)}</b><small>${new Date(String(it.updated).replace(' ', 'T')).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}</small></button><button class="ox-del" title="Delete" aria-label="Delete ${esc(it.name)}">Delete</button></li>`).join('')}</ul>`;
    const p = box.querySelector('[data-a=pro]'); if (p) p.onclick = () => upgrade();
    box.querySelectorAll('.ox-open').forEach((b) => { b.onclick = async () => {
      const id = b.closest('li').dataset.id; b.classList.add('ox-busy');
      const it = await load(id);
      if (!it) { b.classList.remove('ox-busy'); return toast('Could not open it. Try again.'); }
      close(); if (O.onOpen) O.onOpen(it);
    }; });
    box.querySelectorAll('.ox-del').forEach((b) => { b.onclick = async () => {
      if (b.dataset.sure !== '1') { b.dataset.sure = '1'; b.textContent = 'Sure?'; return; }
      if (await remove(b.closest('li').dataset.id)) library(kind); else toast('Could not delete. Try again.');
    }; });
  }

  /** A small sheet asking for one line of text (naming a save). Resolves with the text, or null if closed. */
  function ask(title, label, value, okText) {
    return new Promise((resolve) => {
      const card = sheet(`<h2>${esc(title)}</h2><form class="ox-form"><label class="ox-lab">${esc(label)}<input name="v" maxlength="120" required value="${esc(value || '')}"></label>
        <button class="ox-btn ox-main" type="submit">${esc(okText || 'Save')}</button></form>`);
      O.pending = resolve;   // closing the sheet answers false
      const f = card.querySelector('form'); setTimeout(() => f.v.select(), 40);
      f.onsubmit = (e) => { e.preventDefault(); O.pending = null; const v = f.v.value.trim(); close(); resolve(v || null); };
    }).then((v) => v || null);
  }

  // ---------- the pass ----------
  async function upgrade(plan, why) {
    const m = await me();
    if (pro()) return account();
    const plans = m.plans || [];
    if (!m.sell || !plans.length) { sheet(`<h2>${esc(O.brand)} Pro</h2><p class="ox-sub">Pro opens very soon. ${why ? esc(why) : ''}</p>`); return; }
    const pick = plans.find((p) => p.id === plan) || plans.find((p) => p.id === 'month') || plans[0];
    const card = sheet(`<h2>${esc(O.brand)} Pro</h2><p class="ox-sub">${esc(why || 'Everything, with no limits.')}</p>
      <div class="ox-plans">${plans.map((p) => `<label class="ox-plan"><input type="radio" name="plan" value="${esc(p.id)}" ${p === pick ? 'checked' : ''}><span><b>${esc(p.name)}</b><em>$${esc(p.monthly)}<small>/mo</small></em><small>${p.months > 1 ? `Billed $${esc(p.price)} a year` : 'Billed monthly'}</small></span></label>`).join('')}</div>
      <p class="ox-err" hidden></p><button class="ox-btn ox-main" type="button">${pick.trial_days ? `Start ${pick.trial_days}-day free trial` : 'Continue to payment'}</button>
      <p class="ox-fine">${pick.trial_days ? `Free for ${pick.trial_days} days, then billed. ` : ''}Cancel any time in one click. Payments by Stripe.</p>`);
    const btn = card.querySelector('.ox-main');
    card.querySelector('.ox-main').onclick = async () => {
      const id = card.querySelector('input[name=plan]:checked').value;
      if (!(await needSignIn('Sign in first, so Pro is yours on every device.'))) return;
      if (pro()) return account();
      const again = root && root.classList.contains('on') ? root.querySelector('.ox-main') : null;
      busy(again || btn, true);
      const r = await call('checkout', { plan: id, back: back() }).catch(() => ({ msg: 'No connection. Try again.' }));
      if (r.ok && r.body.url) { location.href = r.body.url; return; }
      busy(again || btn, false);
      if (root && root.classList.contains('on')) err(root.querySelector('.ox-card'), r.msg || 'Could not open checkout. Try again.'); else toast(r.msg || 'Could not open checkout.');
    };
  }
  async function manage() {
    const r = await call('manage', { back: back() });
    if (r.ok && r.body.url) location.href = r.body.url; else toast(r.msg || 'Could not open billing. Try again.');
  }

  // ---------- the account ----------
  async function account() {
    const m = await me(true);
    if (!m.signed_in) return signIn();
    const u = m.user, p = m.pro || {};
    const until = p.until ? new Date(p.until).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : '';
    const card = sheet(`<div class="ox-who"><span class="ox-av">${esc((u.display_name || u.handle || '?').trim().charAt(0).toUpperCase())}</span><div><h2>${esc(u.display_name || 'You')}</h2><p class="ox-sub">@${esc(u.handle)}</p></div></div>
      <div class="ox-status ${p.active ? 'on' : ''}"><b>${p.active ? `${esc(O.brand)} Pro` : 'Free'}</b><span>${p.active ? (p.plan === 'staff' ? 'Included for the team' : p.renews ? `Renews ${esc(until)}` : `Until ${esc(until)}`) : 'Go Pro for every tool and unlimited saves'}</span></div>
      <div class="ox-acts"><button class="ox-btn" data-a="lib">Your ${esc(O.items)}</button>${p.active ? (p.manage ? '<button class="ox-btn" data-a="manage">Manage subscription</button>' : '') : '<button class="ox-btn ox-main" data-a="pro">Go Pro</button>'}<button class="ox-btn ox-ghost" data-a="out">Sign out</button></div>`);
    card.querySelector('[data-a=lib]').onclick = () => library();
    const a = (k, f) => { const b = card.querySelector(`[data-a=${k}]`); if (b) b.onclick = f; };
    a('manage', manage); a('pro', () => upgrade());
    a('out', async () => { await call('signout', {}); O.me = null; await me(true); close(); toast('Signed out'); });
  }

  // ---------- the button and the toast ----------
  function paintButton() {
    const el = O.button; if (!el) return;
    const m = O.me;
    if (m && m.signed_in) {
      const n = (m.user.display_name || m.user.handle || '?').trim();
      el.innerHTML = `<span class="ox-av">${esc(n.charAt(0).toUpperCase())}</span><span class="ox-bl">${esc(n.split(' ')[0])}${pro() ? ' <i class="ox-pro">PRO</i>' : ''}</span>`;
      el.title = 'Your account'; el.classList.add('ox-in');
    } else { el.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg><span class="ox-bl">Sign in</span>`; el.title = 'Sign in'; el.classList.remove('ox-in'); }
  }
  let toastEl = null, toastT = 0;
  function toast(msg) {
    if (!toastEl) { toastEl = document.createElement('div'); toastEl.className = 'ox-toast'; toastEl.setAttribute('role', 'status'); document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add('on'); clearTimeout(toastT); toastT = setTimeout(() => toastEl.classList.remove('on'), 3200);
  }

  // ---------- start ----------
  function init(o) {
    Object.assign(O, o || {});
    if (typeof O.button === 'string') O.button = document.querySelector(O.button);
    if (O.button) { O.button.classList.add('ox-button'); O.button.addEventListener('click', () => (O.me && O.me.signed_in ? account() : signIn())); }
    // coming back from Google or Stripe
    const q = new URLSearchParams(location.search), was = q.toString();
    const profile = q.get('profile'), signin = q.get('signin'), passed = q.get('pass');
    ['profile', 'signin', 'pass'].forEach((k) => q.delete(k));
    if (q.toString() !== was) history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : '') + location.hash);
    me(true).then(() => {
      if (profile) profileStep(profile, '', null);
      else if (signin === 'ok') toast('Signed in');
      else if (signin === 'failed') toast('Sign-in did not finish. Please try again.');
      if (passed === 'ok') { sheet(`<h2>Welcome to ${esc(O.brand)} Pro</h2><p class="ox-sub">Every tool is open and your ${esc(O.items)} have no limit. It can take a few seconds to show.</p><button class="ox-btn ox-main" type="button">Start building</button>`).querySelector('.ox-main').onclick = close; setTimeout(() => me(true), 4000); }
    });
    return Onyx;
  }

  const Onyx = { init, me, isPro: pro, gate, signIn, account, library, upgrade, manage, save, load, remove, ask, toast, close };
  window.Onyx = Onyx;
})();
