#!/usr/bin/env bash
# Runs on the AI node (ai-node-01) every morning: copies each new Onyx nightly backup from the shared server onto the
# Samsung T7 SSD, checks every file against the backup's checksums, and keeps the newest 30. The server can't reach
# or delete these copies: this machine asks for them, over Tailscale, with a key that may only list and fetch.
#   ONYX_BACKUP_HOST   the server's Tailscale address (default 100.107.93.83)
#   ONYX_BACKUP_DEST   where the copies go (default /srv/ai-node/storage/ssd/onyx-backups)
#   ONYX_BACKUP_KEEP   how many to keep (default 30)
set -euo pipefail
HOST=${ONYX_BACKUP_HOST:-100.107.93.83}
DEST=${ONYX_BACKUP_DEST:-/srv/ai-node/storage/ssd/onyx-backups}
KEEP=${ONYX_BACKUP_KEEP:-30}
KEY=${ONYX_BACKUP_KEY:-$HOME/.ssh/onyx_backup}
MOUNT=${ONYX_BACKUP_MOUNT-/srv/ai-node/storage/ssd}
SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=20
     -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile="$HOME/.ssh/onyx_backup_known_hosts" "onyx-backup@$HOST")

say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
result() {  # ok, message
  python3 - "$DEST/LAST_PULL.json" "$1" "$2" <<'PY'
import json, sys, datetime
p, ok, msg = sys.argv[1], sys.argv[2] == "1", sys.argv[3]
json.dump({"ok": ok, "at": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"), "message": msg},
          open(p, "w"), indent=1)
PY
}

# Never fill the system disk: only run when the SSD is really mounted.
if [ -n "$MOUNT" ] && ! mountpoint -q "$MOUNT"; then say "the SSD is not mounted at $MOUNT; nothing copied"; exit 1; fi
install -d -m 700 "$DEST"

names=$("${SSH[@]}" list) || { result 0 "could not reach the server"; say "could not reach $HOST"; exit 1; }
[ -n "$names" ] || { result 0 "the server has no finished backup"; say "no backup on the server"; exit 1; }

got=0
for n in $(tail -n "$KEEP" <<<"$names"); do  # only the newest $KEEP, so nothing is fetched just to be pruned
  [[ "$n" =~ ^novenique-[0-9]{8}T[0-9]{6}Z(-[0-9]+)?$ ]] || continue
  [ -d "$DEST/$n" ] && continue
  part="$DEST/.partial-$n"; rm -rf "$part"; mkdir -m 700 "$part"
  if "${SSH[@]}" get "$n" | tar -xf - -C "$part" && [ -d "$part/$n" ] && (cd "$part/$n" && sha256sum --quiet -c SHA256SUMS); then
    mv "$part/$n" "$DEST/$n"; rm -rf "$part"; got=$((got + 1)); say "copied $n ($(du -sh "$DEST/$n" | cut -f1))"
  else
    rm -rf "$part"; result 0 "$n failed its checksum check or did not arrive"; say "$n failed; will try again next run"; exit 1
  fi
done

# Keep the newest $KEEP.
mapfile -t have < <(find "$DEST" -maxdepth 1 -type d -name 'novenique-*' -printf '%f\n' | sort)
for ((i = 0; i < ${#have[@]} - KEEP; i++)); do rm -rf "${DEST:?}/${have[i]}"; say "removed old ${have[i]}"; done

# Warn (exit 1) when the newest copy is older than 30 hours: the server's backups have stopped.
newest=$(find "$DEST" -maxdepth 1 -type d -name 'novenique-*' -printf '%f\n' | sort | tail -1)
age=$(( ($(date -u +%s) - $(date -u -d "$(sed -E 's/^novenique-([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z.*/\1-\2-\3 \4:\5:\6/' <<<"$newest")" +%s)) / 3600 ))
if [ "$age" -gt 30 ]; then result 0 "newest copy $newest is ${age}h old"; say "newest copy is ${age}h old"; exit 1; fi
result 1 "copied $got new; newest $newest (${age}h old); $(find "$DEST" -maxdepth 1 -type d -name 'novenique-*' | wc -l) kept"
say "done: $got new, newest $newest"
