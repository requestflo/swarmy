import { prisma } from '@swarmy/db';
// NOTE: `isBackupDue` + `runControllerBackup` must be re-exported from
// `@swarmy/trpc` (see INTEGRATION — trpc/src/index.ts additions); the package's
// `exports` map only exposes the root entry.
import { isBackupDue, runControllerBackup } from '@swarmy/trpc';

/**
 * Controller-state backup scheduler (data-store epic, P1).
 *
 * Mirrors the volumes-DR `backup-scheduler`: once a minute, if the singleton
 * `ControllerBackupConfig` is enabled, has a target + passphrase, and is due,
 * run a controller-state backup and advance `nextRunAt`. Runs controller-side
 * (the bundle carries the controller's own secrets — never dispatched to an
 * agent). Default schedule when enabled: daily, keep 7d/4w/3m.
 */
export function startControllerBackupScheduler(): () => void {
  const tick = async () => {
    try {
      if (!(await isBackupDue(prisma))) return;
      // A scheduler run is a `system` actor; org-independent (orgId is nominal).
      await runControllerBackup({ db: prisma, activeOrgId: 'system', user: null });
    } catch {
      // best-effort; failures are recorded on the ControllerSnapshot row.
    }
  };
  const timer = setInterval(() => void tick(), 60 * 1000);
  return () => clearInterval(timer);
}
