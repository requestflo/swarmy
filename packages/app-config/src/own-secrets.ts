/**
 * An environment's OWN secret family wins over the shared one (Clone as a
 * new environment → adoption). A cloned environment never copies secrets: it
 * fills its own families, `<x>.<env>` (clone-env.ts). Once swarmy.yaml names
 * that environment, its services read `x` again — and without this rule they
 * would silently switch to the shared org secret on the next deploy.
 *
 * So for any named environment (never production, a preview or a dashboard
 * environment, whose secrets are slots), every secret `x` a service reads is
 * read from `<x>.<env>` when that family EXISTS — mounted where the app
 * already reads it (/run/secrets/x, or $VAR). Which families exist is Docker
 * truth the controller passes in; this module is PURE. The choice is part of
 * the service's signature, so a family appearing later redeploys onto it.
 */
import { extractBindings } from './bindings';
import { envSecretFamily } from './clone-env';
import type { DesiredApp, DesiredService } from './desired';
import { PRODUCTION } from './environments';
import { signature } from './hash';

/** Every secret a service reads: `secrets: [x]` and `${{ secrets.x }}` in its env. */
export function secretsRead(s: DesiredService): string[] {
  const out = new Set(s.secrets);
  for (const v of Object.values(s.env))
    for (const b of extractBindings(v)) if (b.ref?.ns === 'secret') out.add(b.ref.name);
  return [...out].sort();
}

const ownsSecrets = (d: DesiredApp): boolean =>
  d.environment !== PRODUCTION && d.environment !== 'preview' && !d.preview && !d.dashboard;

/** The per-environment families worth looking for (none for production, previews, dashboard envs). */
export function ownSecretCandidates(d: DesiredApp): string[] {
  if (!ownsSecrets(d)) return [];
  return [...new Set(d.services.flatMap((s) => secretsRead(s).map((x) => envSecretFamily(x, d.environment))))].sort();
}

/** PURE — read each secret from this environment's own family wherever one exists. */
export function withOwnSecrets(d: DesiredApp, existing: ReadonlySet<string>): DesiredApp {
  if (!ownsSecrets(d)) return d;
  let changed = false;
  const services = d.services.map((s) => {
    const own = Object.fromEntries(
      secretsRead(s)
        .map((x) => [x, envSecretFamily(x, d.environment)] as const)
        .filter(([, family]) => existing.has(family)),
    );
    if (!Object.keys(own).length) return s;
    changed = true;
    const { sig: _sig, ...unit } = { ...s, ownSecrets: own };
    return { ...unit, sig: signature(unit) };
  });
  return changed ? { ...d, services } : d;
}
