// The people admin pages: accounts site /admin/<product>, one place to run who can use each product that has
// "people": true. Tabs: Team, Customers, Waiting to join, Roles, Activity. Plain server-rendered HTML forms, no scripts,
// light and dark, phone first. Each page wears the product's own name and colour; the accounts site's name never shows.
// Who sees and may do what follows PERMISSIONS in lib/people.mjs.
import { esc, same } from './util.mjs';
import { PERMISSIONS, PERMISSION_TEXT, PeopleError, ROLES, can, roleLabel } from './people.mjs';

const TABS = [['team', 'Team'], ['customers', 'Customers'], ['invites', 'Waiting to join'], ['roles', 'Roles'], ['activity', 'Activity']];
const HEX = /^#[0-9a-fA-F]{6}$/;

/** "November 3, 2026" */
export const day = (iso) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const when = (iso) => (iso ? `${day(iso)}, ${new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })} UTC` : '');
function ago(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.round(s / 86400);
  return d === 1 ? '1 day ago' : d < 30 ? `${d} days ago` : day(iso);
}
const initials = (name, email) => (String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('') || String(email || '?')[0]).toUpperCase();
const help = (text) => `<details class="help"><summary aria-label="What is this?">?</summary><p>${esc(text)}</p></details>`;

/**
 * deps: { cfg, P (people), A, me (user), csrf, send(status, html), go(location), mail: { send(inv, client, by) → bool } }
 * Returns once it has answered.
 */
