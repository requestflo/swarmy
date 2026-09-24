// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * e2e: the self-hosted mesh and people on it, on local Lima VMs
 * (plans/epic-self-hosted-mesh-and-fleets.md). One command:
 *
 *   bun run scripts/e2e-mesh-people.ts                 # fresh VMs, every step
 *   bun run scripts/e2e-mesh-people.ts --reuse         # keep existing VMs (re-runs the installer)
 *   … --reuse --skip-install                           # keep the install too
 *   TAG=meshe2e3 REG=host.lima.internal:5077 …         # images to install
 *
 * What it proves, end to end:
 *   1. node1: `install-swarmy.sh --mesh swarmy` — NetBird runs on the host
 *      network (agent-supervised), node1 joins its own mesh, the swarm is born
 *      on wt0 with the new default address pool, the controller registers
 *      swarmy as NetBird's only sign-in (local login hidden).
 *   2. node2 joins through the printed one-liner and advertises its wt0 IP.
 *   3. A production stack `shop` (db: a TCP service on 5432 declared with
 *      swarmy.mesh.ports) is deployed through swarmy.
 *   4. People access on. Alice gets a personal grant on `shop`; Bob doesn't.
 *      Both sign in from "the Mac" (a NetBird client on the swarmy-mac VM)
 *      through NetBird's device flow → Dex → swarmy's OIDC (no local login).
 *   5. Alice reaches db.shop.e2e.swarmy.internal:5432; a port that isn't
 *      declared (6000) stays shut. Bob reaches nothing.
 *   6. Revoking Alice's grant cuts her off within 30 s.
 *
 * Lab TLS: NetBird only accepts an https OIDC issuer, and swarmy's OIDC
 * provider only an https redirect (Dex's callback), so both names get TLS
 * from a `tls internal` Caddy on node1 — swarmy on :8443, the mesh on :8444
 * (h2c to NetBird's docker0 listener: `--mesh-tls edge` + SWARMY_MESH_PUBLIC_PORT,
 * the TLS-handover shape). Off 80/443, which swarmy's own edge Caddy holds. Its root CA reaches NetBird (SWARMY_MESH_EXTRA_CA), every node's
 * client (SWARMY_MESH_CA_B64 in the join line) and the laptop — the same
 * knobs an intranet on a private CA uses.
 *
 * Needs: Lima, the images pushed to $REG, and the repo's installer served by
 * a file server on the Mac (started here on 127.0.0.1:5078).
 */
import { spawn } from 'bun';

const REG = process.env.REG ?? 'host.lima.internal:5077';
const TAG = process.env.TAG ?? 'meshe2e3';
const N1 = 'swarmy-mesh-1';
const N2 = 'swarmy-mesh-2';
const LAPTOP = process.env.LAPTOP_VM ?? 'swarmy-mac';
const ADMIN = { email: 'admin@e2e.test', password: 'E2e-Admin-Passw0rd!' };
const ALICE = { email: 'alice@e2e.test', password: 'Alice-Passw0rd-e2e!', name: 'Alice' };
const BOB = { email: 'bob@e2e.test', password: 'Bob-Passw0rd-e2e-!!', name: 'Bob' };
const args = new Set(process.argv.slice(2));
const REPO = new URL('..', import.meta.url).pathname;
// GHCR, not Docker Hub: every image the run needs, so a shared IP's Docker Hub
// rate limit can't fail it (NetBird publishes identical digests to both).
const CADDY_IMAGE = 'ghcr.io/requestflo/caddy-swarmy@sha256:7d576859b1fad89c6310941ea7e1f9a4eab6cf46a1d244b7b83e94a29810ed33'; // pinned: prod guardrails refuse :latest
const NETBIRD_CLIENT = 'ghcr.io/netbirdio/netbird:0.79.0';

const results: { step: string; ok: boolean; detail: string; ms: number }[] = [];
function log(m: string) {
  console.log(`[e2e-mesh] ${m}`);
}
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  log(`▸ ${name}`);
  try {
    const r = await fn();
    results.push({ step: name, ok: true, detail: typeof r === 'string' ? r : '', ms: Date.now() - t0 });
    log(`✓ ${name}${typeof r === 'string' && r ? ` — ${r}` : ''} (${Math.round((Date.now() - t0) / 1000)} s)`);
    return r;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    results.push({ step: name, ok: false, detail: msg, ms: Date.now() - t0 });
    log(`✗ ${name}: ${msg}`);
    throw e;
  }
}

