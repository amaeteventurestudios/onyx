// The console: the owner's screen for this accounts site (accounts.amaete.com/console for the studio's sites and products,
// accounts.noveniqe.com/console for the games). Every product on this site, how many people signed up on each and when, and
// the people themselves: name, @handle, email, how they sign in, the product they first joined from, every product they have
// used since, and their last sign-in. Download as CSV.
//
// Who can open it: staff holding platform.users.view (Super Administrator or Platform Administrator), after the second
// sign-in step. Plain server-rendered HTML with no scripts, like the other pages here.
import { q, fromPb } from './pb.mjs';
import { esc } from './util.mjs';

const DAY = 86400_000;
const PAGE = 100;

export function makeConsole({ cfg, pb, A }) {
  /** Everyone on this site with what we know about them, newest first. Small sites only (a few thousand people). */
  async function everyone() {
    const realm = await A.realm();
    const all = async (coll, filter, fields, max = 5000) => {   // every row (200 a page)
      const out = [];
      for (let page = 1; page <= max; page++) {
        const b = await pb.list(coll, { filter, sort: '-created', perPage: 200, page, fields });
        out.push(...b); if (b.length < 200) break;
      }
      return out;
    };
    const accts = await all('nv_accounts', "kind='member'", 'user_id,created_by_client,created,merged_into');
    const users = new Map((await all('users', `tenant_id=${q(realm)} && account_status='active'`, 'id,email,display_name,handle,created')).map((u) => [u.id, u]));
    const via = {};
    for (const m of await all('nv_identities', '', 'user_id,provider,last_used_at')) (via[m.user_id] ??= new Set()).add(m.provider);
    const used = {}, last = {}, signins = [];
    // a sign-in, or opening another product while already signed in (auth.product_opened)
    for (const e of await all('audit_events', `tenant_id=${q(realm)} && (action='auth.sign_in' || action='auth.product_opened')`, 'object_id,metadata_safe,created')) {
      if (!last[e.object_id] || e.created > last[e.object_id]) last[e.object_id] = e.created;
      const c = e.metadata_safe?.client; if (!c || c === '_self') continue;
      (used[e.object_id] ??= new Set()).add(c);
      signins.push({ client: c, at: e.created });
    }
    const people = [];
    for (const a of accts) {
      if (a.merged_into) continue;
      const u = users.get(a.user_id); if (!u) continue;
      const first = a.created_by_client && a.created_by_client !== '_self' ? a.created_by_client : '';
      const products = new Set([...(first ? [first] : []), ...(used[u.id] ?? [])]);
      people.push({ id: u.id, name: u.display_name || '', handle: u.handle || '', email: u.email || '', via: [...(via[u.id] ?? [])].sort(),
        first, products: [...products], joined: a.created, last: last[u.id] || '' });
    }
    return { people, signins };
  }

  const nameOf = (id) => cfg.clients[id]?.name ?? id;
  const when = (s) => (s ? String(s).slice(0, 10) : '');
  const viaWord = (v) => v.map((x) => (x === 'google' ? 'Google' : 'Email code')).join(', ') || 'None';

  function summary({ people, signins }) {
    const now = Date.now(), week = now - 7 * DAY;
    return Object.values(cfg.clients).map((c) => {
      const mine = people.filter((p) => p.products.includes(c.id));
      return { id: c.id, name: c.name, color: c.color, home: c.home,
        people: mine.length, joined: people.filter((p) => p.first === c.id).length,
        week: people.filter((p) => p.first === c.id && fromPb(p.joined) > new Date(week)).length,
        signinsWeek: signins.filter((x) => x.client === c.id && fromPb(x.at) > new Date(week)).length };
    }).sort((a, b) => b.people - a.people || a.name.localeCompare(b.name));
  }

  function filtered(people, product, term) {
    const t = String(term ?? '').trim().toLowerCase();
    return people.filter((p) => (!product || p.products.includes(product))
      && (!t || `${p.name} ${p.handle} ${p.email}`.toLowerCase().includes(t)));
  }

  const HEX = /^#[0-9a-fA-F]{6}$/;
  function layout(title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>
:root{--bg:#f6f6f4;--card:#fff;--ink:#16181d;--muted:#5d6370;--line:#dcdde1;--accent:#16181d;--soft:#eeeeea}
@media (prefers-color-scheme:dark){:root{--bg:#121316;--card:#1c1e23;--ink:#f1f2f4;--muted:#a3a8b3;--line:#33363d;--accent:#f1f2f4;--soft:#25282e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
main{max-width:1240px;margin:0 auto;padding:28px 20px 56px}a{color:inherit}
header{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:24px}
.brand{font-weight:800;font-size:20px;letter-spacing:-.01em}.brand small{font-weight:500;color:var(--muted);font-size:14px;margin-left:8px}
.who{color:var(--muted);font-size:14px}.who a{margin-left:12px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 12px}.muted{color:var(--muted)}
.totals{display:flex;gap:12px;flex-wrap:wrap;margin:16px 0 8px}.total{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 18px;min-width:150px}
.total b{display:block;font-size:28px;line-height:1.1}.total span{color:var(--muted);font-size:13px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.prod{display:block;text-decoration:none;background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;border-top:4px solid var(--c,#888)}
.prod.on{outline:2px solid var(--accent);outline-offset:1px}.prod h3{margin:0 0 10px;font-size:16px}
.prod dl{display:grid;grid-template-columns:1fr auto;gap:2px 10px;margin:0;font-size:14px}.prod dt{color:var(--muted)}.prod dd{margin:0;font-weight:700;text-align:right}
form.find{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:0 0 12px}
form.find input,form.find select{font:inherit;padding:9px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);min-width:0;flex:1 1 200px}
.btn{display:inline-block;font:inherit;font-weight:600;padding:9px 14px;border-radius:10px;border:1px solid var(--accent);background:var(--accent);color:var(--bg);text-decoration:none;cursor:pointer;white-space:nowrap}
.btn.quiet{background:transparent;color:var(--ink);border-color:var(--line)}
.table{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:14px}
table{border-collapse:collapse;width:100%;min-width:860px}th,td{text-align:left;padding:10px 12px;border-top:1px solid var(--line);vertical-align:top;font-size:14px}
thead th{border-top:0;color:var(--muted);font-weight:600;font-size:13px;background:var(--soft)}td.email{word-break:break-all}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;background:var(--soft);font-size:12px;margin:0 4px 4px 0;white-space:nowrap}
.pages{display:flex;gap:8px;justify-content:space-between;align-items:center;margin-top:12px;flex-wrap:wrap}
.empty{padding:28px;text-align:center;color:var(--muted)}
@media (max-width:640px){main{padding:20px 14px 40px}h1{font-size:22px;text-align:center}.sub{text-align:center}.totals{justify-content:center}.total{flex:1 1 140px}
table{min-width:0}thead{display:none}tr{display:block;border-top:1px solid var(--line);padding:10px 4px}tr:first-child{border-top:0}
td{display:block;border:0;padding:2px 10px}td[data-k]:before{content:attr(data-k) ": ";color:var(--muted);font-size:12px}td.n{font-weight:700;font-size:15px}td.n:before{content:none}}
</style></head><body><main>${body}</main></body></html>`;
  }

  function page({ user, data, product, term, pageNo }) {
    const sum = summary(data), list = filtered(data.people, product, term);
    const pages = Math.max(1, Math.ceil(list.length / PAGE)), n = Math.min(Math.max(1, pageNo || 1), pages);
    const shown = list.slice((n - 1) * PAGE, n * PAGE);
    const now = Date.now();
    const total = data.people.length, week = data.people.filter((p) => fromPb(p.joined) > new Date(now - 7 * DAY)).length;
    const today = data.people.filter((p) => fromPb(p.joined) > new Date(now - DAY)).length;
    const link = (o) => { const s = new URLSearchParams(); const v = { product, q: term, ...o }; for (const k of ['product', 'q', 'page']) if (v[k]) s.set(k, v[k]); return `/console${s.toString() ? '?' + s : ''}`; };
    const csv = `/console/people.csv${product ? '?product=' + encodeURIComponent(product) : ''}`;
    return layout(`${cfg.brand} console`, `
<header><div class="brand">${esc(cfg.brand)} console<small>${esc(cfg.publicUrl.replace(/^https?:\/\//, ''))}</small></div>
<div class="who">Signed in as ${esc(user.display_name || '@' + user.handle)}<a href="/account">Your account</a></div></header>
<h1>${product ? esc(nameOf(product)) : 'Everyone'}</h1>
<p class="sub muted">People who made an account here. Each person has one account across every product on this site.</p>
<div class="totals"><div class="total"><b>${total}</b><span>people in all</span></div><div class="total"><b>${week}</b><span>joined in the last 7 days</span></div><div class="total"><b>${today}</b><span>joined today</span></div></div>
<h2>Products</h2>
<div class="grid">${sum.map((c) => `<a class="prod${product === c.id ? ' on' : ''}" href="${esc(link({ product: product === c.id ? '' : c.id, page: '' }))}" style="--c:${HEX.test(c.color ?? '') ? c.color : '#888'}">
<h3>${esc(c.name)}</h3><dl><dt>People</dt><dd>${c.people}</dd><dt>Signed up here first</dt><dd>${c.joined}</dd><dt>New this week</dt><dd>${c.week}</dd><dt>Sign-ins this week</dt><dd>${c.signinsWeek}</dd></dl></a>`).join('')}</div>
<h2>${product ? `People on ${esc(nameOf(product))}` : 'All people'} <span class="muted">(${list.length})</span></h2>
<form class="find" method="get" action="/console"><select name="product" aria-label="Product"><option value="">Every product</option>${sum.map((c) => `<option value="${esc(c.id)}"${product === c.id ? ' selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
<input name="q" value="${esc(term || '')}" placeholder="Search name, @handle or email" aria-label="Search"><button class="btn" type="submit">Show</button><a class="btn quiet" href="${esc(csv)}">Download CSV</a></form>
<div class="table">${shown.length ? `<table><thead><tr><th>Name</th><th>Email</th><th>Signs in with</th><th>First joined from</th><th>Uses</th><th>Joined</th><th>Last sign-in</th></tr></thead><tbody>
${shown.map((p) => `<tr><td class="n">${esc(p.name || 'No name yet')}${p.handle ? `<br><span class="muted">@${esc(p.handle)}</span>` : ''}</td><td class="email" data-k="Email">${esc(p.email)}</td>
<td data-k="Signs in with">${esc(viaWord(p.via))}</td><td data-k="First joined from">${esc(p.first ? nameOf(p.first) : 'This site')}</td>
<td data-k="Uses">${p.products.map((x) => `<span class="tag">${esc(nameOf(x))}</span>`).join('') || '<span class="muted">None yet</span>'}</td>
<td data-k="Joined">${esc(when(p.joined))}</td><td data-k="Last sign-in">${esc(when(p.last)) || '<span class="muted">Not yet</span>'}</td></tr>`).join('')}</tbody></table>`
    : `<p class="empty">${total ? 'Nobody matches.' : 'Nobody has signed up yet. People show up here the moment they make an account.'}</p>`}</div>
${pages > 1 ? `<div class="pages"><span class="muted">Page ${n} of ${pages}</span><span>${n > 1 ? `<a class="btn quiet" href="${esc(link({ page: n - 1 }))}">Newer</a> ` : ''}${n < pages ? `<a class="btn quiet" href="${esc(link({ page: n + 1 }))}">Older</a>` : ''}</span></div>` : ''}`);
  }

  const cell = (v) => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
  function csv(data, product) {
    const rows = [['name', 'handle', 'email', 'signs_in_with', 'first_joined_from', 'uses', 'joined', 'last_sign_in']];
    for (const p of filtered(data.people, product, '')) rows.push([p.name, p.handle, p.email, viaWord(p.via), p.first ? nameOf(p.first) : '', p.products.map(nameOf).join('; '), p.joined, p.last]);
    return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
  }

  return { everyone, page, csv };
}
