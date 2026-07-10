import { JOIN_TOKEN_PREFIX } from '@swarmy/core';
import {
  modelsToCompose,
  ServiceModel,
  validateModel,
  type ServiceModelOut,
  type TranslationWarning,
} from '@swarmy/core/compose';
import { DEMO_NODES, DEMO_SERVICES, DEMO_USER } from '../data';
import type { DemoStore, DomainResolvers } from '../types';

/**
 * "Infra extras" demo resolvers — the supporting infrastructure surfaces that
 * sit alongside the core Infrastructure/Applications planes:
 *
 *  • nodes (join tokens) — the node-onboarding flow (Settings → Tokens and the
 *    guided /nodes/new one-liner): mint, list, revoke join tokens.
 *  • terminal — container exec + node-shell control plane, recorded-session
 *    replay, and the node-shell break-glass approval request.
 *  • builder — the GUI service builder's compose import/export + full-fidelity
 *    deploy path.
 *
 * Everything this module owns lives under `store.extra.infraextra` so mutations
 * (mint a token, revoke it, open a session) stick for the session — the UI
 * invalidates and re-reads on success, so the change reads as live. Return
 * shapes mirror the tRPC service views exactly (token.service `JoinTokenView` /
 * `JoinTokenIssued`, terminal.service `TerminalSessionRow` / `TerminalApprovalRow`,
 * builder.service `ParseComposeResult` / `{ yaml }` / `DeployFromBuilderResult`)
 * so the dashboard pages render unchanged.
 *
 * Demo mode has no data plane (no `/term/ws`), so `terminal.open` /
 * `openNodeShell` still return a believable `{ sessionId, ticket }`; the WebSocket
 * simply never connects (the terminal pane shows "connecting"), which is the
 * honest demo behavior for a backendless run.
 */

// ── View shapes (kept in lock-step with the @swarmy/* service views) ──────────

/** token.service `JoinTokenView`, but Date fields are ISO strings for the wire. */
interface JoinTokenView {
  id: string;
  label: string | null;
  /** WS7 install profile the token enrolls nodes with (null = default). */
  profile: 'default' | 'edge' | 'storage' | 'database' | 'private-mesh' | null;
  tokenPrefix: string;
  createdAt: string;
  expiresAt: string | null;
  maxUses: number | null;
  usedCount: number;
  revokedAt: string | null;
  status: 'active' | 'expired' | 'exhausted' | 'revoked';
}

/** token.service `JoinTokenIssued` (the one-time reveal). */
interface JoinTokenIssued {
  id: string;
  token: string;
  expiresAt: string;
  maxUses: number;
  label: string | null;
  profile: JoinTokenView['profile'];
}

type TermTargetKind = 'container' | 'nodeShell';

/** terminal.service `TerminalSessionRow`, ISO-string dates for the wire. */
interface TerminalSessionView {
  id: string;
  orgId: string;
  actorId: string;
  nodeId: string;
  targetKind: TermTargetKind;
  containerId: string | null;
  command: unknown;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  reason: string | null;
  recordingRef: string | null;
  bytesIn: number;
  bytesOut: number;
  clientIp: string | null;
  approvedById: string | null;
}

type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

/** terminal.service `TerminalApprovalRow`, ISO-string dates for the wire. */
interface TerminalApprovalView {
  id: string;
  orgId: string;
  requestedById: string;
  nodeId: string;
  reason: string;
  status: ApprovalStatus;
  approvedById: string | null;
  expiresAt: string;
  createdAt: string;
}

