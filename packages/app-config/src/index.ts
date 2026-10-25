/**
 * @swarmy/app-config — swarmy.yaml v1: schema, parser, validator, and the pure
 * planner (yaml → DesiredApp → diff vs a LiveApp snapshot → ordered, gated
 * plan). No IO; the controller fetches the file and reads live state, this
 * package decides. See plans/epic-git-apps.md.
 */
export * from './units';
export * from './schema';
export * from './auth';
export * from './issues';
export * from './bindings';
export * from './validate';
export * from './hash';
export * from './environments';
export * from './env-layers';
export * from './clone-env';
export * from './own-secrets';
export * from './branches';
export * from './desired';
export * from './plan';
export * from './parse';
export * from './ai';
export * from './email';
export * from './from-compose';
export * from './from-heroku';
export * from './from-heroku-steps';
export * from './from-heroku-api';
export * from './from-heroku-plan';
export { readHerokuDomains } from './from-heroku-domains';
export { DYNO_SIZES, dynoSize, type DynoLimits } from './from-heroku-dyno';
export { SWARMY_YAML_JSON_SCHEMA } from './json-schema';
export { MINIMAL_EXAMPLE, FULL_EXAMPLE } from './examples';
export * from './scan';
