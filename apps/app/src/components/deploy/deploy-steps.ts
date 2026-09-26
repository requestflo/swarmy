import type { BlueprintDeployResultView, InvService } from '@swarmy/core';

/**
 * Pure: fold the real signals of a fresh deploy into the five-step tracker
 * (Get the image → Create its data → Start it → HTTPS certificate → Health
 * check). Every state comes from something swarmy actually reads:
 *   - the blueprint's step results (what already ran, what failed),
 *   - the live inventory (the service exists, a container exists = the image
 *     is on the server, replicas running vs desired, the service status),
 *   - the app's routes (`ingress.listDomains`: serving, DNS/certificate state).
 * Nothing is timed or guessed; a step with no signal yet is "waiting".
 */

export type StepState = 'done' | 'working' | 'waiting' | 'skipped' | 'failed' | 'needs';
export type StepKey = 'image' | 'data' | 'start' | 'https' | 'health';

export interface DeployStep {
  key: StepKey;
  title: string;
  /** The plain sub-line under the title. */
  sub: string;
  state: StepState;
  /** The mono Controls line (image ref, service name, replicas, host). */
  tech: string | null;
}

/** The slice of a route (`ingress.listDomains` row) the tracker reads. */
export interface DeployDomain {
  id: string;
  host: string;
  serviceId: string;
  serviceName: string;
  tls: string;
  serving: boolean;
  status?: { state: string; reason: string; certificate: { issuer: string | null; expiresAt: string | null; error: string | null } | null } | null;
}

export interface DeployProgress {
  steps: DeployStep[];
  primary: InvService | null;
  domain: DeployDomain | null;
  /** Every step is done or not needed: it's live. */
  live: boolean;
  /** 1-based index of the step in progress (5 when all done). */
  current: number;
  failed: DeployStep | null;
}

const DATA_KINDS = new Set(['db.provision', 'cache.provision', 'bucket']);
const up = (s: InvService): boolean => s.replicas.desired > 0 && s.replicas.running >= s.replicas.desired;
const short = (stack: string, name: string): string => (name.startsWith(`${stack}_`) ? name.slice(stack.length + 1) : name);
const copies = (s: InvService): string => `replicas ${s.replicas.running}/${s.replicas.desired}`;

/** The service people open: the routed one, else the one with a port, else the first. */
export function primaryService(services: InvService[], domains: DeployDomain[]): InvService | null {
  for (const d of domains) {
    const hit = services.find((s) => s.id === d.serviceId || s.name === d.serviceName);
    if (hit) return hit;
  }
  return services.find((s) => s.ports.length > 0) ?? services[0] ?? null;
}

export function deriveDeploy(x: {
  stack: string;
  result: BlueprintDeployResultView | null;
  services: InvService[];
  domains: DeployDomain[];
}): DeployProgress {
  const { stack, result, services, domains } = x;
  const primary = primaryService(services, domains);
  const domain = domains.find((d) => primary && (d.serviceId === primary.id || d.serviceName === primary.name)) ?? domains[0] ?? null;
  const stepFailed = (kinds: (k: string) => boolean) => result?.steps.find((s) => kinds(s.kind) && s.status === 'failed') ?? null;
  const pName = primary ? short(stack, primary.name) : stack;

  // 1 · Get the image — Docker creates a container only once the image is on the server.
  const deployFail = stepFailed((k) => k === 'stack.deploy');
  const image: DeployStep = {
    key: 'image',
    title: 'Get the image',
    sub: primary ? `Downloads ${primary.image.split('/').pop()}` : 'Downloads what it runs',
    state: deployFail ? 'failed' : !primary ? 'waiting' : primary.containers.length > 0 || primary.replicas.running > 0 ? 'done' : 'working',
    tech: primary?.image ?? null,
  };

  // 2 · Create its data — provisioned stores (blueprint steps) + companion services (its database).
  const dataSteps = (result?.steps ?? []).filter((s) => DATA_KINDS.has(s.kind));
  const companions = services.filter((s) => s !== primary);
  const dataFail = stepFailed((k) => DATA_KINDS.has(k));
  const data: DeployStep = {
    key: 'data',
    title: 'Create its data',
    sub: companions.length ? `Starts ${companions.map((s) => short(stack, s.name)).join(', ')}` : dataSteps.length ? 'Sets up where it keeps data' : 'Nothing to store',
    state: dataFail
      ? 'failed'
      : !dataSteps.length && !companions.length
        ? 'skipped'
        : companions.every(up)
          ? 'done'
          : companions.some((s) => s.containers.length > 0)
            ? 'working'
            : 'waiting',
    tech: [...dataSteps.map((s) => s.label), ...companions.map((s) => `${s.name} · ${copies(s)}`)].join(' · ') || null,
  };

  // 3 · Start it — its copies running vs wanted.
  const start: DeployStep = {
    key: 'start',
    title: `Start ${pName}`,
    sub: primary?.status === 'failing' ? 'It keeps stopping. Its log says why' : 'Runs it on your server',
    state: !primary ? 'waiting' : up(primary) ? 'done' : primary.status === 'failing' ? 'failed' : primary.containers.length > 0 ? 'working' : 'waiting',
    tech: primary ? `${primary.name} · ${copies(primary)}` : null,
  };

  // 4 · HTTPS certificate — the route's DNS/certificate lifecycle.
  const routeFail = stepFailed((k) => k === 'ingress.route');
  const st = domain?.status ?? null;
  const https: DeployStep = {
    key: 'https',
    title: 'HTTPS certificate',
    sub: !domain ? 'No public address' : domain.tls === 'off' ? 'Plain HTTP, no certificate' : st?.state === 'waiting_dns' ? 'Waiting for the address to point here' : 'Gets one from Let’s Encrypt',
    state: routeFail
      ? 'failed'
      : !domain || domain.tls === 'off'
        ? 'skipped'
        : st?.state === 'error' || st?.certificate?.error
          ? 'failed'
          : st?.state === 'active' || (st?.certificate && !st.certificate.error)
            ? 'done'
            : st?.state === 'waiting_dns'
              ? 'needs'
              : st?.state === 'issuing'
                ? 'working'
                : 'waiting',
    tech: domain ? [domain.host, st?.certificate?.issuer].filter(Boolean).join(' · ') : null,
  };

  // 5 · Health check — every part running and the front door serving the address.
  const allUp = services.length > 0 && services.every((s) => s.status === 'running' && up(s));
  const answering = !domain || domain.serving;
  const httpsOk = https.state === 'done' || https.state === 'skipped';
  const health: DeployStep = {
    key: 'health',
    title: 'Health check',
    sub: domain ? 'Every part running and the address answering' : 'Every part running',
    state: services.some((s) => s.status === 'failing') ? 'failed' : allUp && answering && httpsOk ? 'done' : start.state === 'done' ? 'working' : 'waiting',
    tech: `${services.filter(up).length}/${services.length} services running${domain ? ` · edge ${domain.serving ? 'serving' : 'not serving'}` : ''}`,
  };

  const steps = [image, data, start, https, health];
  const settled = (s: DeployStep): boolean => s.state === 'done' || s.state === 'skipped';
  const idx = steps.findIndex((s) => !settled(s));
  return {
    steps,
    primary,
    domain,
    live: idx === -1,
    current: idx === -1 ? steps.length : idx + 1,
    failed: steps.find((s) => s.state === 'failed') ?? null,
  };
}
