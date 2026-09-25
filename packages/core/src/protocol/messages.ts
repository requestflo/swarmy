import { z } from 'zod';
import { envelope } from './primitives';
import { ProtocolError } from './errors';
import { RegisterMsg, RegisterAckMsg } from './auth';
import { HeartbeatMsg, MetricsMsg } from './stats';
import { ContainerListMsg, ServiceStateMsg, NodeListMsg, SwarmLeftMsg } from './containers';
import {
  DeployServiceMsg,
  EnsureNetworkMsg,
  RemoveStackNetworksMsg,
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
import { ApplyIngressMsg, IngressNodeStatusMsg } from './ingress';
import { ApplyMeshMsg, MeshStateMsg, ApplyMeshControlMsg, ApplyAccessRouterMsg } from './mesh';
import { ApplyDnsMsg } from './dns';
import { BuildImageMsg } from './build';
import { PruneImagesMsg } from './prune';
import { NodeHygieneMsg } from './hygiene';
import { ApplyStorageNodeMsg, ListVolumesMsg, ProvisionVolumeMsg, RemoveVolumeMsg } from './storage';
import { SwarmJoinMsg, SwarmRotateTokensMsg, SwarmSetAutolockMsg } from './swarm';
import { BackupVolumeMsg, RestoreVolumeMsg, ListSnapshotsMsg } from './backup';
import { DbBackupMsg, DbRestoreMsg } from './dbBackup';
import { ControllerServiceMsg } from './controllerService';
import { AppDbBackupMsg, AppDbRestoreMsg, AppDbVerifyMsg } from './appDb';
import { QueueOpMsg } from './queueOp';
import { DbQueryMsg } from './studio';
import { ProbeSmtpMsg } from './email';
import { FormatDiskMsg, GrowDiskMsg, ListDisksMsg } from './disk';
import {
  SecretCreateMsg,
  SecretRemoveMsg,
  SecretListMsg,
  ConfigCreateMsg,
  ConfigRemoveMsg,
  ConfigListMsg,
  ConfigInspectMsg,
  RunOnceMsg,
} from './swarmres';
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
  SwarmLeftMsg,
  CommandResultMsg,
  LogChunkMsg,
  AckMsg,
  AgentErrorMsg,
  TermStartedMsg,
  TermDataMsg,
  TermExitMsg,
  MeshStateMsg,
  IngressNodeStatusMsg,
]);
export type AgentToControllerMessage = z.infer<typeof AgentToControllerMessage>;

/** Messages (mostly commands) the controller sends to the agent. */
export const ControllerToAgentMessage = z.discriminatedUnion('type', [
  RegisterAckMsg,
  DeployServiceMsg,
  EnsureNetworkMsg,
  RemoveStackNetworksMsg,
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
  ApplyMeshControlMsg,
  ApplyAccessRouterMsg,
  ApplyDnsMsg,
  BuildImageMsg,
  PruneImagesMsg,
  NodeHygieneMsg,
  ApplyStorageNodeMsg,
  ProvisionVolumeMsg,
  RemoveVolumeMsg,
  ListVolumesMsg,
  ListDisksMsg,
  FormatDiskMsg,
  GrowDiskMsg,
  SwarmJoinMsg,
  SwarmSetAutolockMsg,
  SwarmRotateTokensMsg,
  ControllerServiceMsg,
  ProbeSmtpMsg,
  BackupVolumeMsg,
  RestoreVolumeMsg,
  ListSnapshotsMsg,
  DbBackupMsg,
  DbRestoreMsg,
  AppDbBackupMsg,
  AppDbRestoreMsg,
  AppDbVerifyMsg,
  QueueOpMsg,
  DbQueryMsg,
  SecretCreateMsg,
  SecretRemoveMsg,
  SecretListMsg,
  ConfigCreateMsg,
  ConfigRemoveMsg,
  ConfigListMsg,
  ConfigInspectMsg,
  RunOnceMsg,
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

export const AgentEnvelope = envelope(AgentToControllerMessage);
export type AgentEnvelope = z.infer<typeof AgentEnvelope>;

export const ControllerEnvelope = envelope(ControllerToAgentMessage);
export type ControllerEnvelope = z.infer<typeof ControllerEnvelope>;

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
