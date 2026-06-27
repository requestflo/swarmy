import * as React from 'react';
import { validateModel, type ServiceModelOut, type TranslationWarning } from '@swarmy/core/compose';

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
    healthcheck: undefined,
    resources: undefined,
    configs: [],
    secrets: [],
    ulimits: [],
    logging: undefined,
    dependsOn: [],
    stopGracePeriodNs: undefined,
    unsupported: {},
  };
}

export interface ServiceModelState {
  model: ServiceModelOut;
  set: <K extends keyof ServiceModelOut>(key: K, value: ServiceModelOut[K]) => void;
  replace: (model: ServiceModelOut) => void;
  /** Live semantic validation (cross-field rules) for the panel + deploy gate. */
  warnings: TranslationWarning[];
  /** True when the model is missing a name or image (deploy is disabled). */
  hasBlockingError: boolean;
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
  const warnings = React.useMemo(() => validateModel(model), [model]);
  const hasBlockingError = !model.name || !model.image;
  return { model, set, replace, warnings, hasBlockingError };
}
