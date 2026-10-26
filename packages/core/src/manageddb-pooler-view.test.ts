import { describe, expect, it } from 'bun:test';
import { parseShowPools } from './manageddb-pooler-view';

const HEADER =
  'database|user|cl_active|cl_waiting|cl_active_cancel_req|cl_waiting_cancel_req|sv_active|sv_active_cancel|sv_being_canceled|sv_idle|sv_used|sv_tested|sv_login|maxwait|maxwait_us|pool_mode|load_balance_hosts';

describe("parseShowPools (the pooler's live numbers)", () => {
  it('sums the app pools and leaves out the admin console and the auth role', () => {
    const out = [
      HEADER,
      'app|postgres|7|2|0|0|5|0|0|3|0|0|0|0|0|transaction|',
      'reports|postgres|1|0|0|0|1|0|0|0|0|0|0|0|0|transaction|',
      'postgres|swarmy_pooler|0|0|0|0|0|0|0|1|0|0|0|0|0|transaction|',
      'pgbouncer|pgbouncer|1|0|0|0|0|0|0|0|0|0|0|0|0|statement|',
    ].join('\n');
    expect(parseShowPools(out)).toEqual({ clientsActive: 8, clientsWaiting: 2, serversActive: 6, serversIdle: 3, pools: 2 });
  });

  it('reads columns by name, so a version that adds or moves one still parses; anything else is null', () => {
    expect(parseShowPools('user|database|sv_idle|cl_waiting|cl_active|sv_active\npostgres|app|4|0|3|2')).toEqual({
      clientsActive: 3,
      clientsWaiting: 0,
      serversActive: 2,
      serversIdle: 4,
      pools: 1,
    });
    expect(parseShowPools('')).toBeNull();
    expect(parseShowPools('psql: error: connection to server failed')).toBeNull();
  });
});
