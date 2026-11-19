#!/usr/bin/env python3
"""Seed Iroha v2's per-key model lists (carriers) from v1's per-key allow-lists.

v1 kept a per-Key list of the models that Key could serve and only ever asked
a Key for a model on that list. v2 has no allow-lists: it learns Model Gaps from
failures, and it puts a Key first for a model when that Key's own model list
names it (a "carrier"). This script copies v1's lists into v2's carrier table,
so the imported Providers route as they did in v1 from the first Request,
instead of burning the Attempt budget on Keys that never served the model.

A carrier is matched on the wire model, so each model is written under the
name its Endpoint sends upstream (v2's Endpoint renames). Nothing is excluded:
a list only reorders (ADR-0023).

Usage:
    python3 seed_carriers.py <v2 iroha.db> <carriers.tsv>

carriers.tsv holds one "provider<TAB>base url<TAB>model" row per v1 Key model
list entry. It is regenerated from v1's database with:

    SELECT p.handle, k.base_url, m FROM upstream_keys k
      JOIN providers p ON p.id = k.provider_id,
      json_each(k.allowed_models) m
     WHERE k.allowed_models IS NOT NULL AND k.allowed_models != '[]'

Stop Iroha before running it, and start it again afterwards.
"""
import json
import sqlite3
import sys
import time

DB = sys.argv[1] if len(sys.argv) > 1 else "/opt/iroha-v2/iroha.db"
CARRIERS_TSV = sys.argv[2]

now = int(time.time())
db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

providers = {r["handle"]: r["id"] for r in db.execute("SELECT id, handle FROM providers")}

wanted = {}
with open(CARRIERS_TSV, encoding="utf-8") as f:
    for line in f:
        line = line.rstrip("\n")
        if not line:
            continue
        handle, url, model = line.split("\t")
        wanted.setdefault(handle, {}).setdefault(url, []).append(model)

rows = []
for handle, urls in wanted.items():
    pid = providers.get(handle)
    if not pid:
        print(f"  {handle}: not in v2, skipped")
        continue

    endpoints = {
        r["url"]: (r["id"], json.loads(r["renames"]) if r["renames"] else {})
        for r in db.execute("SELECT id, url, renames FROM endpoints WHERE provider_id = ?", (pid,))
    }

    key_endpoints = {}
    for r in db.execute(
        """SELECT k.id AS key_id, e.endpoint_id AS endpoint_id
             FROM upstream_keys k JOIN upstream_key_endpoints e ON e.key_id = k.id
            WHERE k.provider_id = ?""",
        (pid,),
    ):
        key_endpoints.setdefault(r["key_id"], []).append(r["endpoint_id"])

    # Start from scratch for these Providers, so a re-run replaces the rows.
    db.execute("DELETE FROM provider_model_sources WHERE provider_id = ? AND key_id IS NOT NULL", (pid,))

    seeded = 0
    for key_id, ep_ids in key_endpoints.items():
        if len(ep_ids) != 1:
            continue
        ep_id = ep_ids[0]
        url = db.execute("SELECT url FROM endpoints WHERE id = ?", (ep_id,)).fetchone()[0]
        renames = endpoints.get(url, (ep_id, {}))[1]
        for model in urls.get(url, []):
            wire = renames.get(model) or model
            rows.append((pid, ep_id, key_id, wire, now))
            seeded += 1
    print(f"  {handle}: {seeded} carrier rows")

if rows:
    db.executemany(
        """INSERT OR REPLACE INTO provider_model_sources (provider_id, endpoint_id, key_id, model, seen_at)
           VALUES (?, ?, ?, ?, ?)""",
        rows,
    )
    db.commit()

total = db.execute("SELECT count(*) FROM provider_model_sources WHERE key_id IS NOT NULL").fetchone()[0]
print(f"seeded {len(rows)} carrier rows; table now holds {total}")
db.close()
