/**
 * Daemon-mode shim. The binary's real entrypoint is `main.ts` (CLI dispatch:
 * status/doctor/backup/… — see cli/). This file keeps every pre-CLI launch
 * path working unchanged: the container image's `bun run src/index.ts`
 * ENTRYPOINT, `bun run dev:agent`, and any tooling that imported the old
 * daemon entry. It just runs the daemon.
 */
import { runDaemon } from './daemon';

void runDaemon();