export async function adminPages({ req, url, form, me, csrf, P, send, go, sendInvite }) {
  const parts = url.pathname.split('/').filter(Boolean);   // ['admin', product?, tab?, action?]
  const meEmail = P.verifiedEmail(me);
  const mine = [];
  for (const c of P.products()) { const a = await P.accessOf(c.id, me); if (can(a.role, 'seePeople')) mine.push({ c, a }); }

  if (parts.length === 1) {
    if (!mine.length) return send(403, shell({ title: 'People', me, body: `<section class="center"><h1>Not for this account</h1><p class="muted">Only the people who run a product can open this page. Ask its admin.</p><p><a href="/account">Your account</a></p></section>` }));
    if (mine.length === 1) return go(`/admin/${mine[0].c.id}/team`);
    const cards = [];
    for (const { c, a } of mine) {
      const n = (await P.list(c.id, a.org)).length;
      cards.push(`<a class="prod" href="/admin/${esc(c.id)}/team" style="--c:${HEX.test(c.color ?? '') ? c.color : '#555'}"><b>${esc(c.name)}</b><span>${n} ${n === 1 ? 'person' : 'people'} · you are ${esc(roleLabel(a.role).toLowerCase())}</span></a>`);
    }
    return send(200, shell({ title: 'People', me, body: `<h1>People</h1><p class="lead">Pick a product to run who can use it.</p><div class="prods">${cards.join('')}</div>` }));
  }

  const client = P.product(parts[1]);
  if (!client) return send(404, shell({ title: 'Not found', me, body: '<section class="center"><h1>Not found</h1><p class="muted">There is no such product here.</p></section>' }));
  const access = await P.accessOf(client.id, me);
  if (!can(access.role, 'seePeople')) return send(403, shell({ title: client.name, me, client, body: `<section class="center"><h1>Not for this account</h1><p class="muted">You do not run ${esc(client.name)}. Ask its admin.</p></section>` }));
  const actor = { role: access.role, org: access.org, email: meEmail };
  const tab = TABS.some(([id]) => id === parts[2]) ? parts[2] : 'team';
  const base = `/admin/${client.id}`;
  const back = (to, msg) => go(`${base}/${to}?${new URLSearchParams(msg)}`);
  const by = meEmail || me.id;

  if (req.method === 'POST') {
    if (!same(form.csrf ?? '', csrf)) return back(tab, { err: 'That page expired. Please try again.' });
    const action = parts[3] ?? '';
    try {
      const target = async () => {
        const list = await P.list(client.id);
        const v = list.find((x) => x.email === String(form.email ?? '').trim().toLowerCase());
        if (!v?.role) throw new PeopleError('That person has no access here.', 404);
        if (actor.org && v.org !== actor.org) throw new PeopleError('That person is not in your organization.', 403);
        return v;
      };
      if (tab === 'team' && action === 'add') {
        const org = actor.org ?? (form.org || null);
        P.mayInvite(actor, form.role ?? '', org);
        if (form.how === 'now') {
          await P.setRole(client.id, { email: form.email, role: form.role, name: form.name, org, viewOnly: form.view_only === '1' }, by);
          return back('team', { ok: `${String(form.email).trim()} can use ${client.name} now. They sign in with that email.` });
        }
        const inv = await P.invite(client.id, { email: form.email, role: form.role, name: form.name, org, viewOnly: form.view_only === '1' }, by);
        const sent = await sendInvite(inv, client, me.display_name || by).catch(() => false);
        return back('invites', sent ? { ok: `Invitation emailed to ${inv.email}.` } : { err: `Invitation made for ${inv.email}, but the email could not be sent. Tell them to sign in at ${client.home} with that email.` });
      }
      if (tab === 'team' && action === 'role') {
        const v = await target();
        P.mayManage(actor, v);
        const org = actor.org ?? (form.org || null);
        P.mayInvite(actor, form.role ?? '', org);
        await P.setRole(client.id, { email: v.email, role: form.role, org, viewOnly: form.view_only === '1', ...(form.extra !== undefined && !actor.org ? { extra: form.extra } : {}) }, by);
        return back(form.from === 'customers' ? 'customers' : 'team', { ok: `Saved ${v.email}.` });
      }
      if (tab === 'team' && action === 'remove') {
        const v = await target();
        P.mayManage(actor, v);
        await P.setRole(client.id, { email: v.email, role: '' }, by);
        return back(form.from === 'customers' ? 'customers' : 'team', { ok: `${v.email} no longer has access to ${client.name}.` });
      }
      if (tab === 'team' && action === 'signout') {
        const v = await target();
        P.mayHelp(actor, v);
        const u = v.id ? await P.userFor({ user_id: v.id, email: v.email }) : null;
        if (!u) throw new PeopleError('They have not signed in yet, so there is nothing to sign out.', 400);
        await P.signOutEverywhere(client.id, u, by);
        return back('team', { ok: `${v.email} is signed out everywhere. ${client.name} ends their session within 5 minutes.` });
      }
      if (tab === 'invites' && (action === 'revoke' || action === 'resend')) {
        const inv = (await P.invites(client.id)).find((i) => i.id === form.id);
        if (!inv) throw new PeopleError('No such invitation.', 404);
        P.mayInvite(actor, inv.role, inv.org);
        if (action === 'revoke') { await P.revokeInvite(client.id, inv.id, by); return back('invites', { ok: `Cancelled the invitation for ${inv.email}.` }); }
        const sent = await sendInvite(inv, client, me.display_name || by).catch(() => false);
        if (sent) await P.log(client.id, by, `sent the invitation to ${inv.email} again`, inv.org);
        return back('invites', sent ? { ok: `Sent the invitation to ${inv.email} again.` } : { err: 'The email could not be sent. Please try again later.' });
      }
      if (tab === 'customers' && action === 'save') {
        if (form.id) { if (!(can(actor.role, 'addOrganizations') && (!actor.org || actor.org === form.id))) throw new PeopleError('Only admins can change an organization.', 403); }
        else if (!can(actor.role, 'addOrganizations') || actor.org) throw new PeopleError("Only the team's admins can add customers.", 403);
        const o = await P.saveOrg(client.id, { id: form.id || undefined, name: form.name, notes: form.notes, ...(form.data !== undefined && !actor.org ? { data: form.data } : {}) }, by);
        return back('customers', { ok: `Saved ${o.name}.` });
      }
      if (tab === 'customers' && action === 'delete') {
        if (!can(actor.role, 'addOrganizations') || actor.org) throw new PeopleError("Only the team's admins can remove customers.", 403);
        await P.deleteOrg(client.id, form.id ?? '', by);
        return back('customers', { ok: 'Removed the customer.' });
      }
      return back(tab, { err: 'That is not something this page does.' });
    } catch (e) {
      if (e instanceof PeopleError) return back(tab, { err: e.message });
      throw e;
    }
  }

  // ---------- pages ----------
  const flash = url.searchParams.get('ok') ? `<div class="ok" role="status">${esc(url.searchParams.get('ok'))}</div>`
    : url.searchParams.get('err') ? `<div class="err" role="alert">${esc(url.searchParams.get('err'))}</div>` : '';
  const orgs = await P.orgs(client.id);
  const orgName = (id) => (id ? orgs.find((o) => o.id === id)?.name ?? 'a removed customer' : '');
  const hidden = `<input type="hidden" name="csrf" value="${esc(csrf)}">`;
  const roleChoices = (current, forOrg) => ROLES.filter((r) => r !== 'super_admin')
    .filter((r) => can(actor.role, 'manageTeam') || r === 'member' || (actor.org && r === 'admin'))
    .filter((r) => !(r === 'support' && (actor.org || forOrg)))
    .map((r) => `<option value="${r}"${r === current ? ' selected' : ''}>${roleLabel(r)}</option>`).join('');
  const orgChoices = (current) => (actor.org ? '' : `<label>Customer<select name="org"><option value="">None (the ${esc(client.name)} team)</option>${orgs.map((o) => `<option value="${esc(o.id)}"${o.id === current ? ' selected' : ''}>${esc(o.name)}</option>`).join('')}</select></label>`);
  const may = (fn) => { try { fn(); return true; } catch { return false; } };
  const everyone = await P.list(client.id, actor.org);
  const invites = (await P.invites(client.id)).filter((i) => !actor.org || i.org === actor.org);

  const personCard = (v, from = 'team') => {
    const manage = may(() => P.mayManage(actor, v)), helpOk = v.id && may(() => P.mayHelp(actor, v));
    const you = v.email && v.email === meEmail;
    const badge = `<span class="badge r-${esc(v.role)}">${esc(roleLabel(v.role))}${v.view_only ? ' · view only' : ''}</span>${you ? '<span class="pill">You</span>' : ''}`;
    const facts = [v.org ? esc(orgName(v.org)) : '', v.last_sign_in ? `Last in ${esc(ago(v.last_sign_in))}` : v.email_verified ? '' : 'Has not signed in yet', v.google ? 'Google' : ''].filter(Boolean).join(' · ');
    const forms = [
      manage ? `<details class="edit"><summary>Change</summary><form method="post" action="${base}/team/role" class="inline">${hidden}<input type="hidden" name="from" value="${from}"><input type="hidden" name="email" value="${esc(v.email)}"><label>Role<select name="role">${roleChoices(v.role, !!v.org)}</select></label>${orgChoices(v.org)}<label class="check"><input type="checkbox" name="view_only" value="1"${v.view_only ? ' checked' : ''}> View only</label>${actor.org ? '' : `<label class="wide">${esc(client.name)} details (JSON, optional)<input name="extra" value="${esc(JSON.stringify(v.extra ?? {}))}" maxlength="4096" spellcheck="false"></label>`}<button type="submit">Save</button></form></details>` : '',
      helpOk ? `<form method="post" action="${base}/team/signout">${hidden}<input type="hidden" name="email" value="${esc(v.email)}"><button type="submit">Sign out everywhere</button></form>` : '',
      manage ? `<form method="post" action="${base}/team/remove">${hidden}<input type="hidden" name="from" value="${from}"><input type="hidden" name="email" value="${esc(v.email)}"><button type="submit" class="danger">Remove access</button></form>` : '',
    ].join('');
    return `<div class="person"><span class="av" aria-hidden="true">${esc(initials(v.name, v.email))}</span><div class="pbody"><div class="who"><b>${esc(v.name || v.email)}</b>${badge}</div>
<div class="muted">${v.name ? esc(v.email) : ''}${v.name && facts ? ' · ' : ''}${facts}</div>${forms ? `<div class="acts">${forms}</div>` : ''}</div></div>`;
  };

  let body = '';
  if (tab === 'team') {
    const team = everyone.filter((v) => !v.org);
    const add = can(actor.role, 'inviteMembers') ? `<section><h2>Invite someone ${help(`Invite sends them an email with a link to ${client.name}. They sign in there with that email address (Google or a 6-digit code), and the role you chose is theirs. The invitation works once and ends after 7 days. Give access now skips the email.`)}</h2>
<form method="post" action="${base}/team/add" class="grid">${hidden}<label>Email<input name="email" type="email" required placeholder="name@company.com" autocomplete="off"></label><label>Name (optional)<input name="name" maxlength="80"></label><label>Role<select name="role">${roleChoices('member', false)}</select></label>${orgChoices(null)}<label class="check"><input type="checkbox" name="view_only" value="1"> View only (can look, cannot change anything)</label>
<div class="btns"><button class="main" type="submit" name="how" value="invite">Send invitation</button><button type="submit" name="how" value="now">Give access now</button></div></form></section>` : '';
    const waiting = `<section><h2>Waiting to join ${help('Invitations nobody has used yet. Each one works once and ends after 7 days.')}</h2>${invites.length ? `<div class="list">${invites.slice(0, 5).map((i) => `<div class="person"><span class="av soft" aria-hidden="true">${esc(initials(i.name, i.email))}</span><div class="pbody"><div class="who"><b>${esc(i.name || i.email)}</b><span class="badge r-${esc(i.role)}">${esc(roleLabel(i.role))}</span></div><div class="muted">${i.name ? esc(i.email) + ' · ' : ''}invited ${esc(day(i.createdAt))} · ends ${esc(day(i.expiresAt))}</div></div></div>`).join('')}</div>${invites.length > 5 ? `<p class="center"><a href="${base}/invites">All ${invites.length} invitations</a></p>` : ''}` : '<p class="muted center">Nobody is waiting.</p>'}</section>`;
    body = `<section><h2>${actor.org ? `${esc(orgName(actor.org))} at ${esc(client.name)}` : `The ${esc(client.name)} team`} ${help(`The super admin runs ${client.name}. Admins manage every customer. Support helps people but changes nothing. Members use ${client.name}. Customers are listed on the Customers tab.`)}</h2>
${(actor.org ? everyone : team).length ? `<div class="list">${(actor.org ? everyone : team).map((v) => personCard(v)).join('')}</div>` : '<p class="muted center">Nobody yet.</p>'}</section>${add}${waiting}`;
  }

  if (tab === 'customers') {
    const shown = orgs.filter((o) => !actor.org || o.id === actor.org);
    const all = actor.org ? everyone : await P.list(client.id);
    const cards = shown.map((o) => {
      const people = all.filter((v) => v.org === o.id);
      const edit = can(actor.role, 'addOrganizations') ? `<details class="edit"><summary>Change</summary><form method="post" action="${base}/customers/save" class="inline">${hidden}<input type="hidden" name="id" value="${esc(o.id)}"><label>Name<input name="name" value="${esc(o.name)}" maxlength="80" required></label><label>Notes<input name="notes" value="${esc(o.notes)}" maxlength="500"></label>${actor.org ? '' : `<label class="wide">${esc(client.name)} details (JSON, optional)<input name="data" value="${esc(JSON.stringify(o.data))}" maxlength="4096" spellcheck="false"></label>`}<button type="submit">Save</button></form></details>${actor.org ? '' : `<form method="post" action="${base}/customers/delete">${hidden}<input type="hidden" name="id" value="${esc(o.id)}"><button type="submit" class="danger"${people.length ? ' disabled title="Remove its people first"' : ''}>Remove</button></form>`}` : '';
      return `<section><h2>${esc(o.name)} <span class="count">${people.length}</span></h2><p class="muted center">${o.notes ? esc(o.notes) + ' · ' : ''}added ${esc(day(o.createdAt))}</p>${people.length ? `<div class="list">${people.map((v) => personCard(v, 'customers')).join('')}</div>` : '<p class="muted center">Nobody yet. Invite them from the Team tab and pick this customer.</p>'}${edit ? `<div class="acts center">${edit}</div>` : ''}</section>`;
    }).join('');
    const add = can(actor.role, 'addOrganizations') && !actor.org ? `<section><h2>Add a customer ${help(`A customer is a company using ${client.name}. Its admins only see and manage their own people.`)}</h2><form method="post" action="${base}/customers/save" class="grid">${hidden}<label>Name<input name="name" required maxlength="80"></label><label>Notes (optional)<input name="notes" maxlength="500"></label><div class="btns"><button class="main" type="submit">Add customer</button></div></form></section>` : '';
    body = (cards || `<section><h2>Customers</h2><p class="muted center">No customers yet.</p></section>`) + add;
  }

  if (tab === 'invites') {
    body = `<section><h2>Waiting to join ${help(`People invited to ${client.name} who have not signed in yet. Each invitation works once and ends after 7 days. When they sign in with the invited email, the role is theirs.`)}</h2>${invites.length ? `<div class="list">${invites.map((i) => `<div class="person"><span class="av soft" aria-hidden="true">${esc(initials(i.name, i.email))}</span><div class="pbody"><div class="who"><b>${esc(i.name || i.email)}</b><span class="badge r-${esc(i.role)}">${esc(roleLabel(i.role))}${i.view_only ? ' · view only' : ''}</span></div>
<div class="muted">${i.name ? esc(i.email) + ' · ' : ''}${i.org ? esc(orgName(i.org)) + ' · ' : ''}invited by ${esc(i.invitedBy)} on ${esc(day(i.createdAt))} · ends ${esc(day(i.expiresAt))}</div>${can(actor.role, 'inviteMembers') ? `<div class="acts"><form method="post" action="${base}/invites/resend">${hidden}<input type="hidden" name="id" value="${esc(i.id)}"><button type="submit">Send again</button></form><form method="post" action="${base}/invites/revoke">${hidden}<input type="hidden" name="id" value="${esc(i.id)}"><button type="submit" class="danger">Cancel invitation</button></form></div>` : ''}</div></div>`).join('')}</div>` : '<p class="muted center">Nobody is waiting. Invite someone from the Team tab.</p>'}</section>`;
  }

  if (tab === 'roles') {
    const yes = '<span class="yes" aria-label="Yes">✓</span>', no = '<span class="no" aria-label="No">—</span>';
    const note = { inviteMembers: { admin: 'Members only' }, manageMembers: {}, helpPeople: { support: 'Members only' } };
    body = `<section><h2>Team roles ${help(`What each role in ${client.name} may do. The server checks every action, not just this page.`)}</h2>
<div class="tablewrap"><table><thead><tr><th scope="col"><span class="sr">Permission</span></th>${ROLES.map((r) => `<th scope="col">${roleLabel(r)}</th>`).join('')}</tr></thead><tbody>
${Object.keys(PERMISSIONS).map((p) => `<tr><th scope="row">${esc(PERMISSION_TEXT[p])}</th>${ROLES.map((r) => `<td>${note[p]?.[r] && PERMISSIONS[p].includes(r) ? `<span class="note">${esc(note[p][r])}</span>` : PERMISSIONS[p].includes(r) ? yes : no}</td>`).join('')}</tr>`).join('')}
<tr><th scope="row">Use ${esc(client.name)}</th>${ROLES.map(() => `<td>${yes}</td>`).join('')}</tr></tbody></table></div>
<ul class="muted"><li><b>Super admin</b>: the owner. Everything, including choosing admins and support. The owner is super admin in every product.</li><li><b>Admin</b>: runs ${esc(client.name)}: invites, changes and removes members, adds customers. A customer's admin only manages that customer's people.</li><li><b>Support</b>: sees people and activity and can sign a member out everywhere, but changes nothing.</li><li><b>Member</b>: uses ${esc(client.name)}. <b>View only</b> members can look but not change anything.</li></ul></section>`;
  }

  if (tab === 'activity') {
    if (!can(actor.role, 'seeActivity')) return back('team', { err: 'You cannot see the activity log.' });
    const list = await P.activity(client.id, { limit: 300, org: actor.org });
    body = `<section><h2>Activity ${help(`Who did what in ${client.name}'s people admin, and every sign-in. Newest first. Times are in UTC.`)}</h2>${list.length ? `<div class="list">${list.map((a) => `<div class="act"><span class="muted">${esc(when(a.at))}</span><span><b>${esc(a.by)}</b> ${esc(a.text)}</span></div>`).join('')}</div>` : '<p class="muted center">Nothing yet.</p>'}</section>`;
  }

  const counts = { team: everyone.filter((v) => actor.org || !v.org).length, customers: actor.org ? null : orgs.length, invites: invites.length };
  const tabs = `<nav class="tabs" aria-label="${esc(client.name)} people">${TABS.filter(([id]) => id !== 'activity' || can(actor.role, 'seeActivity')).filter(([id]) => id !== 'customers' || !actor.org)
    .map(([id, label]) => `<a href="${base}/${id}"${id === tab ? ' aria-current="page"' : ''}>${label}${counts[id] != null ? ` <span class="n">${counts[id]}</span>` : ''}</a>`).join('')}</nav>`;
  const switcher = mine.length > 1 ? `<nav class="switch" aria-label="Products">${mine.map(({ c }) => `<a href="/admin/${esc(c.id)}/${esc(tab)}"${c.id === client.id ? ' aria-current="page"' : ''}>${esc(c.name)}</a>`).join('')}</nav>` : '';
  return send(200, shell({ title: `${client.name} people`, me, client,
    body: `${switcher}<h1>${esc(client.name)} people</h1><p class="lead">You are ${esc(roleLabel(access.role).toLowerCase())} here${actor.org ? ` for ${esc(orgName(actor.org))}` : ''}. <a href="${esc(client.home)}">Open ${esc(client.name)}</a></p>${tabs}${flash}${body}` }));
}

