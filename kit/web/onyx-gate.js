// Onyx kit: one free scene, then sign in. For the studio's 3D sites (lessons, dioramas, cutaways, worlds): a visitor opens one
// scene free; opening a different one asks them to sign in (Google or a 6-digit email code, through Onyx), free. Signed-in
// people are never asked again on that device. Plain script, no dependencies; it loads onyx-account.js and .css from its own
// folder only when it needs them, so a free visit costs nothing.
//
//   <script src="/onyx/onyx-gate.js" data-brand="Amaete Cutaways" data-scene="kente-loom" defer></script>
//
// Or from the site's own runtime (one line in the shared kit, so generated pages need no change):
//   onyxGate('kente-loom', 'Amaete Cutaways')   // see onyxGate() at the bottom of this comment
// A one-page app that switches scenes without reloading (3D Worlds) loads it with data-manual and calls
// OnyxGate.check(sceneId) each time a scene opens.
//
// data-scene  this page's scene id (default: the first part of the address, /kente-loom/ -> kente-loom). Pages without the
//             tag (home, lists, about) are never counted.
// data-free   how many different scenes are free (default 1)
// data-home   where "Not now" goes (default /)
// data-api    the product's account endpoint (default /api/account, onyx-server.js)
// data-items  what the product calls a scene in the sign-in sheet (default "scenes")
// If accounts are not switched on yet, or not answering, the gate lets everyone through: it never locks people out by mistake.
// Inside a frame (SavvyMe and the class app play these pages in their own player) the host decides, so the gate stays out.
// window.OnyxGate: { check(scene?), reset(), seen() }.
//
//   function onyxGate(scene, brand) {   // the loader each site's runtime carries
//     if (window.self !== window.top) return;
//     if (window.OnyxGate) return window.OnyxGate.check(scene);
//     const s = document.createElement('script'); s.src = '/onyx/onyx-gate.js'; s.dataset.manual = ''; s.dataset.brand = brand;
//     s.onload = () => window.OnyxGate.check(scene); document.head.appendChild(s);
//   }
(function () {
  'use strict';
  const me = document.currentScript;
  if (!me) return;
  const d = me.dataset, base = me.src.replace(/[^/]*$/, '');
  const free = Math.max(0, Number(d.free ?? 1));
  const sceneOf = (x) => String(x || d.scene || location.pathname.split('/').filter(Boolean)[0] || '').slice(0, 80);
  const api = d.api || '/api/account', home = d.home || '/';
  const brand = d.brand || document.title.split(/[·|–-]/).pop().trim() || 'this site';
  const KEY = 'ox_free_scenes', IN = 'ox_signed_in';
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  const seen = () => { try { const v = JSON.parse(store.get(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch (e) { return []; } };

  let loading = null;
  function kit() {
    if (window.Onyx) return Promise.resolve(window.Onyx);
    if (loading) return loading;
    loading = new Promise((ok, no) => {
      const css = document.createElement('link'); css.rel = 'stylesheet'; css.href = base + 'onyx-account.css'; document.head.appendChild(css);
      const s = document.createElement('script'); s.src = base + 'onyx-account.js';
      s.onload = () => ok(window.Onyx.init({ api, brand, items: d.items || 'scenes' })); s.onerror = no;
      document.head.appendChild(s);
    });
    return loading;
  }

  let busy = null, busyScene = null;
  function check(x) {   // one check at a time; a different scene waits its turn and gets its own answer
    const scene = sceneOf(x);
    if (busy && busyScene === scene) return busy;
    const p = (busy || Promise.resolve()).catch(() => {}).then(() => run(scene));
    busy = p; busyScene = scene;
    p.finally(() => { if (busy === p) { busy = null; busyScene = null; } }).catch(() => {});
    return p;
  }
  async function run(scene) {
    try { if (window.self !== window.top) return true; } catch (e) { return true; }
    const q = new URLSearchParams(location.search);
    const back = q.has('signin') || q.has('profile');   // coming back from Google: let the kit finish the sign-in
    const list = seen();
    if (!back) {
      if (store.get(IN) === '1' || !scene) return true;
      if (list.includes(scene)) return true;
      if (list.length < free) { list.push(scene); store.set(KEY, JSON.stringify(list.slice(-50))); return true; }
    }
    let O;
    try { O = await kit(); } catch (e) { return true; }
    const m = await O.me();
    if (m.off) return true;                              // accounts not switched on here yet, or not answering
    if (m.signed_in) { store.set(IN, '1'); return true; }
    if (back && q.get('profile')) {                      // the kit is asking for a name: wait for it
      return new Promise((ok) => window.addEventListener('onyx:profile', (e) => {
        if (e.detail && e.detail.ok) { store.set(IN, '1'); ok(true); } else { location.href = home; ok(false); }
      }, { once: true }));
    }
    if (back && (list.includes(scene) || list.length < free)) return true;
    const ok = await O.signIn(`You've had your free ${free === 1 ? 'scene' : free + ' scenes'}. Sign in to open every one. It's free, and one account works across the Amaete sites.`);
    if (ok) { store.set(IN, '1'); return true; }
    location.href = home;
    return false;
  }

  window.addEventListener('onyx:change', (e) => { if (e.detail && e.detail.signed_in) store.set(IN, '1'); else if (e.detail && !e.detail.off) { try { localStorage.removeItem(IN); } catch (x) { /* private mode */ } } });
  window.OnyxGate = { check, seen, reset() { try { localStorage.removeItem(KEY); localStorage.removeItem(IN); } catch (e) { /* private mode */ } } };
  if (me.hasAttribute('data-manual')) return;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => check()); else check();
})();
