/**
 * The gateway's process-wide singletons with NO dependency on the hub.
 * Modules the hub itself imports (e.g. `../terminal`) take `registry` from
 * here, not from `./index` — importing `./index` from inside the hub's own
 * import graph evaluated `new AgentHubImpl(...)` before `hub.ts` finished
 * loading ("Cannot access 'AgentHubImpl' before initialization").
 */
import { GatewayStore } from './store';
import { ConnectionRegistry } from './registry';

export const store = new GatewayStore();
export const registry = new ConnectionRegistry();
