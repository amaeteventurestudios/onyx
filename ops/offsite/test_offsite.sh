#!/usr/bin/env bash
# Tests serve.sh and pull.sh together without a network: a stand-in `ssh` runs serve.sh the way sshd's forced command
# would. Run: bash ops/offsite/test_offsite.sh
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
mkdir -p "$T/bin" "$T/src/data" "$T/home/.ssh"
python3 -c "import sqlite3;c=sqlite3.connect('$T/src/data/app.db');c.execute('create table t(x)');c.execute('insert into t values(1)');c.commit()"
echo secret > "$T/src/app.env"
printf '{"root":"%s","keep":5,"sets":[{"name":"app","sqlite":["%s"],"copy":["%s"]}]}' "$T/bk" "$T/src/data/app.db" "$T/src/app.env" > "$T/cfg.json"
py() { python3 "$HERE/../backup/novenique_backup.py" "$@" >/dev/null; }
py backup --config "$T/cfg.json" --root "$T/bk"; sleep 1.1; py backup --config "$T/cfg.json" --root "$T/bk"
cat > "$T/bin/ssh" <<SH
#!/usr/bin/env bash
while [ "\${1#onyx-backup@}" = "\$1" ]; do shift; done; shift
SSH_ORIGINAL_COMMAND="\$*" ONYX_BACKUP_ROOT="$T/bk" exec bash "$HERE/serve.sh"
SH
chmod +x "$T/bin/ssh"
fail() { echo "FAIL: $*"; exit 1; }
export PATH="$T/bin:$PATH" HOME="$T/home" ONYX_BACKUP_DEST="$T/copies" ONYX_BACKUP_MOUNT="" ONYX_BACKUP_KEEP=1

# serve.sh refuses anything but list and get <backup name>
for bad in "rm -rf /" "get ../../etc" "get novenique-x" "list extra words" ""; do
  SSH_ORIGINAL_COMMAND="$bad" ONYX_BACKUP_ROOT="$T/bk" bash "$HERE/serve.sh" >/dev/null 2>&1 && fail "serve.sh allowed: '$bad'"
done
[ "$(SSH_ORIGINAL_COMMAND=list ONYX_BACKUP_ROOT="$T/bk" bash "$HERE/serve.sh" | wc -l)" = 2 ] || fail "list should show 2"

# pull copies, verifies, keeps 1, and a second run copies nothing new
bash "$HERE/pull.sh" >/dev/null || fail "first pull"
[ "$(find "$T/copies" -maxdepth 1 -name 'novenique-*' | wc -l)" = 1 ] || fail "should keep 1"
newest=$(ls "$T/bk" | grep '^novenique-' | sort | tail -1)
[ -d "$T/copies/$newest" ] || fail "newest not kept"
grep -q '"ok": true' "$T/copies/LAST_PULL.json" || fail "LAST_PULL not ok"
(cd "$T/copies/$newest" && sha256sum --quiet -c SHA256SUMS) || fail "checksums"
out=$(bash "$HERE/pull.sh") || fail "second pull"; grep -q "0 new" <<<"$out" || fail "second pull should copy nothing"

# a damaged copy on the way is refused and leaves nothing behind
py backup --config "$T/cfg.json" --root "$T/bk"
cat > "$T/bin/ssh" <<SH
#!/usr/bin/env bash
while [ "\${1#onyx-backup@}" = "\$1" ]; do shift; done; shift; cmd="\$*"
if [ "\${cmd%% *}" = get ]; then d=\$(mktemp -d); SSH_ORIGINAL_COMMAND="\$cmd" ONYX_BACKUP_ROOT="$T/bk" bash "$HERE/serve.sh" | tar -xf - -C "\$d"
  find "\$d" -name '*.env' -exec sh -c 'echo changed > "\$1"' _ {} \; ; tar -C "\$d" -cf - . ; rm -rf "\$d"
else SSH_ORIGINAL_COMMAND="\$cmd" ONYX_BACKUP_ROOT="$T/bk" exec bash "$HERE/serve.sh"; fi
SH
bash "$HERE/pull.sh" >/dev/null 2>&1 && fail "damaged copy accepted"
[ -z "$(find "$T/copies" -maxdepth 1 -name '.partial-*')" ] || fail "partial left behind"
grep -q '"ok": false' "$T/copies/LAST_PULL.json" || fail "LAST_PULL should say not ok"
echo "offsite: all checks passed"
