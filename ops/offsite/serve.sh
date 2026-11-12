#!/usr/bin/env bash
# Runs on the shared server as the only thing the backup copier's SSH key may do (installed as
# /usr/local/sbin/onyx-backup-serve by ops/server/install.sh). Read-only: it can list finished backups and send one as a
# tar stream. It can't run anything else, write, delete or reach any other folder.
#   list        -> names of finished backups, oldest first
#   get <name>  -> that backup folder as a tar stream on stdout
set -euo pipefail
BK=${ONYX_BACKUP_ROOT:-/var/backups/novenique}
read -r cmd name extra <<<"${SSH_ORIGINAL_COMMAND:-}" || true
[ -z "${extra:-}" ] || { echo "one name at a time" >&2; exit 2; }
case "${cmd:-}" in
  list)
    for d in "$BK"/novenique-*; do [ -f "$d/MANIFEST.json" ] && basename "$d"; done | sort ;;
  get)
    [[ "${name:-}" =~ ^novenique-[0-9]{8}T[0-9]{6}Z(-[0-9]+)?$ ]] || { echo "not a backup name" >&2; exit 2; }
    [ -f "$BK/$name/MANIFEST.json" ] || { echo "no such backup" >&2; exit 2; }
    tar -C "$BK" -cf - "$name" ;;
  *) echo "allowed: list, get <name>" >&2; exit 2 ;;
esac
