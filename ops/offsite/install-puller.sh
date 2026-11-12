#!/usr/bin/env bash
# One-time setup on the AI node (ai-node-01), run as its normal user (not root), from a copy of this repository:
#   bash ops/offsite/install-puller.sh
# It puts pull.sh in ~/.local/bin/onyx-backup-pull, makes the copier's own SSH key (~/.ssh/onyx_backup) if there is none,
# and adds a daily systemd user timer (05:15 UTC, after the server's 03:30 backup). It prints the key line (public key plus this machine's
# Tailscale address): commit it as ops/offsite/keys/<host>.pub, and the next server deploy lets that key (and only from this machine's Tailscale
# address) list and fetch backups. Safe to run again.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
install -d -m 700 "$HOME/.ssh" "$HOME/.local/bin" "$HOME/.config/systemd/user"
install -m 755 "$HERE/pull.sh" "$HOME/.local/bin/onyx-backup-pull"
[ -f "$HOME/.ssh/onyx_backup" ] || ssh-keygen -q -t ed25519 -N '' -C "onyx-backup@$(hostname)" -f "$HOME/.ssh/onyx_backup"

cat > "$HOME/.config/systemd/user/onyx-backup-pull.service" <<UNIT
[Unit]
Description=Copy Onyx's nightly backups to the T7 SSD
Wants=network-online.target
After=network-online.target
RequiresMountsFor=/srv/ai-node/storage/ssd
[Service]
Type=oneshot
ExecStart=$HOME/.local/bin/onyx-backup-pull
Nice=10
IOSchedulingClass=idle
UNIT
cat > "$HOME/.config/systemd/user/onyx-backup-pull.timer" <<UNIT
[Unit]
Description=Copy Onyx's nightly backups to the T7 SSD (schedule)
[Timer]
OnCalendar=*-*-* 05:15:00 UTC
Persistent=true
RandomizedDelaySec=600
[Install]
WantedBy=timers.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now onyx-backup-pull.timer >/dev/null
# User timers only run while logged out if lingering is on (it usually is on this machine already).
loginctl show-user "$USER" -p Linger 2>/dev/null | grep -q yes || loginctl enable-linger "$USER" 2>/dev/null || \
  echo "Note: run 'sudo loginctl enable-linger $USER' so the copy also runs while nobody is logged in."
install -d -m 700 /srv/ai-node/storage/ssd/onyx-backups 2>/dev/null || echo "Note: the SSD is not mounted right now."
echo "Timer: $(systemctl --user list-timers onyx-backup-pull.timer --no-legend | head -1)"
ip=$(tailscale ip -4 2>/dev/null | head -1 || true)
echo "Key line (commit as ops/offsite/keys/$(hostname).pub):"
echo "from=\"${ip:-THIS-MACHINE-TAILSCALE-IP}\" $(cat "$HOME/.ssh/onyx_backup.pub")"
