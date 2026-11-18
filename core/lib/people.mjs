// People admin for products: who may use each product, with what role, in which customer organization, open invitations
// and an activity log. A product opts in with "people": true in its clients.json entry; then the accounts site's
// /admin/<product> pages (lib/peopleadmin.mjs) run its people, and its server reads roles from POST /token and the
// /v1/person, /v1/people, /v1/roles, /v1/invites, /v1/orgs, /v1/signout and /v1/activity calls (core/PEOPLE.md).
//
// Four roles in every product, most powerful first: super_admin, admin, support, member (a member may be "view only").
// Super admin is never handed out per product: whoever holds the platform Super Administrator role on this accounts site
// (nv_roles, lib/roles.mjs) is super admin in every product, automatically. A person with no role in a product has no
// access to it, and the product must refuse them.
//
// People are kept by product and email (nv_members), so access can be given before someone's first sign-in. When they
// sign in to the product with that (verified) email, an open invitation becomes their role and the row learns their id.
import { randomBytes } from 'node:crypto';
import { q, pbDate, fromPb } from './pb.mjs';
import { EMAIL_RE } from './util.mjs';

export const ROLES = ['super_admin', 'admin', 'support', 'member'];
export const isRole = (r) => ROLES.includes(r);
export const roleLabel = (r) => ({ super_admin: 'Super admin', admin: 'Admin', support: 'Support', member: 'Member' })[r] ?? String(r ?? '');

/** What each role may do on the people admin (the same table every product shows on its Roles tab). */
export const PERMISSIONS = {
  seePeople: ['super_admin', 'admin', 'support'],
  seeActivity: ['super_admin', 'admin', 'support'],
  helpPeople: ['super_admin', 'admin', 'support'],
  inviteMembers: ['super_admin', 'admin'],
  manageMembers: ['super_admin', 'admin'],
  addOrganizations: ['super_admin', 'admin'],
  manageTeam: ['super_admin'],
};
export const PERMISSION_TEXT = {
  seePeople: 'See who can sign in',
  seeActivity: 'See the activity log',
  helpPeople: 'Sign people out everywhere',
  inviteMembers: 'Invite members',
  manageMembers: 'Change or remove members',
  addOrganizations: 'Add customer organizations',
  manageTeam: 'Choose admins and support',
};
export const can = (role, perm) => !!role && (PERMISSIONS[perm] ?? []).includes(role);

export class PeopleError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST') { super(message); this.status = status; this.code = code; }
}