async function run(cmd: string[], input?: string, timeoutMs = 600_000): Promise<{ code: number; out: string; err: string }> {
  const p = spawn(cmd, { stdin: input !== undefined ? 'pipe' : 'ignore', stdout: 'pipe', stderr: 'pipe' });
  if (input !== undefined) {
    p.stdin!.write(input);
    p.stdin!.end();
  }
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  clearTimeout(timer);
  return { code, out, err };
}
/** Run a bash script as root on a VM (script on stdin, never argv). */
async function vm(name: string, script: string, timeoutMs = 600_000): Promise<string> {
  const r = await run(['limactl', 'shell', name, 'sudo', 'bash', '-s'], `set -euo pipefail\n${script}\n`, timeoutMs);
  if (r.code !== 0) throw new Error(`${name}: exit ${r.code}: ${(r.err || r.out).trim().split('\n').slice(-12).join(' | ')}`);
  return r.out;
}
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs = 180_000, everyMs = 3000): Promise<T> {
  const t0 = Date.now();
  let last: unknown;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${what}${last ? ` (last: ${last instanceof Error ? last.message : last})` : ''}`);
    await Bun.sleep(everyMs);
  }
}

// ── a tiny browser: cookies per host, manual redirects, lab TLS ─────────────
class Browser {
  jar = new Map<string, Map<string, string>>();
  cookie(host: string) {
    return [...(this.jar.get(host) ?? new Map())].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  absorb(host: string, res: Response) {
    const m = this.jar.get(host) ?? new Map<string, string>();
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const i = pair!.indexOf('=');
      if (i > 0) m.set(pair!.slice(0, i).trim(), pair!.slice(i + 1).trim());
    }
    this.jar.set(host, m);
  }
  async fetch(url: string, init: RequestInit = {}): Promise<Response> {
    const u = new URL(url);
    const headers = new Headers(init.headers);
    const c = this.cookie(u.host);
    if (c) headers.set('cookie', c);
    if (!headers.has('origin') && init.method && init.method !== 'GET') headers.set('origin', u.origin);
    const res = await fetch(url, { ...init, headers, redirect: 'manual', tls: { rejectUnauthorized: false } } as RequestInit);
    this.absorb(u.host, res);
    return res;
  }
  /** Follow redirects (any host) until a non-redirect; returns the final response + URL. */
  async follow(url: string, init: RequestInit = {}, max = 20): Promise<{ res: Response; url: string; hops: string[] }> {
    let res = await this.fetch(url, init);
    const hops = [url];
    while (res.status >= 300 && res.status < 400 && res.headers.get('location') && hops.length < max) {
      url = new URL(res.headers.get('location')!, url).toString();
      hops.push(url);
      res = await this.fetch(url);
    }
    return { res, url, hops };
  }
}

class Swarmy {
  b = new Browser();
  constructor(readonly base: string) {}
  async signIn(email: string, password: string) {
    const res = await this.b.fetch(`${this.base}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (res.status !== 200) throw new Error(`sign-in ${email} → ${res.status} ${await res.text()}`);
  }
  async signUp(u: { email: string; password: string; name: string }) {
    const res = await this.b.fetch(`${this.base}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(u),
    });
    const t = await res.text();
    // A re-run (--reuse): the account is already there — sign in instead.
    if (res.status !== 200 && !/already exists|USER_ALREADY_EXISTS/i.test(t)) throw new Error(`sign-up ${u.email} → ${res.status} ${t}`);
  }
  async q<T = any>(proc: string, input?: unknown): Promise<T> {
    const qs = input === undefined ? '' : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
    const res = await this.b.fetch(`${this.base}/api/trpc/${proc}${qs}`);
    const t = await res.text();
    if (res.status !== 200) throw new Error(`${proc} → ${res.status} ${t.slice(0, 400)}`);
    return JSON.parse(t).result.data.json as T;
  }
  async m<T = any>(proc: string, input?: unknown): Promise<T> {
    const res = await this.b.fetch(`${this.base}/api/trpc/${proc}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ json: input ?? null }),
    });
    const t = await res.text();
    if (res.status !== 200) throw new Error(`${proc} → ${res.status} ${t.slice(0, 400)}`);
    return JSON.parse(t).result.data.json as T;
  }
}

