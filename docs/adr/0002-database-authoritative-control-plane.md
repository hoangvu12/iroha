# The database is the authoritative control plane

The management UI and API write one database-backed configuration model rather than competing with live YAML ownership. Iroha supports explicit SQLite and PostgreSQL deployments through Drizzle, with separate dialect schemas and migrations behind a repository contract; this costs a two-engine conformance matrix but gives simple local operation and a managed-database path without binding the product to one deployment environment.