function shell({ title, body, me, client }) {
  const c = HEX.test(client?.color ?? '') ? client.color : '#3f3f46';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>
:root{color-scheme:light dark;--c:${c};--bg:#f4f4f5;--card:#fff;--soft:#fafafa;--ink:#18181b;--muted:#6b6b74;--line:#e4e4e7;--yes:#15803d;--note:#a16207}
@media (prefers-color-scheme:dark){:root{--bg:#18181b;--card:#222226;--soft:#1c1c20;--ink:#f4f4f5;--muted:#a1a1aa;--line:#34343a;--yes:#4ade80;--note:#facc15}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
a{color:var(--c)}header{background:var(--card);border-bottom:1px solid var(--line);border-top:4px solid var(--c)}
.bar{max-width:1040px;margin:0 auto;padding:12px 16px;display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.bar b{display:flex;align-items:center;gap:10px}.bar b:before{content:"";width:14px;height:14px;border-radius:4px;background:var(--c)}.bar span{color:var(--muted);font-size:13px}.bar span a{color:inherit}
main{max-width:1040px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:28px;letter-spacing:-.01em;margin:4px 0 6px;text-align:center}.lead{color:var(--muted);margin:0 0 20px;text-align:center}.lead a{font-weight:600}
h2{font-size:19px;margin:0 0 14px;display:flex;align-items:center;justify-content:center;gap:10px;text-align:center}
section{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:22px;margin:0 0 18px}
.center{text-align:center;justify-content:center}.muted{color:var(--muted)}.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.tabs,.switch{display:flex;gap:6px;flex-wrap:wrap;justify-content:center;margin:0 0 18px}
.tabs a,.switch a{padding:9px 14px;border-radius:12px;border:1px solid var(--line);background:var(--card);color:var(--ink);text-decoration:none;font-size:14px;font-weight:600}
.tabs a[aria-current],.switch a[aria-current]{background:var(--c);border-color:var(--c);color:#fff}.tabs .n{display:inline-block;min-width:20px;padding:0 6px;margin-left:4px;border-radius:99px;background:rgba(127,127,127,.22);font-size:12px}
.switch a{font-size:13px;padding:5px 10px}
.list{display:flex;flex-direction:column;gap:10px}
.person{display:flex;gap:14px;align-items:flex-start;border:1px solid var(--line);border-radius:12px;padding:14px;background:var(--soft)}
.av{flex:none;width:44px;height:44px;border-radius:10px;display:grid;place-items:center;font-weight:700;color:#fff;background:var(--c)}.av.soft{background:var(--line);color:var(--ink)}
.pbody{flex:1;min-width:0}.who{display:flex;flex-wrap:wrap;align-items:center;gap:6px 10px}.who b{font-size:16px;overflow-wrap:anywhere}.pbody .muted{font-size:13px;overflow-wrap:anywhere;margin-top:2px}
.badge{font-size:12px;font-weight:700;padding:2px 10px;border-radius:99px;background:var(--line);color:var(--ink)}.r-super_admin{background:var(--c);color:#fff}.r-admin{background:#3f3f46;color:#fff}.r-support{background:#0e7490;color:#fff}
.pill{font-size:12px;font-weight:600;padding:1px 9px;border-radius:99px;border:1px solid var(--line)}
.count{font-size:13px;padding:1px 9px;border-radius:99px;background:var(--line)}
.acts{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-start;margin-top:10px}
details.edit{flex-basis:100%}details.edit summary{cursor:pointer;display:inline-block;font-weight:600;font-size:14px;padding:7px 12px;border:1px solid var(--line);border-radius:9px;background:var(--card)}details.edit[open] summary{margin-bottom:10px}
.act{display:flex;flex-wrap:wrap;gap:4px 16px;border-bottom:1px solid var(--line);padding:9px 0;font-size:14px}.act .muted{min-width:220px}
form{margin:0}form.inline{display:flex;flex-wrap:wrap;gap:10px;align-items:flex-end}
form.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;align-items:end}
label{display:flex;flex-direction:column;gap:5px;font-size:13px;font-weight:600;color:var(--muted)}label.wide{flex:1 1 260px}label.wide input{font-family:ui-monospace,Menlo,monospace;font-size:12px}
label.check{flex-direction:row;align-items:center;gap:8px;font-size:14px;color:var(--ink)}
input,select{font:inherit;font-size:15px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--card);color:var(--ink);min-width:0}
input:focus,select:focus,button:focus-visible,a:focus-visible,summary:focus-visible{outline:2px solid var(--c);outline-offset:2px}
input[type=checkbox]{width:18px;height:18px;padding:0}
button{font:inherit;font-weight:600;font-size:14px;padding:10px 14px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer;min-height:42px}
button.main{background:var(--c);border-color:var(--c);color:#fff}button.danger{color:#dc2626}button[disabled]{opacity:.5;cursor:not-allowed}
.btns{display:flex;gap:8px;flex-wrap:wrap}form.grid .btns,form.grid label.check{grid-column:1/-1}form.grid .btns{justify-content:center}
.prods{display:grid;grid-template-columns:repeat(auto-fill,minmax(230px,1fr));gap:12px}
.prod{display:flex;flex-direction:column;gap:4px;padding:18px;border-radius:14px;background:var(--card);border:1px solid var(--line);border-top:4px solid var(--c);color:var(--ink);text-decoration:none;text-align:center}.prod span{color:var(--muted);font-size:13px}
.ok,.err{border-radius:12px;padding:11px 14px;margin:0 0 16px;font-size:14px;text-align:center}
.ok{background:#ecfdf5;color:#065f46;border:1px solid #a7f3d0}.err{background:#fef2f2;color:#991b1b;border:1px solid #fecaca}
@media (prefers-color-scheme:dark){.ok{background:#052e1f;color:#6ee7b7;border-color:#065f46}.err{background:#2a1215;color:#fca5a5;border-color:#5b1d22}.r-admin{background:#e4e4e7;color:#18181b}}
.help{position:relative;display:inline-block}.help summary{list-style:none;cursor:pointer;width:24px;height:24px;border-radius:50%;border:1px solid var(--line);font-size:13px;display:inline-flex;align-items:center;justify-content:center;color:var(--muted);font-weight:600}
.help summary::-webkit-details-marker{display:none}.help p{position:absolute;z-index:5;left:50%;transform:translateX(-50%);top:30px;width:min(320px,80vw);background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 12px;font-size:13px;font-weight:400;color:var(--ink);box-shadow:0 8px 28px rgba(0,0,0,.18);text-align:left}
.tablewrap{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:15px}th,td{border-bottom:1px solid var(--line);padding:12px 10px}thead th{color:var(--muted);font-weight:600;text-align:center}
tbody th{text-align:left;font-weight:500}td{text-align:center}.yes{color:var(--yes);font-weight:700;font-size:18px}.no{color:var(--muted)}.note{color:var(--note);font-size:13px}
ul{margin:16px 0 0;padding-left:20px}li{margin:0 0 6px}
@media (max-width:600px){h1{font-size:23px}section{padding:16px}.act .muted{min-width:0;flex-basis:100%}.person{padding:12px;gap:10px}.av{width:38px;height:38px}table{font-size:13px}th,td{padding:9px 6px}}
</style></head><body>
<header><div class="bar"><b>${esc(client?.name ?? 'People')}</b><span>${esc(me.display_name || P_email(me))} · <a href="/account">Your account</a></span></div></header>
<main>${body}</main></body></html>`;
}
const P_email = (u) => String(u?.email ?? '');

/** The invitation email, in the product's own name and colour. */
export function inviteEmail(client, by, inv) {
  const subject = `You are invited to ${client.name}`;
  const role = roleLabel(inv.role).toLowerCase();
  const text = `${by} invited you to ${client.name} as ${role === 'admin' ? 'an' : 'a'} ${role}.\n\nOpen ${client.home} and sign in with this email address (${inv.email}), with Google or a 6-digit email code. The invitation works once and ends after 7 days.\n\nIf you did not expect it, ignore this email.`;
  const c = HEX.test(client.color ?? '') ? client.color : '#3f3f46';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#18181b">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f4f5"><tr><td align="center" style="padding:36px 14px">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:480px;background:#ffffff;border-radius:12px;border-top:5px solid ${c}">
<tr><td style="padding:30px 30px 6px;font-size:16px;font-weight:700">${esc(client.name)}</td></tr>
<tr><td style="padding:6px 30px 6px;font-size:22px;font-weight:700;line-height:1.3">You are invited to ${esc(client.name)}</td></tr>
<tr><td style="padding:8px 30px 20px;font-size:15px;line-height:1.6;color:#3f3f46">${esc(by)} invited you as ${role === 'admin' ? 'an' : 'a'} ${esc(role)}. Sign in with this email address (${esc(inv.email)}), with Google or a 6-digit email code.</td></tr>
<tr><td style="padding:0 30px 24px"><a href="${esc(client.home)}" style="display:inline-block;background:${c};color:#ffffff;text-decoration:none;font-weight:700;padding:13px 20px;border-radius:9px">Open ${esc(client.name)}</a></td></tr>
<tr><td style="padding:0 30px 30px;font-size:13px;line-height:1.6;color:#71717a">The invitation works once and ends after 7 days. If you did not expect it, ignore this email.</td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}
