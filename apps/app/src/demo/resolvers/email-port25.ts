import type { DemoStore, DomainResolvers } from '../types';

/**
 * Demo resolvers for board 66's per-server port-25 test (`email.port25Servers`
 * / `email.testPort25Servers`, shape `ServerPort25View` in
 * packages/trpc/src/services/email/port25-servers.ts). Until the first test
 * every server says why it has no result; a test answers the way a mixed
 * estate does: the managers open, one worker on a cloud that drops port 25,
 * one behind a firewall that refuses it, and wkr-2's old agent can't run it.
 */

interface Row {
  nodeId: string;
  name: string;
  state: string;
  words: string;
  target: string | null;
  ms: number | null;
  at: number | null;
}

const TARGET = 'gmail-smtp-in.l.google.com:25';
const KEY = 'emailPort25';

const OUTCOME: Record<string, Pick<Row, 'state' | 'words' | 'ms'>> = {
  'mgr-1': { state: 'open', words: 'Port 25 is open: this server can deliver mail directly.', ms: 38 },
  'mgr-2': { state: 'open', words: 'Port 25 is open: this server can deliver mail directly.', ms: 41 },
  'wkr-1': { state: 'timeout', words: 'Nothing answered on port 25 within 5 s. Providers that block mail drop it silently like this; use a relay.', ms: 5000 },
  'wkr-3': { state: 'blocked', words: 'Your provider blocks outbound mail on this server; use a relay.', ms: 12 },
};

function untested(s: DemoStore): Row[] {
  return s.nodes.map((n) => ({
    nodeId: n.id,
    name: n.name,
    ...(n.status === 'offline'
      ? { state: 'offline', words: 'Offline, so it can’t be tested.' }
      : n.agentRestart === false
        ? { state: 'unsupported', words: 'Its agent is too old to run the test; update it first.' }
        : { state: 'untested', words: 'Not tested yet.' }),
    target: null,
    ms: null,
    at: null,
  }));
}

export const emailPort25: DomainResolvers = {
  handlers: {
    'email.port25Servers': (_i, s) => (s.extra[KEY] as Row[] | undefined) ?? untested(s),
    'email.testPort25Servers': (_i, s) => {
      const rows = untested(s).map((r) => {
        const o = r.state === 'untested' ? OUTCOME[r.name] : undefined;
        return o ? { ...r, ...o, target: TARGET, at: Date.now() } : r;
      });
      s.extra[KEY] = rows;
      return rows;
    },
  },
};
