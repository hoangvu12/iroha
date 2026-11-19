# Gateway Keys and Upstream Keys are stored readable

v1 stored only a hash of each Gateway Key and encrypted Upstream Keys under a master key, with an audited reveal step. For a single Owner who shares Gateway Keys with friends, that meant re-issuing a key every time it was lost, and it made migration impossible: v1's Gateway Keys cannot be recovered, so every Gateway Key is re-issued once at the v2 cutover. v2 stores both kinds of key in plain form so the Owner and agents can always read and copy them. Protection rests on the host and its backups, not on the database file.
