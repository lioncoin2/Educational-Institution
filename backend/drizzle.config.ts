import { defineConfig } from 'drizzle-kit';

/**
 * Migration generation.
 *
 * The `schema` globs are the important part: every module declares its own
 * tables beside the adapter that uses them, and drizzle-kit collects them. There
 * is no single global schema file, so table ownership matches module ownership
 * and no module can accidentally reference another's tables — which is the
 * property a single `schema.prisma` cannot provide.
 *
 * Generated SQL lands in `drizzle/` and is committed. Migrations are reviewed
 * like code and applied deliberately; nothing auto-migrates on boot.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: ['./src/platform/**/schema.ts', './src/modules/*/infrastructure/schema.ts'],
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/institution',
  },
  strict: true,
  verbose: true,
});