// ── the person's device: a NetBird client on the "Mac" VM ───────────────────
const personContainer = (who: string) => `swarmy-e2e-person-${who}`;

let labCa = '';
async function startDevice(who: string) {
  // The lab CA is what a laptop on a private-CA intranet would have installed.
  await vm(LAPTOP, `mkdir -p /root/swarmy-e2e-ca && cat > /root/swarmy-e2e-ca/lab-ca.pem <<'PEM'\n${labCa.trim()}\nPEM`);
  await vm(
    LAPTOP,
    `docker rm -f ${personContainer(who)} >/dev/null 2>&1 || true
docker run -d --name ${personContainer(who)} --hostname ${who}-mac --label swarmy.test=mesh-e2e \\
  --cap-add NET_ADMIN --cap-add SYS_ADMIN --cap-add SYS_RESOURCE --device /dev/net/tun \\
  -v /root/swarmy-e2e-ca:/etc/swarmy/ca:ro -e SSL_CERT_DIR=/etc/ssl/certs:/etc/swarmy/ca \\
  --entrypoint netbird ${NETBIRD_CLIENT} service run >/dev/null`,
  );
}

/**
 * `netbird up` with a per-cluster profile (what the UI hands out), then drive
 * the device flow like a browser: Dex's device page → (no local login: straight
 * to the swarmy connector) → swarmy's authorize, signed in → back to Dex.
 */
async function signInDevice(who: string, managementUrl: string, swarmy: Swarmy): Promise<string[]> {
  const c = personContainer(who);
  await vm(LAPTOP, `docker exec ${c} netbird profile add swarmy-e2e >/dev/null 2>&1 || true
docker exec -d ${c} sh -c 'netbird up --profile swarmy-e2e --management-url ${managementUrl} --no-browser > /tmp/up.log 2>&1'`);
  const url = await until(`${who}'s device-flow URL`, async () => {
    const out = await vm(LAPTOP, `docker exec ${c} cat /tmp/up.log 2>/dev/null || true`);
    return out.match(/https?:\/\/\S+user_code=[A-Z0-9-]+/)?.[0] ?? null;
  }, 60_000, 1000);
  const b = swarmy.b; // the person's own swarmy session cookies ride along
  const page = await b.follow(url);
  const html = await page.res.text();
  const action = html.match(/<form[^>]*action="([^"]+)"/i)?.[1];
  if (!action) throw new Error(`no device form at ${page.url} (${page.res.status})`);
  const fields = new URLSearchParams();
  for (const m of html.matchAll(/<input[^>]*name="([^"]+)"[^>]*?(?:value="([^"]*)")?[^>]*>/gi)) fields.set(m[1]!, m[2] ?? '');
  if (!fields.get('user_code')) fields.set('user_code', new URL(url).searchParams.get('user_code')!);
  const done = await b.follow(new URL(action.replace(/&amp;/g, '&'), page.url).toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: fields.toString(),
  });
  const body = await done.res.text();
  const hosts = done.hops.map((h) => new URL(h).host + new URL(h).pathname);
  if (hosts.some((h) => /\/login/.test(h) && h.includes(new URL(swarmy.base).host))) throw new Error(`swarmy asked ${who} to log in again: ${hosts.join(' → ')}`);
  if (done.res.status >= 400) throw new Error(`device flow ended ${done.res.status} at ${done.url}: ${body.slice(0, 300)}`);
  await until(`${who}'s client connected`, async () => {
    const out = await vm(LAPTOP, `docker exec ${c} netbird status 2>/dev/null || true`);
    return /Management: Connected/.test(out) && /NetBird IP: 100\./.test(out);
  }, 90_000, 2000);
  return hosts;
}

