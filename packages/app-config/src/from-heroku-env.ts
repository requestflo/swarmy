/**
 * Heroku config vars (app.json `env` + `heroku config`) → swarmy.yaml's
 * top-level `env:` for {@link fromHeroku}. Pure. Heroku config is app-wide,
 * so it lands in the shared layer every service reads.
 *
 *  - An add-on's variable (DATABASE_URL, REDIS_URL, their colour aliases)
 *    becomes a binding: swarmy fills in the new address, Heroku's stays behind.
 *  - A secret-looking value (`looksSecret`, the same rule as Paste .env) or a
 *    `generator: "secret"` becomes `${{ secrets.<name> }}`. Its value is
 *    never written: the gap says which swarmy secret to create.
 *  - Heroku's own metadata (HEROKU_SLUG_COMMIT, …) and PORT are dropped.
 */
import { looksSecret } from '@swarmy/core';
import { secretNameFor } from './from-compose-env';
import type { HerokuGap } from './from-heroku-addons';
import type { HerokuEnvSpec } from './from-heroku-read';

export interface HerokuSecret {
  /** The config var (`STRIPE_SECRET_KEY`). */
  key: string;
  /** The swarmy secret the file reads (`stripe-secret-key`). */
  name: string;
}

export interface EnvConversion {
  env: Record<string, string>;
  secrets: HerokuSecret[];
  changes: string[];
  gaps: HerokuGap[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const METADATA = /^HEROKU_(APP_ID|APP_DEFAULT_DOMAIN_NAME|RELEASE_VERSION|RELEASE_CREATED_AT|SLUG_COMMIT|SLUG_DESCRIPTION|DYNO_ID|BRANCH|PR_NUMBER|TEST_RUN_[A-Z_]+)$/;
const BUILD_ONLY = /^(BUILDPACK_URL|NODE_MODULES_CACHE|NPM_CONFIG_[A-Z_]+|YARN_PRODUCTION|USE_NPM_INSTALL|DISABLE_COLLECTSTATIC)$/;

export interface EnvInput {
  spec: Record<string, HerokuEnvSpec>;
  config: Record<string, string>;
  /** Add-on variables → their binding. */
  bindings: Record<string, string>;
  /** Colour aliases (`HEROKU_POSTGRESQL_RED_URL`) → the binding they alias. */
  aliases: Array<[RegExp, string]>;
}

export function convertEnv(input: EnvInput): EnvConversion {
  const { spec, config } = input;
  const c: EnvConversion = { env: {}, secrets: [], changes: [], gaps: [] };
  const keys = [...new Set([...Object.keys(input.bindings), ...Object.keys(spec), ...Object.keys(config)])];
  for (const k of keys) {
    const key = k in config ? `config.${k}` : `env.${k}`;
    const gap = (reason: string, handled = false): void => {
      c.gaps.push({ key, reason, ...(handled ? { handled: true as const } : {}) });
    };
    if (!NAME.test(k)) {
      gap("that isn't a variable name swarmy.yaml accepts");
      continue;
    }
    const addon = input.bindings[k];
    const alias = addon ? undefined : input.aliases.find(([re]) => re.test(k))?.[1];
    if (addon || alias) {
      c.env[k] = (addon ?? alias)!;
      if (alias || k === 'REDIS_TLS_URL') c.changes.push(`${k} binds to ${addon ?? alias} as well — Heroku's value stays behind.`);
      continue;
    }
    if (k === 'PORT') {
      gap('Heroku assigns PORT itself, and swarmy sets it from port:', true);
      continue;
    }
    if (k === 'HEROKU_APP_NAME') {
      c.env[k] = '${{ app.name }}';
      c.changes.push("HEROKU_APP_NAME binds to ${{ app.name }}, the swarmy app's own name.");
      continue;
    }
    if (METADATA.test(k)) {
      gap("Heroku's dyno metadata: swarmy doesn't set it (the app's name is ${{ app.name }})", true);
      continue;
    }
    if (BUILD_ONLY.test(k)) {
      gap('a buildpack setting: Railpack builds without it (build.install / build.env change the build)', true);
      continue;
    }
    const s = spec[k];
    const value = config[k] ?? s?.value;
    const has = value !== undefined && value !== '';
    if (!has && !s?.generated) {
      if (s?.required) gap('app.json requires it but gives no value: set it under env:, or as a swarmy secret if it is one');
      continue;
    }
    if (s?.generated || looksSecret(k, value ?? '')) {
      const name = secretNameFor(k);
      c.env[k] = `\${{ secrets.${name} }}`;
      c.secrets.push({ key: k, name });
      gap(
        s?.generated && !has
          ? `Heroku generated it when the app was made: create the swarmy secret ${name} with its value from heroku config (the file reads \${{ secrets.${name} }})`
          : `its value looks like a secret, so it stays out of a file headed for git: create the swarmy secret ${name} with it (the file reads \${{ secrets.${name} }})`,
      );
      continue;
    }
    c.env[k] = value!.replace(/\$\{\{/g, '$$${{');
  }
  return c;
}
