/**
 * Deploy-time half of the `swarmy-integrations` overlay (the reconcile in
 * `integrations-network.ts` is the authority on membership).
 *
 * A compose (re)deploy rebuilds every spec from compose, and compose may not
 * declare `swarmy-integrations` — so an Ollama/vLLM template redeploy used to
 * drop the engine off the overlay. The AI gateway then answered 502 until the
 * next reconcile tick, and the engine took a second rolling update (a model
 * reload) when the reconcile put it back. This keeps it on the overlay in the
 * same update, and puts a newly deployed engine the gateway will register on
 * it straight away.
 *
 * Scope stays as narrow as the reconcile's: only a service swarmy already
 * attached, or the in-cluster engine discovery picks (first per kind, by
 * name — the same `discoverInClusterModels` the gateway uses). An ordinary
 * app is never attached here.
 */
import { discoverInClusterModels, SWARMY_INTEGRATIONS_NETWORK } from '@swarmy/core';

interface DeploySpec {
  name: string;
  image: string;
  labels?: Record<string, string>;
  networks?: string[];
}

interface LiveService {
  name: string;
  image: string;
  labels: Record<string, string>;
  networks?: ReadonlyArray<{ name: string }>;
}

/**
 * PURE — the in-cluster engines the gateway will register once `specs` are
 * live: the deployed specs replace their same-named live services.
 */
export function enginesAfterDeploy(specs: readonly DeploySpec[], live: readonly LiveService[]): Set<string> {
  const deploying = new Set(specs.map((s) => s.name));
  const after = [
    ...live.filter((s) => !deploying.has(s.name)).map((s) => ({ name: s.name, image: s.image, labels: s.labels })),
    ...specs.map((s) => ({ name: s.name, image: s.image, labels: s.labels ?? {} })),
  ];
  return new Set(discoverInClusterModels(after).map((f) => f.service));
}

/**
 * PURE — `specs` with `swarmy-integrations` added where the live service is
 * already on it (swarmy put it there) or the spec is a registered engine.
 * Every other spec is returned as is (same object).
 */
export function carryIntegrationsNetwork<T extends DeploySpec>(specs: readonly T[], live: readonly LiveService[]): T[] {
  const engines = enginesAfterDeploy(specs, live);
  const onOverlay = new Set(
    live.filter((s) => s.networks?.some((n) => n.name === SWARMY_INTEGRATIONS_NETWORK)).map((s) => s.name),
  );
  return specs.map((spec) => {
    if (!onOverlay.has(spec.name) && !engines.has(spec.name)) return spec;
    if (spec.networks?.includes(SWARMY_INTEGRATIONS_NETWORK)) return spec;
    return { ...spec, networks: [...(spec.networks ?? []), SWARMY_INTEGRATIONS_NETWORK] };
  });
}
