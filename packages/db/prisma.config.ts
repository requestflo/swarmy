import { defineConfig, env } from 'prisma/config';

// Prisma 7 moved the connection URL out of schema.prisma into this file.
// `bun db:*` scripts run from this package dir with the root .env loaded.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: env('DATABASE_URL'),
  },
  migrations: {
    path: 'prisma/migrations',
  },
});
