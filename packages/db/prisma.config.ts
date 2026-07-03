import { defineConfig } from 'prisma/config';

// Prisma 7 moved the connection URL out of schema.prisma into this file.
// The runtime client (src/client.ts) supplies the real pool via the pg adapter;
// this URL is only used by the Prisma CLI (generate/migrate/db push). A fallback
// keeps `prisma generate` working without DATABASE_URL set.
export default defineConfig({
  // Multi-file schema (Prisma 6.7+): point at the folder; every *.prisma inside
  // is combined at generate/migrate time. See prisma/schema/main.prisma.
  schema: 'prisma/schema',
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgresql://swarmy:swarmy@localhost:5679/swarmy',
  },
  migrations: {
    path: 'prisma/migrations',
  },
});
