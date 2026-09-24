/**
 * Email service client — `POST <controller>/email/v1/send` with an app's
 * email API key (`EMAIL_API_KEY`, `sem_…`), bound automatically by
 * swarmy.yaml `email:`. Separate from `SwarmyClient`: it authenticates as the
 * APP (its own sending credential), not as an operator API key.
 *
 * ```ts
 * import { SwarmyEmail } from '@swarmy/sdk';
 * const email = SwarmyEmail.fromEnv(); // EMAIL_API_URL + EMAIL_API_KEY
 * await email.send({ from: 'noreply@shop.example.com', to: 'ada@example.com', template: 'welcome', variables: { name: 'Ada' } });
 * ```
 */
import type { FetchLike } from './http.js';

export interface SendEmailInput {
  /** `noreply@<verified domain>` or `Name <noreply@…>`. */
  from: string;
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  subject?: string;
  text?: string;
  html?: string;
  /** A template saved on the Email page; `{{ var }}` placeholders filled from `variables`. */
  template?: string;
  variables?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface SendEmailResult {
  /** RFC 5322 Message-ID (`<…@domain>`). */
  id: string;
  accepted: string[];
  /** Skipped: on the suppression list (bounced / complained / added by hand). */
  suppressed: string[];
  rejected: Array<{ address: string; reason: string }>;
}

export class SwarmyEmailError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'SwarmyEmailError';
  }
}

export interface SwarmyEmailOptions {
  /** `EMAIL_API_URL`, e.g. `https://swarm.example.com/email/v1`. */
  apiUrl: string;
  /** `EMAIL_API_KEY` (`sem_…`). */
  apiKey: string;
  fetch?: FetchLike;
}

export class SwarmyEmail {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: SwarmyEmailOptions) {
    if (!opts.apiUrl) throw new Error('SwarmyEmail: `apiUrl` is required (EMAIL_API_URL)');
    if (!opts.apiKey) throw new Error('SwarmyEmail: `apiKey` is required (EMAIL_API_KEY)');
    this.base = opts.apiUrl.replace(/\/+$/, '');
    this.apiKey = opts.apiKey;
    const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error('SwarmyEmail: no fetch implementation available; pass `fetch`');
    this.fetchImpl = f;
  }

  /** Read EMAIL_API_URL / EMAIL_API_KEY (what swarmy.yaml `email:` binds). */
  static fromEnv(env: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}): SwarmyEmail {
    return new SwarmyEmail({ apiUrl: env.EMAIL_API_URL ?? '', apiKey: env.EMAIL_API_KEY ?? '' });
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const res = await this.fetchImpl(`${this.base}/send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(input),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    if (!res.ok) {
      const err = (body as { error?: { code?: string; message?: string } & Record<string, unknown> } | null)?.error;
      const { code, message, ...details } = err ?? {};
      throw new SwarmyEmailError(res.status, code ?? 'http_error', message ?? `email send failed (${res.status})`, details);
    }
    return body as SendEmailResult;
  }
}
