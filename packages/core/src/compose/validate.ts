import type { ServiceModelOut } from './model';
import type { TranslationWarning } from './warnings';

/**
 * Semantic validation of a canonical ServiceModel — the rules that the Zod
 * shape alone can't express (cross-field constraints). PURE. Drives the live
 * validation panel in the builder; deploy is also gated on the absence of
 * `warn`/`lossy`-but-blocking entries (the UI decides). Returns `info` for
 * advisories and `warn` for things that will likely misbehave on Swarm.
 *
 * See plans/epic-stack-gui-builder.md "Validation".
 */
export function validateModel(model: ServiceModelOut): TranslationWarning[] {
  const out: TranslationWarning[] = [];
  const name = model.name || '(unnamed)';

  if (!model.name) {
    out.push({ level: 'warn', path: `${name}`, code: 'name-required', message: 'A service name is required.' });
  }
  if (!model.image) {
    out.push({ level: 'warn', path: `${name}.image`, code: 'image-required', message: 'An image is required to deploy.' });
  }

  if (model.mode === 'replicated' && model.replicas === 0) {
    out.push({
      level: 'info',
      path: `${name}.replicas`,
      code: 'zero-replicas',
      message: 'Replicas is 0 — the service will be created but run no tasks.',
    });
  }
  if (model.mode === 'global' && model.placement?.maxReplicasPerNode != null) {
    out.push({
      level: 'warn',
      path: `${name}.placement.maxReplicasPerNode`,
      code: 'global-max-replicas',
      message: 'maxReplicasPerNode has no effect in global mode.',
    });
  }

  // Healthcheck cross-field rules.
  const hc = model.healthcheck;
  if (hc && !hc.disable) {
    if (hc.test.length === 0) {
      out.push({
        level: 'warn',
        path: `${name}.healthcheck.test`,
        code: 'healthcheck-no-test',
        message: 'Healthcheck has no test command — it will be ignored.',
      });
    }
    if (hc.intervalNs != null && hc.timeoutNs != null && hc.timeoutNs > hc.intervalNs) {
      out.push({
        level: 'warn',
        path: `${name}.healthcheck.timeout`,
        code: 'healthcheck-timeout-gt-interval',
        message: 'Healthcheck timeout exceeds interval — probes may overlap.',
      });
    }
  }

  // Resources sanity.
  const lim = model.resources?.limits;
  const res = model.resources?.reservations;
  if (lim && res) {
    if (lim.cpus != null && res.cpus != null && res.cpus > lim.cpus) {
      out.push({
        level: 'warn',
        path: `${name}.resources`,
        code: 'reservation-gt-limit',
        message: 'CPU reservation exceeds the limit — Swarm will reject the spec.',
      });
    }
    if (lim.memoryBytes != null && res.memoryBytes != null && res.memoryBytes > lim.memoryBytes) {
      out.push({
        level: 'warn',
        path: `${name}.resources`,
        code: 'reservation-gt-limit',
        message: 'Memory reservation exceeds the limit — Swarm will reject the spec.',
      });
    }
  }

  // Ports: ingress mode without a published port is reachable only inside the mesh.
  for (const [i, p] of model.ports.entries()) {
    if (p.mode === 'ingress' && p.published == null) {
      out.push({
        level: 'info',
        path: `${name}.ports[${i}]`,
        code: 'no-published-port',
        message: `Port ${p.target} has no published port — not reachable from outside the cluster.`,
      });
    }
  }

  return out;
}
