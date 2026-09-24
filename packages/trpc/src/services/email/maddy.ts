/**
 * The MTA: maddy (foxcpp/maddy), rendered and deployed as the `swarmy-mail`
 * system service. Pure — the render, the Docker secrets it needs and the
 * service spec; `email-deploy.service.ts` does the IO.
 *
 * Why maddy (evaluated for 1 GB nodes, 2026-09): one static Go binary with
 * submission + AUTH, DKIM signing, a persistent retry queue, per-sender-domain
 * routing (direct MX or smarthost) and DSN generation built in — ~20–30 MB RSS
 * idle. Postfix needs OpenDKIM and a multi-process config for the same result;
 * Haraka is a Node process at ~80 MB before plugins. Active upstream (0.9.x,
 * 2026).
 *
 * Shape of the render:
 *   submission :587 (plain TCP on the encrypted `swarmy` overlay, AUTH required)
 *     source <verified domains of one route> { authorize_sender; suppression
 *       rejects; dkim sign; deliver_to <route queue> }
 *     default_source → reject (unknown sender domain)
 *   route queue per delivery path: `direct` (target.remote, MX delivery) or one
 *     per smarthost (target.smtp with AUTH)
 *   every queue's DSNs → the controller's bounce hook (target.smtp →
 *     swarmy_controller:2525 over swarmy-control, AUTH with a derived token).
 *
 * SECRETS: the rendered config carries smarthost passwords and the bounce
 * token, so it ships as a Docker SECRET (never a config); so do the pass table,
 * the sender table and each DKIM key. All names are content-addressed
 * (`swarmy-mail-<part>-<sha8>`): a change is a new secret + a service update,
 * and superseded secrets are swept afterwards.
 */
import { createHash } from 'node:crypto';
import { STACK_LABEL, SWARMY_CONTROL_NETWORK, SYSTEM_STACK, SYSTEM_STACK_LABEL } from '@swarmy/core';
import type { ServiceSpec } from '@swarmy/core/protocol';

/** Pinned in the system-image BOM (`packages/core/src/system-images.ts`, key `maddy`). */
export const MADDY_IMAGE = 'foxcpp/maddy:0.9.5';
export const MAIL_SERVICE = 'swarmy-mail';
/** Apps reach submission here (the shared `swarmy` overlay). */
export const MAIL_HOST = MAIL_SERVICE;
export const SUBMISSION_PORT = 587;
/** The controller's bounce hook (apps/api `email-bounce-hook.ts`). */
export const BOUNCE_HOOK_PORT = 2525;
export const BOUNCE_HOOK_HOST = 'swarmy_controller';
/** The overlay apps are on (same as the OTel collector's). */
export const MAIL_APP_NETWORK = 'swarmy';
export const MAIL_SECRET_LABEL = 'swarmy.email.secret';
export const MAIL_NODE_LABEL = 'swarmy.email.node';
/** Marker on an app service bound by swarmy.yaml `email:`; value = JSON array of the plain env keys it set. */
export const EMAIL_BIND_LABEL = 'swarmy.email.bind';
const MAIL_SECRET_PREFIX = `${MAIL_SERVICE}-`;
const MAIL_DATA_VOLUME = 'swarmy-mail-data';
const CONFIG_PATH = '/run/secrets/maddy.conf';
/** SMTP username suffix for credentials (`<name>@swarmy`). */
export const SMTP_USER_DOMAIN = 'swarmy';
/** Bounce hook login the MTA presents to the controller. */
export const BOUNCE_HOOK_USER = 'maddy';
/** Recent suppressions rendered into the MTA as recipient rejects (the send API checks the full list). */
export const MAX_RENDERED_SUPPRESSIONS = 5000;

export interface MaddyRelay {
  host: string;
  port: number;
  security: 'tls' | 'starttls' | 'none';
  username?: string | null;
  password?: string | null;
}

export interface MaddyDomain {
  domain: string;
  selector: string;
  dkimPrivateKeyPem: string;
  /** null = direct delivery. */
  relay: MaddyRelay | null;
}

export interface MaddyUser {
  username: string;
  /** `bcrypt:$2a$…` */
  passwordHash: string;
  /** Allowed sender domains. */
  domains: string[];
}

export interface MaddyRenderInput {
  hostname: string;
  domains: MaddyDomain[];
  users: MaddyUser[];
  suppressed: string[];
  bounceHook: { host: string; port: number; username: string; password: string };
}

export interface MailSecret {
  name: string;
  value: string;
  /** File name under /run/secrets. */
  target: string;
}

