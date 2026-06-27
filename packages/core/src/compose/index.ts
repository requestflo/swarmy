/**
 * `@swarmy/core/compose` — the canonical, browser-safe service model and the
 * two-way translation layer: compose object <-> ServiceModel <-> wire
 * ServiceSpec. All PURE (no `node:*`, no I/O); YAML string <-> object happens in
 * the caller (the controller has the `yaml` lib).
 *
 * See plans/epic-stack-gui-builder.md.
 */
export {
  ServiceModel,
  ModelPort,
  ModelMount,
  ModelRestartPolicy,
  ModelPlacement,
  type ServiceModelOut,
} from './model';
export {
  composeToModels,
  type ComposeFile,
  type FromComposeResult,
} from './from-compose';
export {
  modelsToCompose,
  modelToComposeService,
  type ComposeFileOut,
  type ComposeServiceOut,
} from './to-compose';
export {
  modelToServiceSpec,
  type ServiceSpecLike,
  type ServiceSpecPlacement,
} from './to-spec';
export {
  type TranslationWarning,
  type WarningLevel,
  SWARM_INCOMPATIBLE_KEYS,
} from './warnings';
