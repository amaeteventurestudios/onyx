#!/usr/bin/env bash
# Rewrites kit/web/onyx-server.mjs from onyx-server.js (the ES module copy). Run after changing onyx-server.js.
set -euo pipefail
cd "$(dirname "$0")/web"
python3 - <<'PY'
s=open('onyx-server.js').read()
s=s.replace("'use strict';\nconst crypto = require('node:crypto');","import crypto from 'node:crypto';").replace("module.exports = { createOnyxHandler };","export { createOnyxHandler };")
hdr=open('onyx-server.mjs').read().split("// Onyx kit, server half")[0]
open('onyx-server.mjs','w').write(hdr+s)
PY
