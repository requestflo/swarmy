import { defineConfig } from 'prisma/config';

// telemetry.db (MetricSample). See prisma.config.ts for control.db.
export default defineConfig({
  schema: 'prisma/telemetry/schema.prisma',
  datasource: {
    url: process.env.SWARMY_TELEMETRY_DB_URL ?? 'file:../../.swarmy/data/telemetry.db',
  },
  migrations: {
    path: 'prisma/telemetry/migrations',
  },
});
