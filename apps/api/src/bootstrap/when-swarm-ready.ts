/**
 * Boot-time config that lives in the org's swarm (swarm-kv) can only be
 * written once a manager agent has dialled in. Retry until then (logged once,
 * not silent); the writes are idempotent re-assertions of env.
 */
export function whenSwarmReady(what: string, fn: () => Promise<void>, everyMs = 5_000): void {
  let warned = false;
  const attempt = (): void => {
    fn().catch((e: unknown) => {
      if (!warned) {
        // eslint-disable-next-line no-console
        console.log(`[bootstrap] ${what}: waiting for a manager agent (${e instanceof Error ? e.message : String(e)})`);
        warned = true;
      }
      setTimeout(attempt, everyMs).unref?.();
    });
  };
  attempt();
}
