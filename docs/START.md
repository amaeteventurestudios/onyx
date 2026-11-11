# Start a new product on Onyx

Read this first whenever someone says "build this on Onyx". It lists what Onyx already does, where the code is, and the
steps to plug a new product in. A new product should write only what makes it different.

## What every product gets on day one

| Need | Use | Where |
| --- | --- | --- |
| Sign-in (Google, 6-digit email code, guests), one account across every product, shown under the product's own name | Onyx accounts | `core/` (accounts.noveniqe.com), `core/README.md` |
| Sign-in, saved work and Pro sheet dropped into any website (static, Vercel or Node) | Onyx kit | `kit/web/` (`onyx-server.js`, `onyx-account.js`, `onyx-account.css`), `kit/README.md` |
| Plans, passes, trials, Stripe checkout and the billing page | Onyx pass | `core/lib/billing.mjs`; plans live in `core/deploy/clients.json` |
| Roles per product, staff with a second sign-in step, audit trail | Onyx roles | `core/lib/roles.mjs` |
| Saving a person's work (a shelf per person per product) | Onyx items | `core/lib/items.mjs`, `/v1/items` |
| Hosting on the shared server with push-to-deploy | Deploy desk | a `<product>-deploy.yml` workflow in the noveniqe repo + the product's own `deploy/install.sh` |
| Nightly backups, weekly restore drill, an encrypted copy on GitHub and a copy on the AI node's SSD | Onyx ops | `ops/backup/sources.json`, `ops/offsite/` |
| Uptime checks, status page, cookieless visitor stats (Umami), memory ceilings | Onyx ops | `ops/server/`, `ops/README.md` |
| Launch check after every deploy | Preflight (beside Onyx) | runs from the noveniqe repo's deploy workflows |

## Building blocks still inside one product

These work today but haven't been lifted into Onyx yet. Reuse them by copying from the product (and say so in the new
product's handoff); each one is on the list to move into Onyx.

| Block | Lives in | What it does |
| --- | --- | --- |
| Email: lists, double opt-in, newsletters, automations, unsubscribe, open and click reports | pagneto (`src/app/(frontend)/dashboard/email`, `audience`) | Every product that sends mail |
| Payouts to people (Stripe Connect), discount codes, affiliates | pagneto (`dashboard/payouts`), coretech-media | Marketplaces, creators, publishers |
| Short links, QR codes, cookieless page stats | pagneto (`dashboard/links`) | Sharing and simple analytics |
| Sponsored slot (ads without tracking) | isoteh (`sdk/`) | Any product that shows ads |
| Agents: long-term memory, voice, radio calls, WhatsApp | agent-grand-prix- (`server/memory.mjs`, `voice.mjs`, `radio.mjs`), jisst (`app/agents/`) | Bring-your-agent features |
| Design editor (document schema, commands with undo, canvas engine, React editor) | jollofstudio (`packages/schema`, `commands`, `engine`, `editor-react`) | A Canva-style editor in any product |
| Import and export with Google Drive, Dropbox, OneDrive, Notion | jollofstudio (`services/connect`) | Bringing people's files in |
| One codebase answering as several brands | jollofstudio (`apps/studio/src/brands.ts`), authornx (`docs/VENCORE_INTEGRATION.md`) | White-label and sister brands |
| 3D lesson and site kit, page/SEO/sitemap generator, Kokoro narration | circuits, cutaways, build, esp32-labs (`kit/`, `tools/pages.mjs`, `tools/voice-*.mjs`) | New 3D sites |

## Plug a new product in

1. **Accounts and payments.** Add the product to `core/deploy/clients.json` (id, name, home, redirect URIs, plans), then
   follow `kit/README.md`. A product on another host (Vercel, Contabo) keeps its own server and stores only the SHA-256
   of its client secret here. A product that already has its own accounts (SavvyMe, Isoteh) sets `"share_email": true`
   so it receives the verified email and can find existing accounts by it; it signs people in server to server
   (`/v1/signin/email/*`, `/v1/signin/profile`, and `/authorize` with `via=google` for Google). Copy `isoteh/lib/onyx.mjs`
   (Node) or `savvyme/server/pb_hooks/onyx_lib.js` (PocketBase). A new product with no accounts of its own can copy
   `anansora/server/account.mjs`, which also keeps the player's saves.
2. **Hosting** (only if it runs on the shared server): give the product a `deploy/install.sh` that installs it next to
   the others (own systemd service on 127.0.0.1, own Caddy file in `/etc/caddy/sites/`, own user), and add a
   `<product>-deploy.yml` in the noveniqe repo copied from `anansora-deploy.yml`. Pick a free port: look at the others'
   `install.sh` first.
3. **Backups.** Add a set to `ops/backup/sources.json` for every database (`sqlite`), upload folder and env file
   (`copy`) the product keeps. A product with no set is not backed up.
4. **Watching.** Add the site to the uptime list and to Umami (`ops/server/monitoring.sh`).
5. **Own brand.** People see the product's name, never "Onyx" or "Noveniqe". Keep `BRAND` in one place in the product.

## Products on Onyx

| Product | Accounts | Pass | Hosted on the Onyx server | Backed up |
| --- | --- | --- | --- | --- |
| Agent Grand Prix | yes | yes | yes | yes |
| Palasora | yes | listed, off | yes | yes |
| Jisste | yes | no | yes | yes |
| Jisste Teams | yes | own plans | yes | yes |
| Prebuild | yes (Vercel) | Pro | no | on Vercel |
| SavvyMe | yes, keeps its own accounts (savvyme PR #6) | moving | yes | yes |
| Isoteh | yes, keeps its own accounts (isoteh PR #19) | own ledger | yes | yes |
| Anansora | yes, stories kept on the server | moving | yes | yes |
| Agent Warfront | moving | no | yes | yes (when it stores data) |

Not yet on Onyx: Jollof Pages, Jollof Studio, AuthorNX, Pagneto, CoreTech Media, Cathora (each with its own sign-in on
another machine). Planned products (Egusi, Shop Gantry) start on Onyx. The full survey and order are in the plan
"Putting everything on amaete.com onto Onyx".
