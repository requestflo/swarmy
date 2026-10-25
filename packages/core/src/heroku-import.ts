/**
 * Import from Heroku — the input schemas shared by the dashboard form and
 * the `herokuImport.*` procedures. Two ways in: a Heroku API token plus the
 * app's name (the controller reads the Platform API; the token is used for
 * that one call and never stored), or the app's files pasted in.
 */
import { z } from 'zod';

/** Heroku app names: lower-case letters, digits and dashes, starting with a letter (or the app's UUID). */
export const HEROKU_APP_NAME = /^(?:[a-z][a-z0-9-]{1,29}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export const HerokuImportSource = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('api'),
    /** `heroku auth:token`, or an API key from Account settings. Read once, never stored. */
    token: z.string().trim().min(8, 'paste the whole token').max(512),
    app: z.string().trim().toLowerCase().regex(HEROKU_APP_NAME, 'a Heroku app name like acme-shop'),
  }),
  z.object({
    kind: z.literal('paste'),
    appJson: z.string().max(200_000).default(''),
    procfile: z.string().max(20_000).default(''),
    /** `heroku config -s` (or the table, or `--json`). */
    config: z.string().max(200_000).default(''),
    /** `heroku domains`, or one hostname per line. */
    domains: z.string().max(20_000).default(''),
  }),
]);
export type HerokuImportSource = z.infer<typeof HerokuImportSource>;

/** The swarmy app name (also the stack): swarmy.yaml's `app:` rule. */
const appName = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/, 'lower-case letters, digits and dashes, starting with a letter');

export const HerokuImportPlanInput = z.object({
  source: HerokuImportSource,
  /** Omitted → the Heroku app's name. */
  name: appName.optional(),
});
export type HerokuImportPlanInput = z.infer<typeof HerokuImportPlanInput>;

/** Deploy what swarmy can set up before the code arrives: the data stores and the sealed config. */
export const HerokuImportDeployInput = z.object({
  source: HerokuImportSource,
  stack: appName,
});
export type HerokuImportDeployInput = z.infer<typeof HerokuImportDeployInput>;

/** The one-shot data copy: Heroku's Postgres → the new managed one. `confirm` is `<stack>/<cluster>`. */
export const HerokuImportCopyInput = z.object({
  source: HerokuImportSource,
  stack: appName,
  cluster: z.string().min(1).max(40).regex(/^[a-z][a-z0-9-]*$/, 'invalid database name'),
  confirm: z.string().max(200),
});
export type HerokuImportCopyInput = z.infer<typeof HerokuImportCopyInput>;

/** The phrase the copy asks you to type: `<stack>/<cluster>`. */
export const herokuCopyPhrase = (stack: string, cluster: string): string => `${stack}/${cluster}`;
