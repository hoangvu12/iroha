import { defineConfig } from 'drizzle-kit'

/** SQLite migration track. Generate with `bun run db:generate:sqlite`. */
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/persistence/sqlite/schema.ts',
  out: './migrations/sqlite',
  strict: true,
  verbose: true,
})
