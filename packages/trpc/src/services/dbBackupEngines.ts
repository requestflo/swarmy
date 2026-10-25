/**
 * Which DB backup engines this controller can run. Every engine runs on an
 * image the BOM names, except pgBackRest: there is no upstream image and
 * swarmy builds none (`@swarmy/core/protocol` `PGBACKREST_NO_IMAGE` says why
 * in plain words). So pgbackrest is offered only once the operator names an
 * image in `SWARMY_PGBACKREST_IMAGE`, and every path that would run it (a
 * backup, a schedule, a restore) is refused before anything is touched.
 *
 * Pure over `env`. Unit-tested in `dbBackupEngines.test.ts`.
 */
import { DbBackupEngine, PGBACKREST_IMAGE_ENV, PGBACKREST_NO_IMAGE } from '@swarmy/core/protocol';
import { commandRejected } from '../errors';

type Env = Record<string, string | undefined>;

export interface DbBackupEngineOffer {
  engine: DbBackupEngine;
  /** False: the dashboard hides it, and the controller refuses it with `reason`. */
  offered: boolean;
  reason: string | null;
}

/** The operator's pgBackRest image, or undefined when none is set. */
export function pgBackRestImageFrom(env: Env = process.env): string | undefined {
  return env[PGBACKREST_IMAGE_ENV]?.trim() || undefined;
}

/** Every engine, in the wire enum's order, with whether this controller runs it. */
export function dbBackupEngineOffers(env: Env = process.env): DbBackupEngineOffer[] {
  return DbBackupEngine.options.map((engine) => {
    const offered = engine !== 'pgbackrest' || pgBackRestImageFrom(env) !== undefined;
    return { engine, offered, reason: offered ? null : PGBACKREST_NO_IMAGE };
  });
}

/** Refuse an engine this controller can't run (before any backup, schedule or restore starts). */
export function assertEngineOffered(engine: DbBackupEngine, env: Env = process.env): void {
  const offer = dbBackupEngineOffers(env).find((o) => o.engine === engine);
  if (offer && !offer.offered) throw commandRejected(offer.reason ?? `the ${engine} engine is not available`);
}

/** The `engineImage` a dispatch carries: the operator's pgBackRest image; other engines use their BOM default. */
export function engineImageFor(engine: DbBackupEngine, env: Env = process.env): { engineImage?: string } {
  const image = engine === 'pgbackrest' ? pgBackRestImageFrom(env) : undefined;
  return image ? { engineImage: image } : {};
}
