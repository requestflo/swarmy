/**
 * App scenarios: catalog templates behind the Caddy edge, a compose app with a
 * secret variable, and container-to-container DNS across nodes.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../context';
import { REPO_ROOT } from '../lib/cluster';
import { assert, log, poll, run, secret } from '../lib/util';

const dashed = (ip: string) => ip.replace(/\./g, '-');

/** Turn Caddy on (a fresh `--ingress none` install has no edge yet). */
async function ensureEdge(ctx: Ctx) {
  await ctx.m('ingress.setDriver', { driver: 'caddy' });
  await ctx.m('ingress.setEnabled', { enabled: true });
  await ctx.m('ingress.ensureController', undefined);
  await poll(
    'swarmy-ingress-caddy running',
    async () => /\b1\/1\b/.test(await ctx.docker(`service ls --filter name=swarmy-ingress-caddy --format '{{.Replicas}}'`)),
    { timeoutMs: 5 * 60_000, intervalMs: 5000 },
  );
}

/** GET https://host/ through the edge on `ip` (no DNS needed). → status code */
async function edgeGet(host: string, ip: string): Promise<{ code: number; body: string }> {
  const r = await run(['curl', '-sk', '-m', '10', '-o', '-', '-w', '\n%{http_code}', '--resolve', `${host}:443:${ip}`, `https://${host}/`]);
  const lines = r.stdout.split('\n');
  const code = Number(lines.pop() ?? 0);
  return { code, body: lines.join('\n') };
}

// ── 3. templates ───────────────────────────────────────────────────────────
export async function templates(ctx: Ctx) {
  await ensureEdge(ctx);
  // The edge publishes 80/443 in host mode on the manager (default placement).
  const edgeIp = ctx.cluster.manager.ip;
  const results: string[] = [];
  const deployed: string[] = [];
  try {
    for (const id of ['uptime-kuma', 'umami']) {
      const name = `${id.replace(/[^a-z0-9]/g, '')}-${ctx.runId}`.slice(0, 30);
      const host = `${name}.${dashed(edgeIp)}.sslip.io`;
      const t0 = Date.now();
      const res = await ctx.m<{ ok: boolean; stackName: string; url: string | null; steps: { label: string; status: string; error?: string }[] }>(
        'blueprints.deploy',
        { id, params: { name, domain: host, size: 's', options: {} } },
        10 * 60_000,
      );
      deployed.push(res.stackName);
      const bad = res.steps.filter((s) => s.status !== 'done' && s.status !== 'ok' && s.status !== 'skipped');
      log(`${id}: stack ${res.stackName}, url ${res.url}, steps ${res.steps.map((s) => `${s.label}=${s.status}`).join(', ')}`);
      assert(res.ok, `${id}: blueprint deploy not ok: ${bad.map((s) => `${s.label}: ${s.error ?? s.status}`).join('; ')}`);
      // Healthy = the app itself answers through the edge (2xx/3xx; a 502 is
      // Caddy with no live upstream).
      const got = await poll(
        `${id} answering at https://${host}/`,
        async () => {
          const r = await edgeGet(host, edgeIp);
          return r.code >= 200 && r.code < 400 ? r : null;
        },
        { timeoutMs: 10 * 60_000, intervalMs: 10_000 },
      );
      results.push(`${id} ${got.code} in ${Math.round((Date.now() - t0) / 1000)}s`);
    }
  } finally {
    if (!ctx.opts.keep) for (const s of deployed) await ctx.sdk.stacks.remove(s).catch(() => {});
  }
  return results.join('; ');
}

