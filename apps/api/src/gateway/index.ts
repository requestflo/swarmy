import { GatewayStore } from './store';
import { ConnectionRegistry } from './registry';
import { AgentHubImpl } from './hub';
import { handleAgentClose, handleAgentMessage } from './protocol-handlers';
import type { AgentSocket, AgentWsData } from './registry';

export const store = new GatewayStore();
export const registry = new ConnectionRegistry();
/** The single AgentHub instance shared by the WS gateway and tRPC context. */
export const hub = new AgentHubImpl(store, registry);

const deps = { hub, store, registry };

export type { AgentWsData };

export const agentWebSocketHandlers = {
  open(_ws: AgentSocket) {
    // ws.data is set at upgrade time.
  },
  async message(ws: AgentSocket, message: string | Buffer) {
    await handleAgentMessage(ws, typeof message === 'string' ? message : message.toString(), deps);
  },
  async close(ws: AgentSocket) {
    await handleAgentClose(ws, deps);
  },
};
