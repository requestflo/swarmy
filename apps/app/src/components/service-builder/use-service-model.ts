import * as React from 'react';
import type { ServiceModelOut } from '@swarmy/core/compose';

/** A blank canonical model — Swarm defaults everywhere. */
export function emptyServiceModel(): ServiceModelOut {
  return {
    name: '',
    image: '',
    mode: 'replicated',
    replicas: 1,
    env: {},
    command: [],
    args: [],
    ports: [],
    mounts: [],
    networks: [],
    labels: {},
    restart: undefined,
    placement: undefined,
    unsupported: {},
  };
}

export interface ServiceModelState {
  model: ServiceModelOut;
  set: <K extends keyof ServiceModelOut>(key: K, value: ServiceModelOut[K]) => void;
  replace: (model: ServiceModelOut) => void;
}

/** Local state for the canonical ServiceModel driving the builder. */
export function useServiceModel(initial?: ServiceModelOut): ServiceModelState {
  const [model, setModel] = React.useState<ServiceModelOut>(initial ?? emptyServiceModel());
  const set = React.useCallback(
    <K extends keyof ServiceModelOut>(key: K, value: ServiceModelOut[K]) => {
      setModel((m) => ({ ...m, [key]: value }));
    },
    [],
  );
  const replace = React.useCallback((next: ServiceModelOut) => setModel(next), []);
  return { model, set, replace };
}