// ── 4. compose app + secret variable ───────────────────────────────────────
export async function composeSecret(ctx: Ctx) {
  const stack = `e2e-secret-${ctx.runId}`;
  const svc = `${stack}_app`;
  const value = secret(`e2e-s3cr3t-${randomBytes(12).toString('hex')}`);
  const compose = `services:\n  app:\n    image: nginx:1.27-alpine\n    environment:\n      PLAIN_VAR: visible\n`;
  const ref = await ctx.sdk.stacks.deploy({ name: stack, compose_source: compose });
  log(`REST POST /stacks → ${ref.id} (deployment ${ref.deployment_id})`);
  try {
    await poll(`${svc} running`, async () => (await ctx.sdk.services.list({ limit: 200 })).data.some((s) => s.name === svc && s.replicas.running >= 1), {
      timeoutMs: 4 * 60_000,
      intervalMs: 4000,
    });
    const set = await ctx.m<{ key: string; version: number }>('services.setSecretVar', { id: svc, key: 'E2E_SECRET', value, delivery: 'env' });
    log(`secret var ${set.key} v${set.version} set`);

    // Wait for the rolled task to carry the secret mount.
    await poll(
      `${svc} rolled with the secret`,
      async () => {
        const spec = await ctx.docker(`service inspect ${svc} --format '{{json .Spec.TaskTemplate.ContainerSpec.Secrets}}'`);
        if (!/E2E_SECRET/.test(spec)) return false;
        const st = await ctx.docker(`service inspect ${svc} --format '{{if .UpdateStatus}}{{.UpdateStatus.State}}{{end}}'`);
        return !/updating|rollback/.test(st);
      },
      { timeoutMs: 4 * 60_000, intervalMs: 4000 },
    );

    // 1. The value is nowhere in the swarm spec (env, labels, args)…
    const inspect = await ctx.docker(`service inspect ${svc}`);
    assert(!inspect.includes(value), 'secret VALUE appears in `docker service inspect`');
    assert(/E2E_SECRET/.test(inspect), 'secret not referenced by the service spec');
    // …nor in the container's config on whichever node runs it…
    const { node, cid } = await poll(`${svc} new task`, () => ctx.task(svc), { timeoutMs: 120_000 });
    const cinspect = await ctx.cluster.mustSh(node, `docker inspect ${cid}`);
    assert(!cinspect.includes(value), 'secret VALUE appears in `docker inspect <container>`');
    // …nor via the REST API / SDK…
    const restSvc = JSON.stringify(await ctx.sdk.services.get(svc).catch(() => ({})));
    assert(!restSvc.includes(value), 'secret VALUE returned by REST GET /services/{id}');
    const meta = JSON.stringify(await ctx.q('services.secretVars', { id: svc }));
    assert(!meta.includes(value), 'secret VALUE returned by services.secretVars');
    // 2. …but the running app does get it, as $E2E_SECRET (entrypoint shim).
    const seen = await poll(
      'app process sees $E2E_SECRET',
      async () => {
        const env = await ctx.cluster.mustSh(node, `docker exec ${cid} sh -c 'cat /run/secrets/E2E_SECRET 2>/dev/null; echo; tr "\\0" "\\n" < /proc/1/environ | grep -c ^E2E_SECRET= || true'`);
        return env.includes(value) ? env : null;
      },
      { timeoutMs: 60_000, intervalMs: 4000 },
    );
    const exported = /\n\s*1\s*$/.test(seen);
    return `value absent from service/container inspect + REST; mounted at /run/secrets${exported ? ' and exported to PID 1 env' : ''}`;
  } finally {
    if (!ctx.opts.keep) await ctx.sdk.stacks.remove(stack).catch(() => {});
  }
}

// ── 5. container-to-container DNS across nodes ─────────────────────────────
export async function crossNodeDns(ctx: Ctx) {
  const c = ctx.cluster;
  const stack = `e2e-dns-${ctx.runId}`;
  const hosts = await Promise.all(c.nodes.map((n) => ctx.hostnameOf(n)));
  // One service pinned to each node, all on the stack's default network.
  const compose =
    'services:\n' +
    hosts
      .map(
        (h, i) =>
          `  s${i + 1}:\n    image: nginx:1.27-alpine\n    deploy:\n      placement:\n        constraints: ["node.hostname == ${h}"]\n`,
      )
      .join('');
  await ctx.sdk.stacks.deploy({ name: stack, compose_source: compose });
  const checks: string[] = [];
  try {
    for (let i = 1; i <= hosts.length; i++) {
      await poll(`${stack}_s${i} running on ${hosts[i - 1]}`, async () => {
        const t = await ctx.task(`${stack}_s${i}`);
        return t.node.index === i;
      }, { timeoutMs: 5 * 60_000, intervalMs: 5000 });
    }
    // A ~2 MB body catches overlay MTU black-holes that tiny pings miss.
    await ctx.execIn(`${stack}_s1`, 'head -c 2000000 /dev/urandom > /usr/share/nginx/html/big.bin');
    for (let from = 1; from <= hosts.length; from++) {
      for (let to = 1; to <= hosts.length; to++) {
        if (from === to) continue;
        const target = `s${to}`;
        const out = await poll(
          `s${from} → ${target} (short name, cross-node)`,
          () => ctx.execIn(`${stack}_s${from}`, `getent hosts ${target} >/dev/null && wget -q -T 5 -O - http://${target}/ | grep -c 'Welcome to nginx'`),
          { timeoutMs: 90_000, intervalMs: 5000 },
        );
        assert(out.trim() === '1', `s${from} → ${target}: unexpected body`);
        checks.push(`s${from}→${target}`);
      }
    }
    const size = await ctx.execIn(`${stack}_s${hosts.length}`, `wget -q -T 20 -O - http://s1/big.bin | wc -c`);
    assert(Number(size.trim()) === 2_000_000, `2 MB transfer s${hosts.length}→s1 got ${size.trim()} bytes (MTU black-hole?)`);
    checks.push(`2MB s${hosts.length}→s1`);
    // tasks.<svc> resolves to task IPs (DNSRR), <svc> to the VIP.
    await ctx.execIn(`${stack}_s1`, `getent hosts tasks.s2`);
  } finally {
    if (!ctx.opts.keep) await ctx.sdk.stacks.remove(stack).catch(() => {});
  }

  // The full networking model (isolation between apps, control-plane
  // privacy) — scripts/verify-networking.sh, run on the manager.
  const script = readFileSync(join(REPO_ROOT, 'scripts/verify-networking.sh'), 'utf8');
  const r = await c.sh(c.manager, 'bash -s', { input: script, timeoutMs: 10 * 60_000 });
  const lines = (r.stdout + r.stderr).split('\n');
  for (const l of lines.filter((l) => /^(FAIL|WARN)/.test(l))) log(`verify-networking: ${l}`);
  const fails = lines.filter((l) => l.startsWith('FAIL'));
  assert(r.code === 0, `verify-networking.sh: ${fails.length} FAIL — ${fails.map((l) => l.replace(/\s+/g, ' ').slice(0, 120)).join(' | ')}`);
  return `${checks.join(', ')}; verify-networking.sh clean`;
}