async function reach(who: string, target: string): Promise<boolean> {
  const out = await vm(LAPTOP, `docker exec ${personContainer(who)} sh -c 'wget -qO- -T 3 http://${target}/ 2>/dev/null || echo __FAIL__'`, 60_000);
  return !out.includes('__FAIL__') && out.includes('db-5432');
}
async function resolves(who: string, name: string): Promise<string | null> {
  const out = await vm(LAPTOP, `docker exec ${personContainer(who)} sh -c 'getent hosts ${name} || true'`, 30_000);
  return out.trim().split(/\s+/)[0] || null;
}

// ── the run ─────────────────────────────────────────────────────────────────
async function main() {
  const fileServer = Bun.serve({
    hostname: '127.0.0.1',
    port: 5078,
    fetch(req) {
      const p = new URL(req.url).pathname;
      if (!/^\/(scripts\/install-swarmy\.sh|deploy\/[\w.-]+\.ya?ml)$/.test(p)) return new Response('not found', { status: 404 });
      return new Response(Bun.file(REPO + p.slice(1)));
    },
  });
  try {
    if (!args.has('--reuse')) {
      await step('fresh VMs', async () => {
        for (const n of [N1, N2]) await run(['limactl', 'delete', '-f', n]);
        await Promise.all(
          [N1, N2].map((n) =>
            run(['limactl', 'start', '--tty=false', '--timeout=10m', `--name=${n}`, '--cpus=2', '--memory=2', '--disk=15', '--network=vzNAT', '--containerd=none', 'template:ubuntu-24.04'], undefined, 900_000),
          ),
        );
        for (const n of [N1, N2]) {
          await vm(n, `mkdir -p /etc/docker; printf '{"insecure-registries": ["${REG}"]}\\n' > /etc/docker/daemon.json`);
        }
        return 'swarmy-mesh-1, swarmy-mesh-2';
      });
    }
    const ip1 = (await vm(N1, `ip -4 -o addr show lima0 | awk '{print $4}' | cut -d/ -f1`)).trim();
    const ip2 = (await vm(N2, `ip -4 -o addr show lima0 | awk '{print $4}' | cut -d/ -f1`)).trim();
    await step('lab network: VM↔VM over the host', async () => {
      // macOS vmnet (vzNAT) here doesn't pass ARP between VMs, only VM↔Mac.
      // Route each node's peer through its slirp gateway (the Mac's stack):
      // TCP + UDP both pass, which is all a NAT'd pair of servers gets anyway.
      await vm(N1, `ip route replace ${ip2}/32 via 192.168.5.2 dev eth0`);
      await vm(N2, `ip route replace ${ip1}/32 via 192.168.5.2 dev eth0`);
      await vm(N2, `curl -sS -m5 -o /dev/null http://${ip1}:22 || true`);
      return `${ip1} ⇄ ${ip2}`;
    });
    const swarmyHost = `swarmy-${ip1.replace(/\./g, '-')}.sslip.io`;
    const base = `https://${swarmyHost}:8443`;
    const direct = `http://${ip1}:3021`;
    const meshHost = `mesh-${ip1.replace(/\./g, '-')}.sslip.io`;
    const meshUrl = `https://${meshHost}:8444`;

    const installOut = args.has('--skip-install')
      ? await vm(N1, 'cat /root/install.log')
      : await step('node1: install-swarmy.sh --mesh swarmy', async () => {
      // Lab TLS for swarmy's own address (see the header).
      await vm(
        N1,
        `command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh >/dev/null 2>&1
mkdir -p /root/labtls
cat > /root/labtls/Caddyfile <<EOF
{
  local_certs
  skip_install_trust
  auto_https disable_redirects
}
${swarmyHost}:8443 {
  tls internal
  reverse_proxy 127.0.0.1:3021
}
${meshHost}:8444 {
  tls internal
  @grpc header Content-Type application/grpc*
  reverse_proxy @grpc h2c://172.17.0.1:8081 {
    flush_interval -1
    transport http {
      read_timeout 24h
      write_timeout 24h
    }
  }
  reverse_proxy 172.17.0.1:8081 {
    flush_interval -1
  }
}
EOF
docker rm -f swarmy-e2e-labtls >/dev/null 2>&1 || true
docker run -d --name swarmy-e2e-labtls --network host --restart unless-stopped -v /root/labtls/Caddyfile:/etc/caddy/Caddyfile -v swarmy-e2e-labtls:/data ${CADDY_IMAGE} caddy run --config /etc/caddy/Caddyfile >/dev/null
for i in $(seq 1 30); do docker exec swarmy-e2e-labtls test -s /data/caddy/pki/authorities/local/root.crt && break; sleep 1; done
docker exec swarmy-e2e-labtls cat /data/caddy/pki/authorities/local/root.crt > /root/lab-ca.pem`,
        600_000,
      );
      const out = await vm(
        N1,
        `umask 077
cat > /root/.e2e.env <<EOF
SWARMY_ADMIN_PASSWORD=${ADMIN.password}
SWARMY_RAW_BASE=http://host.lima.internal:5078
SWARMY_PUBLIC_URL=${base}
SWARMY_MESH_EXTRA_CA=/root/lab-ca.pem
SWARMY_MESH_PUBLIC_PORT=8444
EOF
set -a; . /root/.e2e.env; set +a
curl -fsSL http://host.lima.internal:5078/scripts/install-swarmy.sh | bash -s -- --non-interactive --admin-email ${ADMIN.email} \\
  --image ${REG}/swarmy-controller:${TAG} --agent-image ${REG}/swarmy-agent:${TAG} --mesh swarmy --mesh-tls edge --cluster-name e2e --allow-signup 2>&1 | tee /root/install.log`,
        1_500_000,
      );
      return out;
    });

    labCa = await vm(N1, 'cat /root/lab-ca.pem');
    await step('node1: control plane on the host network, swarm born on wt0', async () => {
      const out = await vm(
        N1,
        `docker inspect swarmy-mesh-control --format '{{.HostConfig.NetworkMode}} {{.State.Running}}'
docker inspect swarmy-mesh-control --format '{{json .Config.Env}}' | grep -c authSecret || true
ip -4 -o addr show wt0 | awk '{print $4}' | cut -d/ -f1
docker info --format '{{.Swarm.NodeAddr}}'
docker network inspect ingress --format '{{(index .IPAM.Config 0).Subnet}}'`,
      );
      const [mode, envHasSecret, wt0, adv, ingress] = out.trim().split('\n');
      if (mode !== 'host true') throw new Error(`swarmy-mesh-control: ${mode}`);
      if (envHasSecret !== '0') throw new Error('the NetBird secrets leaked into the container env');
      if (!wt0 || wt0 !== adv) throw new Error(`swarm advertises ${adv}, wt0 is ${wt0}`);
      if (!/^10\.2\d\d\./.test(ingress ?? '')) throw new Error(`default address pool not applied (ingress ${ingress})`);
      return `wt0 ${wt0}, ingress ${ingress}`;
    });

    const admin = new Swarmy(base);
    await step('controller: swarmy is NetBird\'s only sign-in', async () => {
      await until('admin sign-in', async () => {
        await admin.signIn(ADMIN.email, ADMIN.password);
        return true;
      }, 180_000, 5000);
      const card = await until('connector registered', async () => {
        const c = await admin.q('mesh.control.status');
        return c.identity?.connector && !c.identity.localLogin && c.status?.running ? c : null;
      }, 240_000, 5000);
      // The local login is hidden: Dex goes straight to the swarmy connector.
      // (Registering it restarts NetBird once with localAuthDisabled: retry.)
      await until('Dex skips its own login', async () => {
        const r = await fetch(`${meshUrl}/oauth2/auth?client_id=netbird-cli&response_type=code&scope=openid&redirect_uri=http://localhost:53000/&state=x`, {
          redirect: 'manual',
          tls: { rejectUnauthorized: false },
        } as RequestInit);
        const loc = r.headers.get('location') ?? '';
        if (r.status === 302 && /\/oauth2\/auth\/[a-z0-9]+/.test(loc)) return true;
        if (r.status === 200) throw new Error('Dex offered a choice of logins');
        return null;
      }, 120_000, 3000);
      return `${card.meshDomain} on ${card.node.hostname}, v${card.version}`;
    });

    await step('node2 joins through the printed one-liner, on its mesh IP', async () => {
      const line = installOut.split('\n').find((l) => l.includes('Add a node:'));
      if (!line) throw new Error('no Add-a-node line printed');
      // Before the lab cert is trusted by agents, join over the direct origin (the installer says so too).
      const cmd = line.replace(/^.*Add a node:\s*/, '').replaceAll(base, direct);
      if (!cmd.includes('SWARMY_MESH_SETUP_KEY=')) throw new Error('the join line carries no mesh key');
      await vm(N2, `command -v curl >/dev/null || apt-get install -y curl >/dev/null; ${cmd}`, 900_000);
      const out = await until('node2 on the mesh in the swarm', async () => {
        const o = await vm(N1, `docker node ls --format '{{.Hostname}} {{.Status}}'; docker node inspect $(docker node ls -q) --format '{{.Description.Hostname}} {{.Status.Addr}}'`);
        return /swarmy-mesh-2 Ready/.test(o) && /swarmy-mesh-2 100\./.test(o) ? o : null;
      }, 600_000, 5000);
      return out.split('\n').filter((l) => l.includes('100.')).join(', ');
    });

    await step('deploy production stack shop (db declares 5432)', async () => {
      const compose = `services:
  db:
    image: ${CADDY_IMAGE}
    command: ["sh", "-c", "caddy respond --listen :6000 --body db-5432 & exec caddy respond --listen :5432 --body db-5432"]
    deploy:
      labels:
        swarmy.mesh.ports: "5432"
        swarmy.env: production
      replicas: 1
`;
      await admin.m('stacks.deployFromCompose', { name: 'shop', composeSource: compose });
      await until('shop_db running', async () => {
        const o = await vm(N1, `docker service ls --filter name=shop_db --format '{{.Replicas}}'`);
        return o.trim() === '1/1';
      }, 300_000, 5000);
      return 'shop_db 1/1';
    });

    const users = await step('people: Alice and Bob sign up; Alice gets a personal grant', async () => {
      await admin.m('mesh.people.setSettings', { enabled: true });
      const alice = new Swarmy(base);
      const bob = new Swarmy(base);
      const orgs = (await (await admin.b.fetch(`${base}/api/auth/organization/list`)).json()) as { id: string }[];
      const orgId = orgs[0]?.id;
      if (!orgId) throw new Error('admin has no organization');
      for (const [s, u] of [[alice, ALICE], [bob, BOB]] as const) {
        await s.signUp(u);
        await s.signIn(u.email, u.password);
        const already = (await admin.q('members.list')).some((m: any) => m.user.email === u.email);
        if (!already) {
          const inv = await admin.m('members.invite', { email: '', role: 'member' });
          await s.m('authConfig.acceptInvite', { id: inv.id });
        }
        // A fresh session with the org active (the cookie cache holds the old one).
        await s.signIn(u.email, u.password);
        const r = await s.b.fetch(`${base}/api/auth/organization/set-active`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ organizationId: orgId }),
        });
        if (r.status !== 200) throw new Error(`set-active ${u.email} → ${r.status} ${await r.text()}`);
      }
      const members = await admin.q('members.list');
      const aliceId = members.find((m: any) => m.user.email === ALICE.email)?.user.id;
      if (!aliceId) throw new Error('alice is not a member');
      const denied = await alice.q('mesh.people.connectInfo', { stack: 'shop' });
      if (denied.allowed) throw new Error('alice could connect to a production stack before any grant');
      const g = await admin.m('mesh.people.grant', { stack: 'shop', userId: aliceId, ttlSec: 3600 });
      const info = await alice.q('mesh.people.connectInfo', { stack: 'shop' });
      if (!info.allowed || !info.services.some((s: any) => s.fqdn === 'db.shop.e2e.swarmy.internal')) throw new Error(`connectInfo after grant: ${JSON.stringify(info).slice(0, 300)}`);
      return { alice, bob, grantId: g.id as string, info };
    });

    await step('the Mac: Alice signs in through swarmy (device flow, no NetBird login page)', async () => {
      await startDevice('alice');
      const hops = await signInDevice('alice', meshUrl, users.alice);
      return hops.map((h) => h.split('/')[0]).filter((h, i, a) => a.indexOf(h) === i).join(' → ');
    });

    await step('Alice reaches db.shop:5432, not the undeclared :6000', async () => {
      const fqdn = 'db.shop.e2e.swarmy.internal';
      const ok = await until('alice → db.shop:5432', async () => (await reach('alice', `${fqdn}:5432`)) || null, 120_000, 3000);
      const vip = await resolves('alice', fqdn);
      const shut = !(await vm(LAPTOP, `docker exec ${personContainer('alice')} sh -c 'wget -qO- -T 3 http://${vip}:6000/ 2>/dev/null || echo __FAIL__'`)).includes('db-5432');
      if (!shut) throw new Error('port 6000 is reachable: not least privilege');
      return `${fqdn} → ${vip}, 5432 open (${ok}), 6000 shut`;
    });

    await step('Bob (no grant) signs in and reaches nothing', async () => {
      await startDevice('bob');
      await signInDevice('bob', meshUrl, users.bob);
      await Bun.sleep(10_000);
      const vip = await resolves('alice', 'db.shop.e2e.swarmy.internal');
      const name = await resolves('bob', 'db.shop.e2e.swarmy.internal');
      if (name) throw new Error(`bob resolves db.shop (${name})`);
      if (await reach('bob', `${vip}:5432`)) throw new Error('bob reaches db.shop by VIP');
      return 'no DNS, no route';
    });

    await step('revoking Alice cuts her off within 30 s', async () => {
      const t0 = Date.now();
      await admin.m('mesh.people.revoke', { grantId: users.grantId });
      await until('alice cut off', async () => !(await reach('alice', 'db.shop.e2e.swarmy.internal:5432')) || null, 30_000, 1000);
      const s = Math.round((Date.now() - t0) / 100) / 10;
      if (s > 30) throw new Error(`took ${s} s`);
      return `${s} s`;
    });

    await step("who's connected + control-plane card", async () => {
      const people = await admin.q('mesh.people.connected');
      const card = await admin.q('mesh.control.status');
      return `${people.length} device(s): ${people.map((p: any) => `${p.email}@${p.device}${p.connected ? '' : ' (idle)'}`).join(', ')}; card: ${card.status?.healthy ? 'healthy' : 'not healthy'}, ${card.peers.total} peers`;
    });
  } finally {
    fileServer.stop(true);
    console.log('\n──── e2e-mesh-people ────');
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.step}${r.detail ? `  — ${r.detail.split('\n')[0]!.slice(0, 200)}` : ''}  (${Math.round(r.ms / 1000)} s)`);
  }
}

main().then(
  () => process.exit(results.every((r) => r.ok) ? 0 : 1),
  () => process.exit(1),
);