/** The free-form bag this module owns under `store.extra.infraextra`. */
interface InfraExtraState {
  tokens: JoinTokenView[];
  /** The raw secret minted per token id (so a re-reveal would be possible). */
  issued: Record<string, string>;
  sessions: TerminalSessionView[];
  approvals: TerminalApprovalView[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const now = Date.now();
const iso = (msAgo: number): string => new Date(now - msAgo).toISOString();
const isoIn = (msAhead: number): string => new Date(now + msAhead).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const rid = (n = 6): string => Math.random().toString(36).slice(2, 2 + n);
const hex = (n: number): string => {
  let s = '';
  for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
};

function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `${hex(8)}-${hex(4)}-${hex(4)}-${hex(4)}-${hex(12)}`;
}

function state(store: DemoStore): InfraExtraState {
  return store.extra.infraextra as InfraExtraState;
}

/** Recompute a token's status the way token.service `tokenStatus` does. */
function tokenStatus(t: {
  revokedAt: string | null;
  expiresAt: string | null;
  maxUses: number | null;
  usedCount: number;
}): JoinTokenView['status'] {
  if (t.revokedAt) return 'revoked';
  if (t.expiresAt && new Date(t.expiresAt).getTime() < Date.now()) return 'expired';
  if (t.maxUses != null && t.usedCount >= t.maxUses) return 'exhausted';
  return 'active';
}

// ── Recording: a synthetic asciicast v2 for the session-replay player ─────────

/**
 * The replay player (`AsciinemaPlayer`) parses the header line + `[t,'o',data]`
 * output events and writes `data` into xterm verbatim, so a plain-string cast
 * with ANSI escapes replays as a believable recorded shell session.
 */
function buildCast(): string {
  const header = { version: 2, width: 100, height: 30, timestamp: Math.floor((now - 6 * HOUR) / 1000) };
  const ev = (t: number, data: string): string => JSON.stringify([t, 'o', data]);
  const P = '[1;32mpilot@wkr-1[0m:[1;34m~[0m$ ';
  const lines = [
    JSON.stringify(header),
    ev(0.4, `${P}`),
    ev(1.1, 'whoami\r\n'),
    ev(1.2, 'root\r\n'),
    ev(1.9, `${P}`),
    ev(2.6, 'ps -eo pid,comm --sort=-%cpu | head -4\r\n'),
    ev(2.8, '  PID COMMAND\r\n    1 tini\r\n   14 node\r\n   42 nginx\r\n'),
    ev(3.6, `${P}`),
    ev(4.3, 'curl -s localhost:8080/healthz\r\n'),
    ev(4.7, '{"status":"ok","uptime":48213}\r\n'),
    ev(5.5, `${P}`),
    ev(6.2, 'exit\r\n'),
    ev(6.4, '[2mlogout[0m\r\n'),
  ];
  return `${lines.join('\n')}\n`;
}

// ── Seed: a believable Northwind onboarding + terminal posture ────────────────

function seedTokens(): { tokens: JoinTokenView[]; issued: Record<string, string> } {
  const issued: Record<string, string> = {};
  const mk = (
    id: string,
    label: string | null,
    createdMsAgo: number,
    ttlMs: number,
    maxUses: number | null,
    usedCount: number,
    revokedMsAgo: number | null,
  ): JoinTokenView => {
    const prefix = hex(8);
    issued[id] = `${JOIN_TOKEN_PREFIX}_${prefix}_${rid(24)}`;
    const t: JoinTokenView = {
      id,
      label,
      profile: null,
      tokenPrefix: prefix,
      createdAt: iso(createdMsAgo),
      expiresAt: isoIn(ttlMs - createdMsAgo),
      maxUses,
      usedCount,
      revokedAt: revokedMsAgo != null ? iso(revokedMsAgo) : null,
      status: 'active',
    };
    t.status = tokenStatus(t);
    return t;
  };
  return {
    issued,
    tokens: [
      mk('jt-fleet', 'prod-worker-fleet', 2 * HOUR, 7 * DAY, 25, 6, null),
      mk('jt-edge', 'edge-eu-west', 3 * DAY, 7 * DAY, 5, 5, null),
      mk('jt-spare', 'spare-capacity', 6 * HOUR, 24 * HOUR, 1, 0, null),
      mk('jt-old', 'bootstrap-mgr', 40 * DAY, 7 * DAY, 1, 1, null),
      mk('jt-revoked', 'misconfigured-runner', 5 * DAY, 7 * DAY, 10, 2, 4 * DAY),
    ],
  };
}

function seedSessions(): TerminalSessionView[] {
  const wkr1 = DEMO_NODES.find((n) => n.id === 'n-wkr-1')?.id ?? 'n-wkr-1';
  const mgr2 = DEMO_NODES.find((n) => n.id === 'n-mgr-2')?.id ?? 'n-mgr-2';
  const apiSvc = DEMO_SERVICES.find((s) => s.id === 'svc-api');
  return [
    {
      id: 'term-1',
      orgId: 'org-demo',
      actorId: DEMO_USER.id,
      nodeId: wkr1,
      targetKind: 'container',
      containerId: `ctr-${apiSvc?.id ?? 'svc-api'}`,
      command: { kind: 'container', containerId: `ctr-${apiSvc?.id ?? 'svc-api'}`, cmd: [] },
      startedAt: iso(6 * HOUR),
      endedAt: iso(6 * HOUR - 6_400),
      exitCode: 0,
      reason: 'exit',
      recordingRef: 'rec/term-1.cast',
      bytesIn: 184,
      bytesOut: 2_413,
      clientIp: '203.0.113.24',
      approvedById: null,
    },
    {
      id: 'term-2',
      orgId: 'org-demo',
      actorId: 'user-ada',
      nodeId: mgr2,
      targetKind: 'nodeShell',
      containerId: null,
      command: { kind: 'nodeShell', cmd: [] },
      startedAt: iso(2 * DAY),
      endedAt: iso(2 * DAY - 42_000),
      exitCode: 0,
      reason: 'exit',
      recordingRef: 'rec/term-2.cast',
      bytesIn: 512,
      bytesOut: 9_874,
      clientIp: '198.51.100.7',
      approvedById: 'appr-approved',
    },
  ];
}

function seedApprovals(): TerminalApprovalView[] {
  const wkr2 = DEMO_NODES.find((n) => n.id === 'n-wkr-2')?.id ?? 'n-wkr-2';
  const mgr2 = DEMO_NODES.find((n) => n.id === 'n-mgr-2')?.id ?? 'n-mgr-2';
  return [
    {
      id: 'appr-approved',
      orgId: 'org-demo',
      requestedById: 'user-ada',
      nodeId: mgr2,
      reason: 'investigate elevated memory on mgr-2',
      status: 'approved',
      approvedById: DEMO_USER.id,
      expiresAt: isoIn(8 * MIN),
      createdAt: iso(2 * DAY + 4 * MIN),
    },
    {
      id: 'appr-pending',
      orgId: 'org-demo',
      requestedById: DEMO_USER.id,
      nodeId: wkr2,
      reason: 'break-glass disk pressure triage',
      status: 'pending',
      approvedById: null,
      expiresAt: isoIn(11 * MIN),
      createdAt: iso(4 * MIN),
    },
  ];
}

// ── Builder helpers ───────────────────────────────────────────────────────────

/**
 * Browser-safe YAML emit. apps/app intentionally ships no `yaml` lib (it runs in
 * the browser; the controller has the real lib in non-demo mode), so we render
 * the compose object (from the PURE `modelsToCompose`) with a tiny block-style
 * serializer. It only needs to handle the compose shape: nested objects, arrays
 * of scalars/objects, and scalar leaves — enough to read in the preview pane and
 * download as a `.compose.yaml` file.
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function yamlScalar(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  // Quote when the value could be misread as a non-string scalar or has YAML-
  // significant characters; otherwise emit bare for readability.
  if (s === '' || /^[\s]|[\s]$|[:#{}[\],&*!|>'"%@`]|^[-?]|^(true|false|null|~)$|^-?\d/.test(s)) {
    return JSON.stringify(s);
  }
  return s;
}

function toYaml(value: unknown, indent = 0): string {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}[]\n`;
    let out = '';
    for (const item of value) {
      if (isPlainObject(item) || Array.isArray(item)) {
        const block = toYaml(item, indent + 1);
        // Splice the dash onto the first line of the child block.
        const trimmed = block.replace(/^\s+/, '');
        out += `${pad}- ${trimmed}`;
      } else {
        out += `${pad}- ${yamlScalar(item)}\n`;
      }
    }
    return out;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return `${pad}{}\n`;
    let out = '';
    for (const [k, v] of entries) {
      if (isPlainObject(v) && Object.keys(v).length > 0) {
        out += `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      } else if (Array.isArray(v) && v.length > 0) {
        out += `${pad}${k}:\n${toYaml(v, indent + 1)}`;
      } else if (Array.isArray(v)) {
        out += `${pad}${k}: []\n`;
      } else if (isPlainObject(v)) {
        out += `${pad}${k}: {}\n`;
      } else {
        out += `${pad}${k}: ${yamlScalar(v)}\n`;
      }
    }
    return out;
  }
  return `${pad}${yamlScalar(value)}\n`;
}

/**
 * Browser-safe compose import: parse without a YAML lib (the controller has one;
 * the demo runs entirely in the browser). We support the common `services:`
 * subset the import dialog's example exercises — image, deploy.replicas, ports,
 * environment — and surface info/warn translation notes like the real path.
 */
function parseComposeSource(
  source: string,
): { models: ServiceModelOut[]; warnings: TranslationWarning[]; parseError?: string } {
  const warnings: TranslationWarning[] = [];
  const lines = source.replace(/\t/g, '  ').split('\n');

  interface Raw {
    name: string;
    image?: string;
    replicas?: number;
    ports: { target: number; published?: number }[];
    env: Record<string, string>;
  }

  const services: Raw[] = [];
  let inServices = false;
  let current: Raw | null = null;
  let listKey: 'ports' | 'environment' | null = null;

  const indentOf = (l: string): number => l.length - l.trimStart().length;

  for (const rawLine of lines) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;
    const indent = indentOf(rawLine);
    const line = rawLine.trim();

    if (indent === 0) {
      inServices = line.startsWith('services:');
      current = null;
      listKey = null;
      continue;
    }
    if (!inServices) continue;

    // service name (one level under `services:`)
    if (indent <= 2 && line.endsWith(':')) {
      current = { name: line.slice(0, -1).trim(), ports: [], env: {} };
      services.push(current);
      listKey = null;
      continue;
    }
    if (!current) continue;

    // list items belong to the most recent key
    if (line.startsWith('- ')) {
      const item = line.slice(2).trim().replace(/^["']|["']$/g, '');
      if (listKey === 'ports') {
        const [a, b] = item.split(':');
        if (b) current.ports.push({ published: Number(a), target: Number(b) });
        else if (a) current.ports.push({ target: Number(a) });
      } else if (listKey === 'environment') {
        const eq = item.indexOf('=');
        if (eq > 0) current.env[item.slice(0, eq)] = item.slice(eq + 1);
      }
      continue;
    }

    listKey = null;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');

    if (key === 'image') current.image = value;
    else if (key === 'replicas') current.replicas = Number(value);
    else if (key === 'ports' || key === 'environment') listKey = key;
    else if (key === 'build') {
      warnings.push({
        level: 'warn',
        path: `${current.name}.build`,
        code: 'unsupported-key',
        message: 'Swarm ignores `build`; push a pre-built image instead.',
      });
    }
  }

  if (services.length === 0) {
    return { models: [], warnings: [], parseError: 'no services found in compose document' };
  }

  const models = services.map((raw) => {
    if (!raw.image) {
      warnings.push({
        level: 'warn',
        path: `${raw.name}.image`,
        code: 'image-required',
        message: 'service has no image and cannot be deployed',
      });
    }
    return ServiceModel.parse({
      name: raw.name,
      image: raw.image ?? '',
      replicas: raw.replicas ?? 1,
      env: raw.env,
      ports: raw.ports.map((p) => ({ target: p.target, published: p.published })),
    });
  });

  return { models, warnings };
}

// ── Resolvers ───────────────────────────────────────────────────────────────

export const infraextra: DomainResolvers = {
  handlers: {
    // ── nodes: join tokens ──────────────────────────────────────────────────
    'nodes.generateJoinToken': (input, store): JoinTokenIssued => {
      const args = (input ?? {}) as {
        ttlSeconds?: number;
        maxUses?: number;
        label?: string;
        profile?: JoinTokenView['profile'];
      };
      const s = state(store);
      const ttlMs = Math.min(args.ttlSeconds ?? 3600, 604_800) * 1000;
      const maxUses = Math.min(args.maxUses ?? 1, 100);
      const id = `jt-${rid(8)}`;
      const prefix = hex(8);
      const token = `${JOIN_TOKEN_PREFIX}_${prefix}_${rid(32)}`;
      const expiresAt = isoIn(ttlMs);
      const row: JoinTokenView = {
        id,
        label: args.label ?? null,
        profile: args.profile && args.profile !== 'default' ? args.profile : null,
        tokenPrefix: prefix,
        createdAt: new Date().toISOString(),
        expiresAt,
        maxUses,
        usedCount: 0,
        revokedAt: null,
        status: 'active',
      };
      s.tokens.unshift(row);
      s.issued[id] = token;
      return { id, token, expiresAt, maxUses, label: row.label, profile: row.profile };
    },

    'nodes.listJoinTokens': (_input, store): JoinTokenView[] =>
      state(store).tokens.map((t) => ({ ...t, status: tokenStatus(t) })),

    'nodes.revokeJoinToken': (input, store): { id: string; revoked: true } => {
      const { id } = input as { id: string };
      const t = state(store).tokens.find((x) => x.id === id);
      if (t) {
        t.revokedAt = new Date().toISOString();
        t.status = 'revoked';
      }
      return { id, revoked: true };
    },

    // Recovery beacon (self-healing epic): demo has no dark nodes, so no
    // pending claims — the banner hides itself on an empty list.
    'nodes.recoveryClaims': (): unknown[] => [],
    'nodes.resolveRecoveryClaim': (input): { status: string } => {
      const { approve } = input as { approve: boolean };
      return { status: approve ? 'approved' : 'denied' };
    },

    // ── terminal: control plane ─────────────────────────────────────────────
    'terminal.open': (input, store): { sessionId: string; ticket: string } => {
      const { serviceId } = input as { serviceId: string };
      const s = state(store);
      const svc = store.services.find((x) => x.id === serviceId);
      const nodeId = svc?.nodeId ?? store.nodes.find((n) => n.status === 'online')?.id ?? 'n-wkr-1';
      const sessionId = uuid();
      const containerId = `ctr-${serviceId}`;
      s.sessions.unshift({
        id: sessionId,
        orgId: store.org.id,
        actorId: store.user.id,
        nodeId,
        targetKind: 'container',
        containerId,
        command: { kind: 'container', containerId, cmd: [] },
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null,
        reason: null,
        recordingRef: null,
        bytesIn: 0,
        bytesOut: 0,
        clientIp: '203.0.113.24',
        approvedById: null,
      });
      return { sessionId, ticket: `tkt_${rid(24)}` };
    },

    'terminal.openNodeShell': (input, store): { sessionId: string; ticket: string } => {
      const { nodeId } = input as { nodeId: string };
      const s = state(store);
      const sessionId = uuid();
      const approval = s.approvals.find(
        (a) => a.nodeId === nodeId && a.requestedById === store.user.id && a.status === 'approved',
      );
      s.sessions.unshift({
        id: sessionId,
        orgId: store.org.id,
        actorId: store.user.id,
        nodeId,
        targetKind: 'nodeShell',
        containerId: null,
        command: { kind: 'nodeShell', cmd: [] },
        startedAt: new Date().toISOString(),
        endedAt: null,
        exitCode: null,
        reason: null,
        recordingRef: null,
        bytesIn: 0,
        bytesOut: 0,
        clientIp: '203.0.113.24',
        approvedById: approval?.id ?? null,
      });
      return { sessionId, ticket: `tkt_${rid(24)}` };
    },

    'terminal.get': (input, store): TerminalSessionView | null => {
      const { id } = input as { id: string };
      return state(store).sessions.find((x) => x.id === id) ?? null;
    },

    'terminal.recording.get': (input, store): { cast: string } => {
      const { id } = input as { id: string };
      // Any seeded session with a recordingRef replays the synthetic cast.
      const session = state(store).sessions.find((x) => x.id === id);
      if (!session || !session.recordingRef) {
        // Surface "no recording" the way the real router does (NOT_FOUND); the
        // replay page shows its "No recording" alert.
        throw new Error('no recording for this session');
      }
      return { cast: buildCast() };
    },

    'terminal.approval.request': (input, store): TerminalApprovalView => {
      const args = input as { nodeId: string; reason: string; ttlMs?: number };
      const s = state(store);
      const row: TerminalApprovalView = {
        id: `appr-${rid(8)}`,
        orgId: store.org.id,
        requestedById: store.user.id,
        nodeId: args.nodeId,
        reason: args.reason,
        status: 'pending',
        approvedById: null,
        expiresAt: isoIn(args.ttlMs ?? 15 * MIN),
        createdAt: new Date().toISOString(),
      };
      s.approvals.unshift(row);
      return row;
    },

    // ── builder: compose import/export + deploy ──────────────────────────────
    'builder.parseCompose': (input) => {
      const { source } = input as { source: string };
      return parseComposeSource(source);
    },

    'builder.exportCompose': (input): { yaml: string } => {
      const { models } = input as { models: unknown[] };
      const parsed = models.map((m) => ServiceModel.parse(m));
      const obj = modelsToCompose(parsed);
      return { yaml: toYaml(obj) };
    },

    'builder.deploy': (input, store): { id: string; deploymentId: string; warnings: TranslationWarning[] } => {
      const args = input as { model: unknown; nodeId?: string };
      const model = ServiceModel.parse(args.model);
      const warnings = validateModel(model);
      const id = `svc-${model.name}-${rid(4)}`;
      const replicas = model.mode === 'global' ? 1 : model.replicas;
      // Land the new service in the core store so the canvas / lists show it.
      store.services.unshift({
        id,
        name: model.name,
        image: model.image,
        status: 'deploying',
        replicas: { desired: replicas, running: 0 },
        ingressEnabled: model.ports.some((p) => p.mode === 'ingress'),
        nodeId: args.nodeId ?? null,
        stackId: null,
        updatedAt: new Date().toISOString(),
        env: model.env,
        ports: model.ports.map((p) => ({
          target: p.target,
          published: p.published ?? p.target,
          protocol: p.protocol,
          mode: p.mode,
        })),
        volumes: [],
        networks: model.networks.length ? model.networks : ['swarmy_public'],
        constraints: model.placement?.constraints ?? [],
        swarmServiceId: `svc-${id}`,
        createdAt: new Date().toISOString(),
      });
      return { id, deploymentId: `dep-${rid(8)}`, warnings };
    },
  },

  seed: (store) => {
    const { tokens, issued } = seedTokens();
    const s: InfraExtraState = {
      tokens,
      issued,
      sessions: seedSessions(),
      approvals: seedApprovals(),
    };
    store.extra.infraextra = s;
  },
};
