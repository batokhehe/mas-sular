// Prisma CLI configuration (Prisma 6.x). Replaces the deprecated
// `package.json#prisma` block; schema, migrations and seed are unchanged.
//
// As soon as a config file exists, Prisma 6 stops loading `.env` on its own,
// so it is loaded here to keep `prisma migrate dev/status/...` reading
// backend/.env exactly as before. dotenv never overrides variables that are
// already set, so container/CI values (e.g. the migrator's DATABASE_URL) still
// win, and a missing .env is a no-op. `quiet` keeps dotenv's banner off stdout.
//
// The datasource URL stays in schema.prisma (`env("DATABASE_URL")`).
import { config } from 'dotenv';
import { defineConfig } from 'prisma/config';

config({ quiet: true });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
});
