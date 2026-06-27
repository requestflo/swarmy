/**
 * Build-log bridge (epic: git-cicd-registry, PHASE-2).
 *
 * Forwards build output from the gateway's in-memory `logEvent` (fed by every
 * `logChunk` the agent sends) into the shared `buildLogBus`, keyed by the
 * `commandId` — which IS the build's `logsRef`. The live build-log viewer
 * subscribes to the bus by that key, so the tRPC services layer never needs the
 * gateway's `AgentHub` internals.
 *
 * Started once from gateway/index.ts (it owns the `store`).
 */
import { buildLogBus } from '@swarmy/trpc';
import type { GatewayStore } from './store';

export function startBuildLogBridge(store: GatewayStore): () => void {
  return store.logEvent.on(({ commandId, line }) => {
    // `message === ''` with the chunk's eof flag is the terminal marker; the
    // gateway flattens chunks into LogLines so we treat an empty message as eof.
    buildLogBus.push(commandId, line, line.message === '');
  });
}
