/**
 * Controller clients for the harness.
 *
 *  - `Session`: the dashboard's own path — Better Auth cookie + tRPC over HTTP
 *    (superjson envelope `{ json }`). Used for first-admin login, minting the
 *    API key, and the surfaces the public REST API doesn't cover yet
 *    (templates, managed data, backups of databases).
 *  - `rest`: the public REST API through the official TypeScript SDK
 *    (`sdks/typescript`), authenticated with the API key the harness creates.
 *    Everything REST can do goes through here, so the SDK is exercised too.
 */
import { SwarmyClient } from '../../../../sdks/typescript/src/index';
import { redact } from './util';

export class TrpcError extends Error {
  constructor(
    readonly proc: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(`${proc} → HTTP ${status}: ${redact(body).slice(0, 600)}`);
  }
  /** tRPC's "No procedure found" — the feature isn't in this build. */
  get missingProcedure() {
    return this.status === 404 && /No procedure found|NOT_FOUND/.test(this.body) && /procedure/i.test(this.body);
  }
}

export class Session {
  private cookies = new Map<string, string>();
  constructor(
    readonly baseUrl: string,
    readonly origin: string = baseUrl,
  ) {}

  private cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  private absorb(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair!.indexOf('=');
      if (i > 0) this.cookies.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
  }

  async fetch(path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('origin', this.origin);
    if (this.cookies.size) headers.set('cookie', this.cookieHeader());
    const res = await fetch(this.baseUrl + path, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
    this.absorb(res);
    return res;
  }

  async signIn(email: string, password: string) {
    this.cookies.clear();
    const res = await this.fetch('/api/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.text();
    if (res.status !== 200) throw new Error(`sign-in → HTTP ${res.status}: ${redact(body).slice(0, 300)}`);
    if (![...this.cookies.keys()].some((k) => k.includes('swarmy'))) throw new Error('sign-in set no swarmy.* session cookie');
  }

  async query<T = any>(proc: string, input?: unknown, timeoutMs?: number): Promise<T> {
    const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
    const res = await this.fetch(`/api/trpc/${proc}${qs}`, {}, timeoutMs);
    return this.unwrap<T>(proc, res);
  }

  async mutate<T = any>(proc: string, input?: unknown, timeoutMs?: number): Promise<T> {
    const res = await this.fetch(
      `/api/trpc/${proc}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ json: input ?? null }) },
      timeoutMs,
    );
    return this.unwrap<T>(proc, res);
  }

  private async unwrap<T>(proc: string, res: Response): Promise<T> {
    const text = await res.text();
    if (res.status !== 200) throw new TrpcError(proc, res.status, text);
    const parsed = JSON.parse(text);
    return parsed?.result?.data?.json as T;
  }

  /** True when this build serves `proc` (a 404 "No procedure found" means no). */
  async hasProcedure(proc: string): Promise<boolean> {
    const res = await this.fetch(`/api/trpc/${proc}`, {});
    const text = await res.text();
    return !(res.status === 404 && /No procedure found/i.test(text));
  }
}

export function restClient(baseUrl: string, apiKey: string) {
  return new SwarmyClient({ endpoint: baseUrl, apiKey });
}

/** Raw REST call for endpoints the SDK doesn't wrap yet (backups, api-keys…). */
export async function rest<T = any>(baseUrl: string, apiKey: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${baseUrl}/api/v1${path}`, {
    method,
    headers: {
      authorization: `Bearer ${apiKey}`,
      accept: 'application/json',
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`REST ${method} ${path} → HTTP ${res.status}: ${redact(text).slice(0, 500)}`);
  return (text ? JSON.parse(text) : undefined) as T;
}