export interface MaddyBundle {
  config: MailSecret;
  users: MailSecret;
  senders: MailSecret;
  dkimKeys: MailSecret[];
  /** Everything above — create each before deploying the spec. */
  all: MailSecret[];
  /** Stable digest of the whole render (drift detection). */
  signature: string;
}

const sha8 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 8);

function secret(part: string, target: string, value: string): MailSecret {
  return { name: `${MAIL_SECRET_PREFIX}${part}-${sha8(value)}`, value, target };
}

/** maddy config values: quote anything that is not a bare token; no newlines ever. */
export function q(v: string): string {
  const s = v.replace(/[\r\n]/g, '');
  return /^[A-Za-z0-9_.:@/+-]+$/.test(s) ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Identifier-safe route name for a relay (`relay_<sha8 of host:port:user>`). */
export function relayRouteName(r: MaddyRelay): string {
  return `relay_${sha8(`${r.host}:${r.port}:${r.username ?? ''}`)}`;
}

/** Targets file names per domain: `/run/secrets/dkim-<domain>-<selector>.key`. */
export function dkimTarget(domain: string, selector: string): string {
  return `dkim-${domain}-${selector}.key`;
}

function relayUrl(r: MaddyRelay): string {
  return `${r.security === 'tls' ? 'tls' : 'tcp'}://${r.host}:${r.port}`;
}

/** Render maddy.conf. Deterministic for equal input (sorted), so the secret name is stable. */
export function renderMaddyConfig(input: MaddyRenderInput): string {
  const domains = [...input.domains].sort((a, b) => a.domain.localeCompare(b.domain));
  const routes = new Map<string, { relay: MaddyRelay | null; domains: MaddyDomain[] }>();
  for (const d of domains) {
    const key = d.relay ? relayRouteName(d.relay) : 'direct';
    const r = routes.get(key) ?? { relay: d.relay, domains: [] };
    r.domains.push(d);
    routes.set(key, r);
  }
  const suppressed = [...new Set(input.suppressed.map((a) => a.toLowerCase()))]
    .filter((a) => /^[^\s@"]+@[^\s@"]+$/.test(a))
    .sort()
    .slice(0, MAX_RENDERED_SUPPRESSIONS);
  const hook = input.bounceHook;
  const L: string[] = [
    '# Rendered by swarmy (email service). Do not edit: the controller re-renders it.',
    'state_dir /data/state',
    'runtime_dir /tmp/maddy',
    `hostname ${q(input.hostname)}`,
    `autogenerated_msg_domain ${q(domains[0]?.domain ?? input.hostname)}`,
    // In-cluster only: submission is reached over the encrypted overlay, never
    // published on a node's public IP.
    'tls off',
    'log stderr',
    '',
    'auth.pass_table swarmy_auth {',
    '    table file /run/secrets/users',
    '}',
    '',
    'table.file swarmy_senders {',
    '    file /run/secrets/senders',
    '}',
    '',
    'target.smtp swarmy_bounce_hook {',
    `    targets tcp://${hook.host}:${hook.port}`,
    '    starttls no',
    `    auth plain ${q(hook.username)} ${q(hook.password)}`,
    '}',
    '',
  ];
  for (const [name, route] of [...routes].sort(([a], [b]) => a.localeCompare(b))) {
    if (route.relay) {
      const r = route.relay;
      L.push(`target.smtp ${name}_target {`, `    targets ${relayUrl(r)}`);
      L.push(`    starttls ${r.security === 'starttls' ? 'yes' : 'no'}`);
      if (r.username && r.password) L.push(`    auth plain ${q(r.username)} ${q(r.password)}`);
      L.push('}', '');
    } else {
      L.push(
        `target.remote ${name}_target {`,
        '    limits {',
        '        destination rate 20 1s',
        '        destination concurrency 10',
        '    }',
        '    mx_auth {',
        '        local_policy {',
        '            min_tls_level none',
        '            min_mx_level none',
        '        }',
        '    }',
        '}',
        '',
      );
    }
    L.push(
      `target.queue ${name}_queue {`,
      `    target &${name}_target`,
      '    max_tries 12',
      '    bounce {',
      '        default_destination {',
      '            deliver_to &swarmy_bounce_hook',
      '        }',
      '    }',
      '}',
      '',
    );
  }
  L.push(
    `submission tcp://0.0.0.0:${SUBMISSION_PORT} {`,
    '    insecure_auth yes',
    '    limits {',
    '        all rate 50 1s',
    '    }',
    '    auth &swarmy_auth',
  );
  for (const [name, route] of [...routes].sort(([a], [b]) => a.localeCompare(b))) {
    L.push(
      `    source ${route.domains.map((d) => q(d.domain)).join(' ')} {`,
      '        check {',
      '            authorize_sender {',
      '                user_to_email &swarmy_senders',
      '            }',
      '        }',
      '        modify {',
      '            dkim {',
      `                domains ${route.domains.map((d) => q(d.domain)).join(' ')}`,
      // One selector per route group; domains in a group share it (default 'swarmy').
      `                selector ${q(route.domains[0]!.selector)}`,
      '                key_path /run/secrets/dkim-{domain}-{selector}.key',
      '            }',
      '        }',
    );
    if (suppressed.length) {
      L.push(`        destination ${suppressed.map(q).join(' ')} {`, '            reject 550 5.1.1 "recipient is on the suppression list"', '        }');
    }
    L.push('        default_destination {', `            deliver_to &${name}_queue`, '        }', '    }');
  }
  L.push('    default_source {', '        reject 501 5.1.8 "sender domain is not set up in swarmy"', '    }', '}', '');
  return L.join('\n');
}

/** The pass table: `user: bcrypt:$2a$…` per line (sorted). */
export function renderUsersTable(users: MaddyUser[]): string {
  return [...users]
    .sort((a, b) => a.username.localeCompare(b.username))
    .map((u) => `${u.username}: ${u.passwordHash}`)
    .join('\n')
    .concat('\n');
}

/** The sender table: one `user: domain` line per allowed domain (maddy reads repeats as a list). */
export function renderSendersTable(users: MaddyUser[]): string {
  const lines: string[] = [];
  for (const u of [...users].sort((a, b) => a.username.localeCompare(b.username))) {
    for (const d of [...new Set(u.domains)].sort()) lines.push(`${u.username}: ${d}`);
  }
  return lines.join('\n').concat('\n');
}

export function maddyBundle(input: MaddyRenderInput): MaddyBundle {
  const conf = renderMaddyConfig(input);
  const config = secret('config', 'maddy.conf', conf);
  const users = secret('users', 'users', renderUsersTable(input.users));
  const senders = secret('senders', 'senders', renderSendersTable(input.users));
  const dkimKeys = [...input.domains]
    .sort((a, b) => a.domain.localeCompare(b.domain))
    .map((d) => secret(`dkim-${d.domain.replace(/[^a-z0-9-]/g, '-')}`, dkimTarget(d.domain, d.selector), d.dkimPrivateKeyPem));
  const all = [config, users, senders, ...dkimKeys];
  return { config, users, senders, dkimKeys, all, signature: sha8(all.map((s) => s.name).join(',')) };
}

/** Swarmy-mail secrets that can go: ours, not kept. */
export function staleMailSecrets(existing: readonly string[], keep: readonly string[]): string[] {
  const k = new Set(keep);
  return existing.filter((n) => n.startsWith(MAIL_SECRET_PREFIX) && !k.has(n));
}

/** bcrypt from Bun/Node libraries is `$2b$`; maddy's Go bcrypt reads `$2a$` (same algorithm). */
export function maddyBcrypt(hash: string): string {
  return `bcrypt:${hash.replace(/^\$2[by]\$/, '$2a$')}`;
}

export function mailServiceSpec(opts: { bundle: MaddyBundle; pinSwarmNodeId?: string }): ServiceSpec {
  return {
    name: MAIL_SERVICE,
    image: MADDY_IMAGE,
    mode: { replicated: { replicas: 1 } },
    labels: {
      'swarmy.managed': 'true',
      'swarmy.component': 'email',
      'swarmy.role': 'mta',
      [STACK_LABEL]: SYSTEM_STACK,
      [SYSTEM_STACK_LABEL]: 'true',
      'swarmy.email.signature': opts.bundle.signature,
      ...(opts.pinSwarmNodeId ? { [MAIL_NODE_LABEL]: opts.pinSwarmNodeId } : {}),
    },
    args: ['-config', CONFIG_PATH, 'run'],
    // The retry queue lives on a node-local volume, so the service is pinned
    // (like ClickHouse) — and the pinned node's public IP is the sending IP
    // SPF publishes on direct delivery.
    mounts: [{ type: 'volume', source: MAIL_DATA_VOLUME, target: '/data' }],
    secrets: opts.bundle.all.map((s) => ({ source: s.name, target: s.target, mode: 0o400 })),
    ...(opts.pinSwarmNodeId ? { placement: { constraints: [`node.id==${opts.pinSwarmNodeId}`] } } : {}),
    // NO published ports: submission is in-cluster only (apps on `swarmy`,
    // the controller on swarmy-control); outbound :25 needs no listener.
    networks: [MAIL_APP_NETWORK, SWARMY_CONTROL_NETWORK],
    resources: { limits: { memoryBytes: 128 * 1024 * 1024 } },
  };
}
