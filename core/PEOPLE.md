# People admin: one way to run who can use each product

A product that sets `"people": true` in its `core/deploy/onyx-clients.json` (or `clients.json`) entry gets a people admin
on the accounts site, at **`/admin/<product id>`** (for example `https://accounts.amaete.com/admin/faesora`). The product
keeps no list of people of its own: it reads each person's role from here. Code: `core/lib/people.mjs` (rules and data),
`core/lib/peopleadmin.mjs` (the pages and the invitation email), tests in `core/test/people.test.mjs`.

The pages wear the product's own name and colour. Tabs: **Team** (the product's own team, with "Invite someone" and
"Waiting to join"), **Customers** (customer organizations and their people), **Waiting to join** (open invitations, send
again or cancel), **Roles** (the role table) and **Activity** (who changed what, and every sign-in).

## The four roles

Every product uses the same four roles, most powerful first:

| Role | What it means in every product |
| --- | --- |
| `super_admin` | The owner. Everything, including choosing admins and support. Never handed out per product: whoever holds the platform Super Administrator role on the accounts site (`nv_roles`, `lib/roles.mjs`) is super admin in every product automatically. |
| `admin` | Runs the product: invites, changes and removes members, adds customer organizations. |
| `support` | Sees people and activity and can sign a member out everywhere, but changes nothing. A team role only (never inside a customer). |
| `member` | Uses the product. Can be marked **view only** (`view_only: true`): looks, changes nothing. |

| Permission | super_admin | admin | support | member |
| --- | --- | --- | --- | --- |
| See who can sign in | yes | yes | yes | |
| See the activity log | yes | yes | yes | |
| Sign people out everywhere | yes | yes | members only | |
| Invite members | yes | yes | | |
| Change or remove members | yes | yes | | |
| Add customer organizations | yes | yes | | |
| Choose admins and support | yes | | | |

A customer's admin (an admin who belongs to an organization) only sees and manages that organization's people, and
cannot change another admin. Nobody changes their own access or the owner's. The owner and platform staff confirm with
the second sign-in step before the admin opens, as for the console.

## Invitations

"Send invitation" emails the person a link to the product (`home` in the client entry), in the product's name and colour,
through the accounts site's mailbox. The invitation works once and ends after 7 days. When they sign in to the product
with that email address (Google or a 6-digit code; the email must be verified), the role is theirs. "Give access now"
skips the email: the role is theirs at once, even before their first sign-in.

## For a product's server

### At sign-in

`POST /token` (and the `/v1/signin/*` answers) carry `person` for a product with `"people": true`:

```json
"person": {
  "id": "abc123…",              // the same in every product
  "email": "someone@example.com", // only for a product with "share_email": true
  "email_verified": true,
  "name": "Someone",
  "role": "member",             // super_admin | admin | support | member | null
  "view_only": false,
  "org": "org_…",               // or null
  "extra": {},                  // small product-only details, or {}
  "valid_after": null,          // or a time: sessions started before it must end ("sign out everywhere")
  "google": true,
  "last_sign_in": "2026-11-17T…"
}
```

**`role: null` means no access: show "You don't have access to <product>. Ask an admin." and do not make a session.**

### While a session is open

Call `GET /v1/person?id=<id>` at least every 5 minutes per live session. End the session at once when the answer is 404,
`role` is null, or `valid_after` is later than when the session started. If the accounts site does not answer, keep the
last good answer for at most 15 minutes, then refuse until it answers.

### Calls (HTTP Basic with the product's client id and secret; a product only sees its own people)

| Call | What it does |
| --- | --- |
| `GET /v1/person?id=` or `?email=` | The person now. 404: unknown here. |
| `GET /v1/people` | Everyone with a role in this product: `{ people: [person, …] }`. |
| `POST /v1/roles` | `{ email, role, name?, org?, view_only?, extra?, by? }`: gives, changes, or (role `""`) takes away a role. Works before the first sign-in. `super_admin` is refused, and the owner cannot be changed. |
| `GET /v1/invites`, `POST /v1/invites` | Open invitations; `{ email, role, name?, org?, view_only?, extra?, by?, send_email? }` makes one (7 days). |
| `POST /v1/invites/revoke` | `{ id, by? }` |
| `GET /v1/orgs`, `POST /v1/orgs` | Customer organizations; `{ id?, keep_id?, name, notes?, data?, by? }` adds or changes one. |
| `POST /v1/orgs/delete` | `{ id, by? }`. Refused while people still belong to it. |
| `POST /v1/signout` | `{ id or email, by? }`: signs the person out of the accounts site and, on their next check, every product. |
| `GET /v1/activity?limit=`, `POST /v1/activity` | The activity log, newest first; `{ by, text, org? }` adds a line. |

`by` is the email of whoever did it in the product, for the activity log. `extra` and `data` are JSON objects (at most
4 KB).

### The People menu

Point the product's People / Admin link at `https://accounts.amaete.com/admin/<product id>` (games:
`https://accounts.noveniqe.com/admin/<product id>`).

## Where it lives

Tables (created on start-up, `lib/schema.mjs`): `nv_members` (product, email, role, org, view only, details, last
sign-in), `nv_invites`, `nv_orgs`, `nv_activity`, and `valid_after` on `nv_accounts`.
