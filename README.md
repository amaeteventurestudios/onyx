# Onyx

Onyx is the shared chassis of Amaete Venture Studios. Car makers build many models on one chassis so a new model never
starts from zero, and Onyx does the same for software. Every product the studio launches (Noveniqe's games, Jisste,
ISOTEH, SavvyMe and whatever comes next, on the web, on phones or in the cloud) starts on the same working base:
accounts and sign-in, payments, hosting, backups, uptime checks and server safety. Each product keeps its own
repository, brand and domain. Players and customers never see the name Onyx.

Home: onyx.amaete.com.

## What is in this repository
- `core/`: Onyx accounts. One account across every product: guests, Google, 6-digit email codes, sign-in on the
  product's own screen, roles per product, the pass and payments (Stripe). See [core/README.md](core/README.md).
- `ops/`: safety for the shared server: nightly backups and restore drills, off-server copies, resource ceilings,
  checks, uptime, and the race capacity benchmark. See [ops/README.md](ops/README.md).

In code and on the server the older names stay as they are (`core/`, the `novenique-core` service, `NOVENIQUE_*`
settings, `/opt/novenique`, `accounts.noveniqe.com`). Renaming them would change nothing for people and could break
sign-in.

## Security checks
Every product on Onyx gets the same checks with nothing to set up:
- Every 4 hours, each product's repositories are scanned (leaked keys, packages with known holes, known malware,
  risky code) and each live site gets the public launch check (HTTPS, security headers, exposed files and keys).
- After every deploy, the deploy job runs the launch check on the site it just put live
  (noveniqe `.github/workflows/preflight.yml`). A site that is not ready gets its own issue in the noveniqe
  repository, so GitHub emails you, and the issue closes itself once the site is clear again.
- Before a new package is added to any product, it is checked first (known malware, look-alike names, brand-new
  versions, install scripts). Onyx itself has no outside packages: Node 22 only.

## How it reaches the server
The deploy workflows and their secrets (server key, Google, email, Stripe, backups) still live in the
[noveniqe](https://github.com/amaeteventurestudios/noveniqe) repository. They check out this repository's `main`
branch and put `core/` and `ops/` on the server, so nothing here needs a secret. A change merged here goes live within
about 30 minutes, or straight away with "Run workflow" on "Accounts service (deploy)" or "Server safety (deploy)"
there.

## Tests
`.github/workflows/test.yml` runs on every pull request: the backup tool, the scripts, the accounts service against
PocketBase (with Palasora's real schema and with the bare fixture) and the race benchmark.