const INVITE_DAYS = 7;
const MAX_JSON = 4096;
const ORG_ID = /^org_[a-f0-9]{12}$/;
const RANK = { super_admin: 0, admin: 1, support: 2, member: 3 };
const truthy = (v) => v === true || v === 'true' || v === '1' || v === 'on' || v === 1;
const clean = (s, max) => String(s ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
const hex = (n) => randomBytes(n).toString('hex');
const lower = (e) => String(e ?? '').trim().toLowerCase();

/** A JSON object, or a JSON string of one, at most 4 KB. */
export function jsonObject(v, what = 'details') {
  if (v === undefined || v === null || v === '') return {};
  let o = v;
  if (typeof v === 'string') { try { o = JSON.parse(v); } catch { throw new PeopleError(`The ${what} must be a JSON object.`); } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new PeopleError(`The ${what} must be a JSON object.`);
  if (JSON.stringify(o).length > MAX_JSON) throw new PeopleError(`The ${what} are too long (at most 4 KB).`);
  return o;
}

export function makePeople({ cfg, pb, A }) {
  const products = () => Object.values(cfg.clients).filter((c) => c.people === true);
  const product = (id) => (cfg.clients[id]?.people === true ? cfg.clients[id] : null);

  // ---------- who is who ----------
  /** The platform Super Administrators' user ids (cached briefly: every page and token asks). */
  let supers = { at: 0, ids: new Set() };
  async function superIds() {
    if (Date.now() - supers.at < 30_000) return supers.ids;
    const rows = await pb.list('nv_roles', { filter: "product='platform' && role='super_admin'", perPage: 50 });
    supers = { at: Date.now(), ids: new Set(rows.map((r) => r.user_id)) };
    return supers.ids;
  }
  const forget = () => { supers = { at: 0, ids: new Set() }; };
  const isSuper = async (userId) => !!userId && (await superIds()).has(userId);

  const memberRow = (p, email) => pb.first('nv_members', `product=${q(p)} && email=${q(lower(email))}`);
  const verifiedEmail = (u) => (u?.verified && EMAIL_RE.test(u.email ?? '') && !String(u.email).endsWith('.invalid') ? lower(u.email) : '');

  /** The person's access to one product: { role, view_only, org, extra } (role null: no access). */
  async function accessOf(p, user) {
    if (!user) return { role: null, view_only: false, org: null, extra: {} };
    if (await isSuper(user.id)) return { role: 'super_admin', view_only: false, org: null, extra: {} };
    const email = verifiedEmail(user);
    const row = email ? await memberRow(p, email) : null;
    if (!row) return { role: null, view_only: false, org: null, extra: {} };
    return { role: row.role, view_only: row.role === 'member' && !!row.view_only, org: row.org || null, extra: row.extra && typeof row.extra === 'object' ? row.extra : {} };
  }

  const validAfter = async (userId) => { const a = userId ? await A.account(userId) : null; return a?.valid_after ? fromPb(a.valid_after).toISOString() : null; };

  /** What a product (and the admin pages) see of one person in that product. */
  async function view(p, user, row = undefined) {
    const sup = await isSuper(user?.id);
    const r = row === undefined ? (user && verifiedEmail(user) ? await memberRow(p, verifiedEmail(user)) : null) : row;
    const role = sup ? 'super_admin' : r?.role ?? null;
    const methods = user ? await A.methods(user.id) : [];
    return {
      id: user?.id ?? null, email: user ? verifiedEmail(user) || r?.email || '' : r?.email ?? '', email_verified: !!(user && verifiedEmail(user)),
      name: user?.display_name || r?.name || '', role, view_only: role === 'member' && !!r?.view_only, org: sup ? null : r?.org || null,
      extra: !sup && r?.extra && typeof r.extra === 'object' ? r.extra : {}, valid_after: await validAfter(user?.id),
      google: methods.some((m) => m.provider === 'google'), last_sign_in: r?.last_sign_in ? fromPb(r.last_sign_in).toISOString() : null,
    };
  }

  async function userFor(row) {
    if (row.user_id) { const u = await A.active(row.user_id); if (u) return u; }
    return A.byEmail(row.email);
  }

  /** Everyone with a role in the product, super admins first. org: only that organization's people. */
  async function list(p, org = null) {
    const rows = await all('nv_members', `product=${q(p)}`);
    const out = [];
    const seen = new Set();
    for (const id of await superIds()) {
      const u = await A.active(id);
      if (!u) continue;
      seen.add(verifiedEmail(u));
      if (!org) out.push(await view(p, u, null));
    }
    for (const r of rows) {
      if (seen.has(r.email)) continue;
      if (org && r.org !== org) continue;
      out.push(await view(p, await userFor(r), r));
    }
    return out.sort((a, b) => (RANK[a.role] ?? 9) - (RANK[b.role] ?? 9) || a.email.localeCompare(b.email));
  }

  async function all(coll, filter, sort = 'created') {
    const out = [];
    for (let page = 1; page <= 50; page++) {
      const b = await pb.list(coll, { filter, sort, perPage: 200, page });
      out.push(...b); if (b.length < 200) break;
    }
    return out;
  }

  // ---------- roles ----------
  /** Gives, changes or (role '') takes away someone's role in a product. Works before their first sign-in. */
  async function setRole(p, input, by) {
    const email = lower(input.email);
    if (!EMAIL_RE.test(email) || email.length > 200) throw new PeopleError('Enter a valid email address.', 400, 'BAD_EMAIL');
    const role = String(input.role ?? '');
    if (role && !isRole(role)) throw new PeopleError(`Roles: ${ROLES.join(', ')}.`, 400, 'BAD_ROLE');
    if (role === 'super_admin') throw new PeopleError('Super admin belongs to the owner, in every product. Pick admin, support or member.', 400, 'BAD_ROLE');
    const target = await A.byEmail(email);
    if (target && (await isSuper(target.id))) throw new PeopleError("The owner's access cannot be changed here.", 403, 'FORBIDDEN');
    const org = input.org ? String(input.org) : null;
    if (org && !(await orgOf(p, org))) throw new PeopleError('That organization does not exist.', 404, 'NO_ORG');
    if (role === 'support' && org) throw new PeopleError('Support is a team role. Pick admin or member for an organization.', 400, 'BAD_ROLE');
    const extra = input.extra === undefined ? undefined : jsonObject(input.extra);
    const row = await memberRow(p, email);
    if (!role) {
      if (row) await pb.remove('nv_members', row.id);
      await log(p, by, `took away ${email}'s access`, row?.org || null);
      return null;
    }
    const data = { product: p, email, role, granted_by: clean(by, 320), ...(target ? { user_id: target.id } : {}) };
    if (input.org !== undefined) data.org = org ?? '';
    if (input.viewOnly !== undefined) data.view_only = role === 'member' && truthy(input.viewOnly);
    if (role !== 'member') data.view_only = false;
    if (extra !== undefined) data.extra = extra;
    if (input.name && !row?.name) data.name = clean(input.name, 80);
    const before = row?.role ?? null;
    const saved = row ? await pb.update('nv_members', row.id, data) : await pb.create('nv_members', { org: '', view_only: false, extra: {}, name: '', ...data });
    // an open invitation for this email is settled by giving access directly
    for (const i of await pb.list('nv_invites', { filter: `product=${q(p)} && email=${q(email)}`, perPage: 20 })) await pb.remove('nv_invites', i.id);
    const text = before === role ? `updated ${email}` : before ? `made ${email} ${roleLabel(role).toLowerCase()}` : `gave ${email} ${roleLabel(role).toLowerCase()} access`;
    await log(p, by, text, saved.org || null);
    return view(p, target, saved);
  }

  /** Signs the person out of the accounts site now, and of every product on its next check (valid_after). */
  async function signOutEverywhere(p, user, by) {
    const a = await A.account(user.id);
    if (a) await pb.update('nv_accounts', a.id, { valid_after: pbDate() });
    for (const s of await pb.list('nv_sessions', { filter: `user_id=${q(user.id)}`, perPage: 200 })) await pb.remove('nv_sessions', s.id).catch(() => {});
    await A.audit(user.id, 'auth.signed_out_everywhere', user.id, { client: p, by: clean(by, 200) }, 'system');
    await log(p, by, `signed ${verifiedEmail(user) || 'someone'} out everywhere`, null);
  }

  // ---------- organizations (customer companies) ----------
  async function orgOf(p, id) { return ORG_ID.test(String(id ?? '')) ? pb.first('nv_orgs', `product=${q(p)} && org_id=${q(id)}`) : null; }
  const orgOut = (o) => ({ id: o.org_id, name: o.name, notes: o.notes ?? '', data: o.data && typeof o.data === 'object' ? o.data : {}, createdAt: fromPb(o.created)?.toISOString() ?? null, createdBy: o.created_by ?? '' });
  async function orgs(p) { return (await all('nv_orgs', `product=${q(p)}`)).map(orgOut).sort((a, b) => a.name.localeCompare(b.name)); }

  async function saveOrg(p, input, by) {
    const data = input.data === undefined ? undefined : jsonObject(input.data, 'organization details');
    const found = input.id ? await orgOf(p, input.id) : null;
    if (input.id && !found && !(ORG_ID.test(input.id) && truthy(input.keep_id ?? input.keepId))) throw new PeopleError('No such organization.', 404, 'NO_ORG');
    if (found) {
      const next = await pb.update('nv_orgs', found.id, { name: clean(input.name, 80) || found.name, ...(input.notes !== undefined ? { notes: clean(input.notes, 500) } : {}), ...(data ? { data } : {}) });
      await log(p, by, `updated the organization ${next.name}`, next.org_id);
      return orgOut(next);
    }
    const name = clean(input.name, 80);
    if (!name) throw new PeopleError('Give the organization a name.');
    if ((await orgs(p)).some((o) => o.name.toLowerCase() === name.toLowerCase())) throw new PeopleError('There is already an organization with that name.', 409, 'EXISTS');
    const o = await pb.create('nv_orgs', { product: p, org_id: input.id && truthy(input.keep_id ?? input.keepId) ? input.id : `org_${hex(6)}`, name, notes: clean(input.notes, 500), data: data ?? {}, created_by: clean(by, 320) });
    await log(p, by, `added the organization ${name}`, o.org_id);
    return orgOut(o);
  }

  async function deleteOrg(p, id, by) {
    const o = await orgOf(p, id);
    if (!o) throw new PeopleError('No such organization.', 404, 'NO_ORG');
    const n = (await all('nv_members', `product=${q(p)} && org=${q(id)}`)).length;
    if (n) throw new PeopleError(`Remove its ${n} ${n === 1 ? 'person' : 'people'} first.`, 409, 'NOT_EMPTY');
    for (const i of await all('nv_invites', `product=${q(p)} && org=${q(id)}`)) await pb.remove('nv_invites', i.id);
    await pb.remove('nv_orgs', o.id);
    await log(p, by, `removed the organization ${o.name}`, null);
  }

  // ---------- invitations ----------
  const inviteOut = (i) => ({ id: i.id, email: i.email, name: i.name ?? '', role: i.role, org: i.org || null, view_only: !!i.view_only, extra: i.extra && typeof i.extra === 'object' ? i.extra : {},
    invitedBy: i.invited_by ?? '', createdAt: fromPb(i.created)?.toISOString() ?? null, expiresAt: fromPb(i.expires_at)?.toISOString() ?? null });
  async function invites(p) {
    return (await all('nv_invites', `product=${q(p)} && expires_at>${q(pbDate())}`, '-created')).map(inviteOut);
  }

  async function invite(p, input, by) {
    const email = lower(input.email);
    if (!EMAIL_RE.test(email) || email.length > 200) throw new PeopleError('Enter a valid email address.', 400, 'BAD_EMAIL');
    if (!isRole(input.role) || input.role === 'super_admin') throw new PeopleError('Pick admin, support or member.', 400, 'BAD_ROLE');
    const org = input.org ? String(input.org) : null;
    if (org && !(await orgOf(p, org))) throw new PeopleError('That organization does not exist.', 404, 'NO_ORG');
    if (input.role === 'support' && org) throw new PeopleError('Support is a team role. Pick admin or member for an organization.', 400, 'BAD_ROLE');
    const existing = await A.byEmail(email);
    if ((existing && (await isSuper(existing.id))) || (await memberRow(p, email))) throw new PeopleError('That person already has access. Change their role instead.', 409, 'EXISTS');
    // a new invitation for the same email replaces the old one
    for (const i of await pb.list('nv_invites', { filter: `product=${q(p)} && email=${q(email)}`, perPage: 20 })) await pb.remove('nv_invites', i.id);
    const row = await pb.create('nv_invites', { product: p, email, name: clean(input.name, 80), role: input.role, org: org ?? '', view_only: input.role === 'member' && truthy(input.viewOnly ?? input.view_only),
      extra: jsonObject(input.extra), invited_by: clean(by, 320), expires_at: pbDate(new Date(Date.now() + INVITE_DAYS * 86400_000)) });
    await log(p, by, `invited ${email} as ${roleLabel(input.role).toLowerCase()}`, org);
    return inviteOut(row);
  }

  async function revokeInvite(p, id, by) {
    const i = await pb.get('nv_invites', String(id ?? ''));
    if (!i || i.product !== p) throw new PeopleError('No such invitation.', 404, 'NO_INVITE');
    await pb.remove('nv_invites', i.id);
    await log(p, by, `cancelled the invitation for ${i.email}`, i.org || null);
    return inviteOut(i);
  }

  /** A proved sign-in to the product: an open invitation for their verified email becomes their role; the row learns
   *  their id, and the sign-in is counted. Returns the person as the product sees them. */
  async function signedIn(p, user) {
    const email = verifiedEmail(user);
    let row = email ? await memberRow(p, email) : null;
    if (!row && email && !(await isSuper(user.id))) {
      const inv = await pb.first('nv_invites', `product=${q(p)} && email=${q(email)} && expires_at>${q(pbDate())}`, '-created');
      if (inv) {
        await pb.remove('nv_invites', inv.id);   // used once
        row = await pb.create('nv_members', { product: p, email, user_id: user.id, role: inv.role, org: inv.org || '', view_only: !!inv.view_only, extra: inv.extra ?? {},
          name: inv.name || '', granted_by: inv.invited_by || '' });
        await log(p, email, `joined as ${roleLabel(inv.role).toLowerCase()} (invited by ${inv.invited_by})`, inv.org || null);
      }
    }
    if (row) row = await pb.update('nv_members', row.id, { user_id: user.id, last_sign_in: pbDate() });
    const v = await view(p, user, row);
    if (v.role) await log(p, email || user.id, 'signed in', v.org, true);
    return v;
  }

  // ---------- activity ----------
  async function log(p, by, text, org, quiet = false) {
    await pb.create('nv_activity', { product: p, by: clean(by, 320), text: clean(text, 300), org: org ?? '', kind: quiet ? 'sign_in' : 'change' }).catch(() => {});
  }
  async function activity(p, { limit = 200, org = null } = {}) {
    const n = Math.max(1, Math.min(Number(limit) || 200, 1000));
    const rows = await pb.list('nv_activity', { filter: `product=${q(p)}` + (org ? ` && org=${q(org)}` : ''), sort: '-created', perPage: Math.min(n, 500) });
    return rows.map((r) => ({ at: fromPb(r.created)?.toISOString() ?? null, by: r.by, text: r.text, org: r.org || null }));
  }

  // ---------- who may do what on the admin pages ----------
  function mayInvite(actor, role, org) {
    if (!can(actor.role, 'inviteMembers')) throw new PeopleError('Only admins can invite people.', 403, 'FORBIDDEN');
    if (role === 'super_admin') throw new PeopleError('Super admin belongs to the owner only.', 400, 'BAD_ROLE');
    if ((role === 'admin' || role === 'support') && !actor.org && !can(actor.role, 'manageTeam')) throw new PeopleError('Only the super admin can choose admins and support.', 403, 'FORBIDDEN');
    if (role === 'support' && org) throw new PeopleError('Support is a team role. Pick admin or member for an organization.', 400, 'BAD_ROLE');
    if (actor.org && org !== actor.org) throw new PeopleError('You can only add people to your own organization.', 403, 'FORBIDDEN');
  }
  function mayManage(actor, target) {
    if (actor.email && actor.email === target.email) throw new PeopleError('You cannot do that to your own account.', 400, 'SELF');
    if (target.role === 'super_admin') throw new PeopleError("The owner's access cannot be changed here.", 403, 'FORBIDDEN');
    if (can(actor.role, 'manageTeam')) return;
    if (!can(actor.role, 'manageMembers')) throw new PeopleError('Only admins can do that.', 403, 'FORBIDDEN');
    if (actor.org) {
      if (target.org !== actor.org) throw new PeopleError('That person is not in your organization.', 403, 'FORBIDDEN');
      if (target.role === 'admin') throw new PeopleError('Admins of an organization cannot change each other.', 403, 'FORBIDDEN');
      return;
    }
    if (!target.org && (target.role === 'admin' || target.role === 'support')) throw new PeopleError('Only the super admin can change admins and support.', 403, 'FORBIDDEN');
  }
  function mayHelp(actor, target) {
    if (actor.role !== 'support') return mayManage(actor, target);
    if (actor.email && actor.email === target.email) throw new PeopleError('You cannot do that to your own account.', 400, 'SELF');
    if (target.role !== 'member') throw new PeopleError('Support can help members only.', 403, 'FORBIDDEN');
  }

  return { products, product, isSuper, forget, accessOf, view, list, setRole, signOutEverywhere, orgOf, orgs, saveOrg, deleteOrg, invites, invite, revokeInvite,
    signedIn, log, activity, mayInvite, mayManage, mayHelp, verifiedEmail, memberRow, userFor };
}
