/**
 * `email:` in swarmy.yaml — the app sends mail through swarmy's email service
 * (the in-cluster MTA + the HTTP send API) instead of holding provider creds.
 *
 *   email: true                         # from noreply@<the org's sending domain>
 *   email:
 *     from: noreply@shop.example.com    # a verified sending domain
 *     services: [web, worker]           # default: every service
 *
 * Each bound service gets, on deploy:
 *   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_FROM, EMAIL_FROM, EMAIL_API_URL  (env)
 *   SMTP_PASS, EMAIL_API_KEY  (secret variables: Docker secrets exported by
 *                              the swarmy env shim, never in the spec)
 * — one credential per app, minted on first deploy. Apps whose settings use
 * other names bind fields explicitly: `MAIL_PASSWORD: ${{ email.password }}`
 * (fields: host, port, user, password, from, api_url, api_key). The
 * controller wires it on deploy (the `email` attachment).
 */
import { z } from 'zod';
import { issue, type ConfigIssue } from './issues';
import type { AppConfig } from './schema';

const address = z
  .string()
  .trim()
  .max(254)
  .regex(/^[^\s@<>]+@([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i, 'an address like noreply@example.com');

export const EmailObjectSchema = z
  .object({
    /** Sender address; its domain must be a verified sending domain. Default noreply@<org sending domain>. */
    from: address.optional(),
    services: z.array(z.string().min(1)).nonempty().optional(),
  })
  .strict();
export const EmailSchema = z.union([z.literal(true), EmailObjectSchema]);
export type EmailInput = z.input<typeof EmailSchema>;

/** Binding fields under `${{ email.<field> }}`. */
export const EMAIL_BINDING_FIELDS = ['host', 'port', 'user', 'password', 'from', 'api_url', 'api_key'] as const;
export type EmailBindingField = (typeof EMAIL_BINDING_FIELDS)[number];
/** Fields that carry a credential (delivered as secret variables). */
export const EMAIL_CREDENTIAL_FIELDS: readonly EmailBindingField[] = ['password', 'api_key'];

/** What `email:` binds automatically: env name → field. */
export const EMAIL_AUTO_ENV: Readonly<Record<string, EmailBindingField>> = {
  SMTP_HOST: 'host',
  SMTP_PORT: 'port',
  SMTP_USER: 'user',
  SMTP_PASS: 'password',
  SMTP_FROM: 'from',
  EMAIL_FROM: 'from',
  EMAIL_API_URL: 'api_url',
  EMAIL_API_KEY: 'api_key',
};

export interface DesiredEmail {
  /** null = the org's default sending domain (noreply@…). */
  from: string | null;
  /** Services bound by default (sorted). */
  services: string[];
}

export function toDesiredEmail(cfg: AppConfig, serviceNames: readonly string[]): DesiredEmail | undefined {
  const e = cfg.email;
  if (!e) return undefined;
  const o = e === true ? {} : e;
  return {
    from: o.from?.toLowerCase() ?? null,
    services: [...(o.services ?? serviceNames)].filter((s) => serviceNames.includes(s)).sort(),
  };
}

/** `${{ email.x }}` as a whole env value → its field, else null. */
export function wholeEmailBinding(value: string): EmailBindingField | null {
  const m = /^\s*\$\{\{\s*email\.([a-z_]+)\s*\}\}\s*$/.exec(value);
  return m && (EMAIL_BINDING_FIELDS as readonly string[]).includes(m[1]!) ? (m[1] as EmailBindingField) : null;
}

/**
 * A service's email binding: the auto env (when it is in `email.services`)
 * plus any explicit `${{ email.* }}` env values. Explicit names win; a key the
 * service already sets to a plain value is left alone.
 */
export function emailEnvFor(
  desired: DesiredEmail | undefined,
  service: string,
  env: Readonly<Record<string, string>>,
): Record<string, EmailBindingField> | null {
  if (!desired) return null;
  const out: Record<string, EmailBindingField> = {};
  if (desired.services.includes(service)) {
    for (const [k, f] of Object.entries(EMAIL_AUTO_ENV)) if (!(k in env)) out[k] = f;
  }
  for (const [k, v] of Object.entries(env)) {
    const f = wholeEmailBinding(v);
    if (f) out[k] = f;
  }
  return Object.keys(out).length ? out : null;
}

export function validateEmail(cfg: AppConfig): ConfigIssue[] {
  const e = cfg.email;
  const out: ConfigIssue[] = [];
  const names = Object.keys(cfg.services);
  if (e && e !== true) {
    for (const [i, s] of (e.services ?? []).entries()) {
      if (!names.includes(s)) out.push(issue('error', 'email/unknown-service', ['email', 'services', i], `"${s}" is not a service of this app`));
    }
  }
  // Embedded email bindings can't be delivered (credentials never enter a string).
  const scan = (env: Record<string, string | number | boolean> | undefined, base: (string | number)[]) => {
    for (const [k, v] of Object.entries(env ?? {})) {
      if (typeof v !== 'string' || !/\$\{\{\s*email\./.test(v)) continue;
      if (!e) {
        out.push(issue('error', 'email/not-enabled', [...base, k], 'add email: to swarmy.yaml to use ${{ email.* }}'));
      } else if (!wholeEmailBinding(v)) {
        out.push(issue('error', 'email/embedded', [...base, k], `give the email field its own variable: ${k}: \${{ email.<field> }} (${EMAIL_BINDING_FIELDS.join(', ')})`));
      }
    }
  };
  scan(cfg.env, ['env']);
  for (const [n, s] of Object.entries(cfg.services)) scan(s.env, ['services', n, 'env']);
  return out;
}
