# Onyx kit: accounts, saved work and Pro for any product

Drop-in pieces so a new product gets sign-in, saved work and a paid plan on day one. Prebuild was the first to use them;
Remodel uses the same files. No dependencies, no build step.

## The files (`kit/web/`)
- `onyx-server.js`: one endpoint for the product's server (a Vercel function or any Node server). Signs people in on the
  product's own screen (6-digit email code, or Google through Onyx), keeps the product's own session cookie, and passes
  saved items and the pass on to Onyx with the product's client secret. Actions and their answers are at the top of the file.
- `onyx-account.js` + `onyx-account.css`: the browser half. Account button, sign-in sheet, the person's saved items
  (thumbnails, open, delete, a meter against the free limit), the Pro sheet with the product's plans and trial, the account
  sheet (plan, renewal, manage subscription, sign out) and a toast. Takes the page's colours from CSS variables. Bottom sheet
  on phones.

Copy them into the product (they are small and change rarely; update them here first, then copy). Prebuild keeps
`api/_onyx.js`, `api/account.js`, `assets/onyx-account.js` and `assets/onyx-account.css`.

## One free scene, then sign in (`onyx-gate.js`)
For the 3D sites. The site's shared runtime carries a 10-line `onyxGate(scene, brand)` loader (copy it from the top of
`onyx-gate.js`) and calls it when a scene opens. The first scene is free; a different one opens the sign-in sheet; closing it
goes back to the home page. Signed-in people are never asked again on that device. Frames (SavvyMe's player) and automated
checks are left alone, and if accounts are not switched on or not answering, everyone gets through. The sites keep the files
in `/onyx/` and the endpoint in `api/account.mjs` + `api/_onyx.mjs` (`onyx-server.mjs`, the ES module copy made by
`kit/make-esm.sh`), with `core: 'https://accounts.amaete.com'`.

## Adding a product
1. Add it to `core/deploy/onyx-clients.json` (a game goes in `core/deploy/clients.json` instead):
   - `id`, `name` (shown in the sign-in email), `product`, `home`, `redirect_uris: ["https://<site>/api/account?do=return"]`;
   - `items`: `{ "kinds": ["build"], "free": 3, "pass": 500, "max_kb": 1000 }` (what people can save, how many without and with Pro);
   - `pass.plans`: price in US cents, `on`, `interval`, optional `trial_days`. Selling starts once the plan is `on` and the
     change is merged (Onyx's Stripe account; no Price ID needed, the plan is described inline).
   - Hosted off the Onyx server (Vercel)? Make a secret of 32 random bytes, put it in the host's settings as
     `ONYX_CLIENT_SECRET`, and put only its SHA-256 in clients.json as `secret_sha256`. Otherwise the deploy makes one on the server.
2. In the product: `api/account.js` = `createOnyxHandler({ clientId, site, after })` (a non-game product also passes
   `core: 'https://accounts.amaete.com'`; the default is the games' site), and on each page
   `Onyx.init({ api: '/api/account', brand, items: 'builds', button: '#account', onOpen })`. Save with
   `Onyx.save({ kind, name, data, thumb })`; open the shelf with `Onyx.library()`; sell with `Onyx.upgrade('month')`.
3. Put `if (!Onyx.gate("why")) return;` at the top of a Pro-only tool: it lets Pro (and everyone while nothing is on sale) through and opens the Pro sheet for the rest.

## On the Onyx side
Saved items live in Onyx's `nv_items` table (`core/lib/items.mjs`), one shelf per person per product, deleted with the
account. Staff of a product, or of the whole platform, hold its pass free.
