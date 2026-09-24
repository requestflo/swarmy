/**
 * Trivy DB refresh worker (self-reliance B6): once a day, every scan node
 * downloads the vulnerability DB into its shared `swarmy-trivy-cache` volume,
 * so scans never fetch it themselves. A failed refresh is harmless — scans use
 * the cached DB and admission only warns that it is stale.
 */
import { prisma } from '@swarmy/db';
import { authRegistry } from '@swarmy/auth';
import { refreshTrivyDbAllOrgs } from '@swarmy/trpc';
import { hub } from '../gateway';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 10 * 60 * 1000;

export function startTrivyDbRefresh(): () => void {
  const run = async () => {
    await refreshTrivyDbAllOrgs({ db: prisma, hub, auth: authRegistry.getAuth() }).catch(() => undefined);
  };
  const kickoff = setTimeout(run, FIRST_RUN_DELAY_MS);
  const timer = setInterval(run, REFRESH_INTERVAL_MS);
  return () => {
    clearTimeout(kickoff);
    clearInterval(timer);
  };
}
