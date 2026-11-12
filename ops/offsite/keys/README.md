# Backup copier keys

One file per machine that may copy Onyx's backups off the shared server, each holding one line made by
`ops/offsite/install-puller.sh` on that machine:

```
from="<the machine's Tailscale address>" ssh-ed25519 AAAA... onyx-backup@<host>
```

These are public keys, not secrets. On the next "Server safety (deploy)" run the server lets each key list and fetch
finished backups, only from that address and nothing else (no shell, no writing, no other folder). Delete a file to take
a machine's access away.
