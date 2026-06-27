import { SwarmyApiError } from './error.js';
import type { Problem } from './models.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SwarmyClientOptions {
  /** Base endpoint of the swarmy controller, e.g. `https://swarm.example.com`. */
  endpoint: string;
  /** API key, e.g. `swk_…`. Sent as `Authorization: Bearer <apiKey>`. */
  apiKey: string;
  /** Override the fetch implementation (defaults to global `fetch`). */
  fetch?: FetchLike;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

const API_PREFIX = '/api/v1';

/**
 * Thin transport over `fetch`. Handles base-URL joining, bearer auth,
 * JSON encoding, and RFC 9457 error mapping. Resource groups build on top.
 */
export class HttpTransport {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly extraHeaders: Record<string, string>;

  constructor(opts: SwarmyClientOptions) {
    if (!opts.endpoint) throw new Error('SwarmyClient: `endpoint` is required');
    if (!opts.apiKey) throw new Error('SwarmyClient: `apiKey` is required');
    // Strip trailing slash, then append the versioned API prefix.
    const trimmed = opts.endpoint.replace(/\/+$/, '');
    this.base = trimmed.endsWith(API_PREFIX) ? trimmed : trimmed + API_PREFIX;
    this.apiKey = opts.apiKey;
    const f = opts.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (!f) throw new Error('SwarmyClient: no fetch implementation available; pass `fetch`');
    this.fetchImpl = f;
    this.extraHeaders = opts.headers ?? {};
  }

  /** Build a full URL for a path (e.g. `/services`) with optional query params. */
  buildUrl(path: string, query?: Record<string, string | number | undefined>): string {
    let url = this.base + path;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v !== undefined) params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += '?' + qs;
    }
    return url;
  }

  async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string | number | undefined>; body?: unknown } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      Accept: 'application/json, application/problem+json',
      ...this.extraHeaders,
    };
    const init: RequestInit = { method, headers };
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opts.body);
    }

    const res = await this.fetchImpl(this.buildUrl(path, opts.query), init);

    if (!res.ok) {
      let problem: Problem;
      try {
        problem = (await res.json()) as Problem;
      } catch {
        problem = { type: 'about:blank', title: res.statusText || 'Error', status: res.status };
      }
      throw new SwarmyApiError(res.status, problem);
    }

    // 204 / empty body.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}
