import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/client';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set — copy .env.example to .env');
}

const adapter = new PrismaPg({ connectionString });

// Reuse a single client across hot reloads in dev (Bun --watch).
const globalForPrisma = globalThis as unknown as { __swarmyPrisma?: PrismaClient };

export const prisma: PrismaClient = globalForPrisma.__swarmyPrisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.__swarmyPrisma = prisma;
}

export type DB = typeof prisma;
