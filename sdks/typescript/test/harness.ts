import { describe, expect, it } from 'bun:test';
import { SwarmyClient } from '../src/index.js';
import type { FetchLike } from '../src/index.js';

/** The base every case's URL starts with. */
export const B = 'http://x/api/v1';
export const list = (data: unknown[]) => ({ data, next_cursor: null });

export interface Case {
  /** The method under test, as `resource.method`. */
  name: string;
  call: (c: SwarmyClient) => Promise<unknown>;
  response: unknown;
  status?: number;
  /** `METHOD URL` the call must send. */
  request: string;
  /** The JSON body it must send (omitted = no body). */
  body?: unknown;
  /** One decoded field of the response. */
  check: (out: any) => unknown;
  want: unknown;
}

/** One test per case: a client whose fetch records the call and answers `response`. */
export function runCases(title: string, cases: Case[]): void {
  describe(title, () => {
    for (const t of cases) {
      it(t.name, async () => {
        const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
        const fetch: FetchLike = async (url, init) => {
          calls.push({ url, init });
          return new Response(JSON.stringify(t.response), {
            status: t.status ?? 200,
            headers: { 'Content-Type': 'application/json' },
          });
        };
        const out = await t.call(new SwarmyClient({ endpoint: 'http://x', apiKey: 'swk_y', fetch }));
        expect(calls).toHaveLength(1);
        expect(`${calls[0]!.init!.method} ${calls[0]!.url}`).toBe(t.request);
        const sent = calls[0]!.init!.body;
        if (t.body === undefined) expect(sent).toBeUndefined();
        else expect(JSON.parse(sent as string)).toEqual(t.body);
        expect(t.check(out)).toEqual(t.want);
      });
    }
  });
}
