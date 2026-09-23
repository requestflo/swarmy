/**
 * CI gate: apply every migration through the SAME path a standard-tier
 * controller uses on boot (`ensureSchema` over the Postgres driver adapter)
 * against a fresh database. `prisma migrate deploy` uses its own executor, so
 * it can't catch adapter-specific breakage (e.g. a `;` inside a comment).
 *
 *   ENSURE_SCHEMA_URL=postgresql://…/fresh_db bun packages/db/scripts/check-ensure-schema.ts
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { ensureSchema } from '../src/ensure-schema';

const url = process.env.ENSURE_SCHEMA_URL;
if (!url) throw new Error('ENSURE_SCHEMA_URL is required');
const applied = await ensureSchema(new PrismaPg({ connectionString: url }) as never);
console.log(`ensureSchema applied ${applied.length} migration(s): ${applied.join(', ')}`);
if (applied.length === 0) throw new Error('expected a fresh database — nothing was applied');
