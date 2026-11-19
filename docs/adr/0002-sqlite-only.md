# SQLite only

v1 supported SQLite and Postgres through two hand-mirrored schemas, two migration sets and a conformance suite; over 20 schema changes each paid that cost twice, for a single-Owner installation that only ever ran on SQLite in production. v2 supports SQLite alone, in one file beside the binary. Adding a second engine later means reintroducing a storage abstraction, which we accept as the price of moving fast now.
