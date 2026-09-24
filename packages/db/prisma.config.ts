import { defineConfig } from 'prisma/config';

// control.db. The runtime opens the file itself through the in-repo bun:sqlite
// adapter (src/bun-sqlite-adapter.ts); this URL is only for the Prisma CLI
// (generate, migrate diff, studio). telemetry.db has its own config:
// prisma.telemetry.config.ts.
export default defineConfig({
  // Multi-file schema: every *.prisma in the folder is combined at generate time.
  schema: 'prisma/schema',
  datasource: {
    url: process.env.SWARMY_DB_URL ?? 'file:../../.swarmy/data/control.db',
  },
  migrations: {
    path: 'prisma/migrations',
  },
});
