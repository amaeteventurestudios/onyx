# Onyx: working notes for Claude Code

Onyx is the shared chassis every Amaete Venture Studios product is built on. When asked to build something "on Onyx",
read `docs/START.md` first: it lists what Onyx already does, the building blocks still inside single products, and the
steps to plug a product in. Keep that page current whenever a product joins or a block moves into Onyx.

- `core/`: accounts, pass, roles, items (plain Node 22, no dependencies). `core/README.md`.
- `kit/`: drop-in account kit for any website. `kit/README.md`.
- `ops/`: backups, restore drill, off-server copies, ceilings, monitoring. `ops/README.md`.
- Deploys and secrets live in the noveniqe repo (the "deploy desk"); nothing here needs a secret. Never commit one.
- Public repo: never name outside companies or internal security tools here. People never see the names Onyx or Noveniqe in a product.
- Tests: `python3 -m unittest discover -s ops/backup`, `bash ops/offsite/test_offsite.sh`,
  `PB_BIN=/path/to/pocketbase-0.40.5 npm test --prefix core`.
