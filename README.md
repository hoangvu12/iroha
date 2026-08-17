# Iroha

Iroha is a self-hosted gateway for OpenAI-compatible and Anthropic-compatible AI providers. You choose the Provider; Iroha handles Upstream Key rotation, health, retries, scoped access, and request metadata.

## Run locally

You need [Bun](https://bun.sh/) and either SQLite or PostgreSQL.

```sh
bun install
cp .env.example .env
bun run dev
```

Set `DATABASE_URL`, `IROHA_MASTER_KEY`, and `IROHA_SETUP_TOKEN` in `.env`, then open `http://localhost:3000` to create the Owner account.

## Production

```sh
bun install --frozen-lockfile
bun run build
bun run start
```

Keep the database and master key persistent. Iroha applies pending migrations when it starts.
