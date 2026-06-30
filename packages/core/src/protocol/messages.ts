import { z } from 'zod';
import { PROTOCOL_VERSION } from './constants';
import { envelope } from './primitives';
import { ProtocolError } from './errors';
import { RegisterMsg, RegisterAckMsg } from './auth';
import { HeartbeatMsg, MetricsMsg } from './stats';
import { ContainerListMsg, ServiceStateMsg, NodeListMsg } from './containers';
import {
  DeployServiceMsg,
  EnsureNetworkMsg,
  RemoveServiceMsg,
  ScaleServiceMsg,
  RestartServiceMsg,
  InspectServiceMsg,
  UpdateServiceLabelsMsg,
  PullImageMsg,
  ExecCommandMsg,
  StreamLogsMsg,
  UpdateSwarmNodeMsg,
  UpdateAgentMsg,
  PingMsg,
} from './commands';
import { ApplyIngressMsg } from './ingress';
import { ApplyMeshMsg, MeshStateMsg, GrantDirectRouteMsg } from './mesh';
import { BuildImageMsg } from './build';
import { PruneImagesMsg } from './prune';
import { ApplyStorageNodeMsg, ProvisionVolumeMsg, RemoveVolumeMsg } from './storage';
import { SwarmJoinMsg } from './swarm';
import { BackupVolumeMsg, RestoreVolumeMsg, ListSnapshotsMsg } from './backup';
import { DbBackupMsg, DbRestoreMsg } from './dbBackup';
import {
  TermStartMsg,
  TermInputMsg,
  TermResizeMsg,
  TermCloseMsg,
  TermStartedMsg,
  TermDataMsg,
  TermExitMsg,
} from './terminal';
import {
  CommandResultMsg,
  LogChunkMsg,
  AckMsg,
  AgentErrorMsg,
  ControllerErrorMsg,
} from './results';

/** Messages the agent sends to the controller. */
export const AgentToControllerMessage = z.discriminatedUnion('type', [
  RegisterMsg,
  HeartbeatMsg,
  MetricsMsg,
  ContainerListMsg,
  ServiceStateMsg,
  NodeListMsg,
  CommandResultMsg,
  LogChunkMsg,
  AckMsg,
  AgentErrorMsg,
  TermStartedMsg,
  TermDataMsg,
  TermExitMsg,
  MeshStateMsg,
]);
export type AgentToControllerMessage = z.infer<typeof AgentToControllerMessage>;
export type AgentMessageType = AgentToControllerMessage['type'];

/** Messages (mostly commands) the controller sends to the agent. */
export const ControllerToAgentMessage = z.discriminatedUnion('type', [
  RegisterAckMsg,
  DeployServiceMsg,
  EnsureNetworkMsg,
  RemoveServiceMsg,
  ScaleServiceMsg,
  RestartServiceMsg,
  InspectServiceMsg,
  UpdateServiceLabelsMsg,
  PullImageMsg,
  ExecCommandMsg,
  StreamLogsMsg,
  ApplyIngressMsg,
  ApplyMeshMsg,
  GrantDirectRouteMsg,
  BuildImageMsg,
  PruneImagesMsg,
  ApplyStorageNodeMsg,
  ProvisionVolumeMsg,
  RemoveVolumeMsg,
  SwarmJoinMsg,
  BackupVolumeMsg,
  RestoreVolumeMsg,
  ListSnapshotsMsg,
  DbBackupMsg,
  DbRestoreMsg,
  TermStartMsg,
  TermInputMsg,
  TermResizeMsg,
  TermCloseMsg,
  UpdateSwarmNodeMsg,
  UpdateAgentMsg,
  PingMsg,
  AckMsg,
  ControllerErrorMsg,
]);
export type ControllerToAgentMessage = z.infer<typeof ControllerToAgentMessage>;
export type ControllerMessageType = ControllerToAgentMessage['type'];

export const AgentEnvelope = envelope(AgentToControllerMessage);
export type AgentEnvelope = z.infer<typeof AgentEnvelope>;

export const ControllerEnvelope = envelope(ControllerToAgentMessage);
export type ControllerEnvelope = z.infer<typeof ControllerEnvelope>;

/** Build a complete outbound frame around an inner message. */
export function createEnvelope<T extends AgentToControllerMessage | ControllerToAgentMessage>(
  inner: T,
): { v: typeof PROTOCOL_VERSION; id: string; ts: number } & T {
  return { v: PROTOCOL_VERSION, id: crypto.randomUUID(), ts: Date.now(), ...inner };
}

export function parseAgentEnvelope(raw: unknown): AgentEnvelope {
  const r = AgentEnvelope.safeParse(raw);
  if (!r.success) {
    throw new ProtocolError('E_MALFORMED', 'invalid agent envelope', r.error.flatten());
  }
  return r.data;
}

export function parseControllerEnvelope(raw: unknown): ControllerEnvelope {
  const r = ControllerEnvelope.safeParse(raw);
  if (!r.success) {
    throw new ProtocolError('E_MALFORMED', 'invalid controller envelope', r.error.flatten());
  }
  return r.data;
}
