export { prisma } from './client';
export type { DB } from './client';
export { resolveDbDriver, buildAdapter } from './client';
export type { DbDriver } from './client';
export { PrismaPGlite, PrismaPGliteAdapter, fieldToColumnType } from './pglite-adapter';
export type { PGliteAdapterOptions } from './pglite-adapter';
export { ensureSchema } from './ensure-schema';

// Re-export generated client values (enums) + types (Prisma namespace, models).
export * from './generated/client';
