import { defineConfig } from 'drizzle-kit'

/** PostgreSQL migration track. Generate with `bun run db:generate:postgres`. */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/persistence/postgres/schema.ts',
  out: './migrations/postgres',
  strict: true,
  verbose: true,
})
