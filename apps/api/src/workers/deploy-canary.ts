/**
 * Canary/blue-green watcher hook, iterated by the deploy-safety worker.
 *
 * Spine stub — slice D2 fills the real promote/rollback logic. Kept as a
 * separate module so D1 (health gates) and D2 (canary) never edit the same file.
 */
export const canaryTick = async (): Promise<void> => {};
