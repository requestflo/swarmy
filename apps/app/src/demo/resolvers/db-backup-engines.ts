import type { DbBackupEngine } from '@swarmy/core/protocol';
import type { DomainResolvers } from '../types';

/**
 * The demo's `dbBackups.engines`: a controller with no operator-supplied
 * pgBackRest image, so the picker hides it (as on a fresh install).
 */
const ENGINES: DbBackupEngine[] = ['pg_dump', 'pg_dumpall', 'snapshot-from-replica', 'wal-g', 'pgbackrest'];
/** The controller's words (`PGBACKREST_NO_IMAGE`); the demo bundle doesn't load the wire protocol. */
const NO_IMAGE =
  "pgBackRest backups need a pgBackRest image, and swarmy doesn't ship one (none is published upstream). " +
  'Use wal-g for point-in-time restore, or set SWARMY_PGBACKREST_IMAGE on the controller to an image you trust.';

export const dbBackupEngines: DomainResolvers = {
  handlers: {
    'dbBackups.engines': () =>
      ENGINES.map((engine) => ({
        engine,
        offered: engine !== 'pgbackrest',
        reason: engine === 'pgbackrest' ? NO_IMAGE : null,
      })),
  },
};
