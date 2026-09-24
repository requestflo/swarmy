/**
 * Platform scenarios: install, first login, adding servers, a worker dying,
 * controller move/restore, platform upgrade, teardown.
 */
import { randomBytes } from 'node:crypto';
import type { Ctx } from '../context';
import { Skip } from '../lib/report';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, Fatal, log, must, poll, q, run, secret } from '../lib/util';

// ── 1. install ─────────────────────────────────────────────────────────────
export async function install(ctx: Ctx) {
  const c = ctx.cluster;
  if (!ctx.opts.reuse) await c.destroyAll();
  await c.prepareSource();
  await c.ensureRegistry();
  // With the upgrade scenario on, node 1 starts on the PREVIOUS build (its
  // installer, stack files and images) and the upgrade step rolls it forward.
  let tag = c.cfg.tag;
  let built = c.commit;
  if (upgradeEnabled(ctx)) {
    const prev = await c.snapshot(c.cfg.upgradeFrom, 'src-prev');
    tag = `${c.cfg.tag}-prev`;
    built = prev.commit;
    await c.buildImages(tag, prev.dir, prev.commit);
    c.serveRoot = prev.dir;
  } else {
    await c.buildImages();
  }
  c.startFileServer();
  await c.createNodes();
  log(`nodes: ${c.nodes.map((n) => `${n.name}=${n.ip}`).join(' ')}`);

  const password = secret(randomBytes(18).toString('base64url'));
  const t0 = Date.now();
  await c.install(password, [], tag);
  c.installedTag = tag;
  log(`install-swarmy.sh finished in ${Math.round((Date.now() - t0) / 1000)}s`);
  await poll('controller /health from the host', () => c.controllerHealthy(), { timeoutMs: 120_000 });
  ctx.password = password;
  const v = await (await fetch(`${c.controllerUrl}/version`)).text().catch(() => '');
  return `controller up at ${c.controllerUrl} (${built})${v ? ` version=${v.slice(0, 80)}` : ''}`;
}

/** The upgrade scenario runs when forced on AND selected. */
export function upgradeEnabled(ctx: Ctx) {
  return ctx.opts.enable.includes('upgrade') && (!ctx.opts.only || ctx.opts.only.includes('upgrade'));
}

// ── 1b. login ──────────────────────────────────────────────────────────────
export async function login(ctx: Ctx) {
  await ctx.connect(ctx.password || undefined);
  // The key must work on the public REST API (SDK) and be scoped to the org.
  // Node 1's agent registers a few seconds after the controller is healthy.
  const nodes = await poll('node 1 registered (REST /nodes)', async () => {
    const r = await ctx.sdk.nodes.list();
    return r.data.length >= 1 ? r : null;
  }, { timeoutMs: 3 * 60_000, intervalMs: 3000 });
  // Invite-only by default: a stranger cannot self-register.
  const res = await fetch(`${ctx.url}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ctx.url },
    body: JSON.stringify({ email: `stranger-${ctx.runId}@example.com`, password: 'Str4nger-passw0rd!', name: 'x' }),
  });
  assert(res.status === 403, `stranger sign-up returned ${res.status}, want 403 (invite-only)`);
  return `signed in as ${ctx.cluster.cfg.adminEmail}; API key works on REST (${nodes.data.length} node)`;
}

// ── 2. add servers ─────────────────────────────────────────────────────────
export async function servers(ctx: Ctx) {
  const c = ctx.cluster;
  const workers = c.workers;
  if (!workers.length) throw new Skip('single-node cluster');
  const mint = () =>
    ctx.m<{ token: string; id: string; meshSetupKey?: string; meshManagementUrl?: string; meshDriver?: string }>('nodes.generateJoinToken', {
      ttlSeconds: 3600,
      maxUses: 1,
      label: `e2e-${ctx.runId}`,
    });
  if (c.cfg.mesh === 'none') {
    // With --mesh none a NATed worker can't carry swarm overlay traffic, so
    // node 3 joins like node 2. --mesh swarmy NATs it and joins over the mesh.
    log('mesh=none: node 3 joins directly (NAT simulation needs --mesh swarmy)');
  }
  await Promise.all(
    workers.map(async (w) => {
      if (w.natted && c.cfg.mesh !== 'none') await natSimulate(ctx, w.index);
      // Mesh on: tokens are single-use (one embedded setup key each).
      const tok = await mint();
      secret(tok.token);
      secret(tok.meshSetupKey);
      const env = [`SWARMY_JOIN_TOKEN=${q(tok.token)}`];
      if (tok.meshSetupKey) {
        env.push(`SWARMY_MESH_SETUP_KEY=${q(tok.meshSetupKey)}`, `SWARMY_MESH_MANAGEMENT_URL=${q(tok.meshManagementUrl ?? '')}`, `SWARMY_MESH_DRIVER=${q(tok.meshDriver ?? '')}`);
      }
      await c.mustSh(w, 'umask 077; cat > /root/.swarmy-join.env', { input: env.join('\n') + '\n' });
      // The same one-liner Infrastructure → Add a node hands out.
      // Container backend (dind): run the locally built agent image, not ghcr's.
      const agentImage = c.provider.agentBackend === 'docker' ? ` SWARMY_AGENT_IMAGE=${q(await c.image('agent', c.installedTag))}` : '';
      const oneLiner = `set -a; . /root/.swarmy-join.env; set +a; SWARMY_BACKEND=${c.provider.agentBackend} SWARMY_NODE_LABELS=e2e,${w.name}${agentImage}; export SWARMY_BACKEND SWARMY_NODE_LABELS SWARMY_AGENT_IMAGE; curl -fsSL ${q(`${c.controllerOrigin}/install/loader.sh`)} | sh -s -- --controller ${q(c.controllerOrigin)}`;
      // Fresh box: the agent installer brings Docker itself (get.docker.com).
      const r = await c.sh(w, oneLiner, { timeoutMs: 10 * 60_000, stream: true });
      if (r.code !== 0) throw new Error(`${w.name}: agent one-liner exited ${r.code}`);
    }),
  );

  const want = c.nodes.length;
  const online = await poll(
    `${want} nodes online (REST /nodes)`,
    async () => {
      const { data } = await ctx.sdk.nodes.list({ limit: 100 });
      const on = data.filter((n) => n.status === 'online');
      return on.length >= want ? data : null;
    },
    { timeoutMs: 6 * 60_000, intervalMs: 5000 },
  );
  // …and the swarm itself must see them Ready (the agent joined it as a worker).
  await poll(
    `${want} swarm nodes Ready`,
    async () => {
      const out = await ctx.docker(`node ls --format '{{.Hostname}} {{.Status}} {{.Availability}}'`);
      return out.split('\n').filter((l) => / Ready Active$/.test(l.trim())).length >= want;
    },
    { timeoutMs: 5 * 60_000, intervalMs: 5000 },
  );
  return online.map((n) => `${n.hostname}:${n.role}:${n.status}`).join(' ');
}

/**
 * Simulate node N sitting behind NAT: nothing may open a NEW connection to it
 * from the other nodes' LAN (only replies and its own outbound dials pass),
 * so it can only be reached over the mesh interface.
 */
async function natSimulate(ctx: Ctx, index: number) {
  const n = ctx.node(index);
  const peers = ctx.cluster.nodes.filter((x) => x !== n).map((x) => x.fabricIp);
  const rules = peers
    .map((ip) => `iptables -I INPUT -s ${ip} -m conntrack --ctstate NEW -j DROP`)
    .join('; ');
  await ctx.cluster.mustSh(n, `${rules}`, {}, `${n.name}: NAT simulation`);
  log(`${n.name}: inbound NEW from ${peers.join(',')} dropped (simulated NAT)`);
}

// ── 8. kill a worker → rescheduling ────────────────────────────────────────
export async function reschedule(ctx: Ctx) {
  const c = ctx.cluster;
  const victim = c.workers[0];
  if (!victim) throw new Skip('needs a worker');
  const stack = `e2e-resched-${ctx.runId}`;
  // 3 replicas spread over the nodes; at least one lands on the victim.
  const compose = `services:\n  web:\n    image: nginx:1.27-alpine\n    deploy:\n      replicas: 3\n      placement:\n        max_replicas_per_node: 1\n`;
  const ref = await ctx.sdk.stacks.deploy({ name: stack, compose_source: compose });
  log(`REST POST /stacks → ${ref.id}`);
  const svc = `${stack}_web`;
  const tasksOn = async () => {
    const out = await ctx.docker(`service ps ${svc} --filter desired-state=running --format '{{.Node}} {{.CurrentState}}'`);
    return out.split('\n').filter(Boolean);
  };
  await poll(`${svc} 3/3 running`, async () => (await tasksOn()).filter((l) => / Running/.test(l)).length === 3, {
    timeoutMs: 5 * 60_000,
    intervalMs: 5000,
  });
  const victimHost = (await c.mustSh(victim, 'hostname')).trim();
  const before = await tasksOn();
  log(`before: ${before.join(' | ')}`);
  assert(before.some((l) => l.startsWith(victimHost + ' ')), `no ${svc} task on ${victimHost}`);

  // A single replica pinned nowhere must MOVE off the dead node too.
  const single = `${stack}-solo`;
  await ctx.sdk.stacks.deploy({
    name: single,
    compose_source: `services:\n  app:\n    image: nginx:1.27-alpine\n    deploy:\n      placement:\n        constraints: ["node.hostname == ${victimHost}"]\n`,
  });
  await poll(`${single}_app running on ${victimHost}`, async () =>
    (await ctx.docker(`service ps ${single}_app --filter desired-state=running --format '{{.Node}} {{.CurrentState}}'`)).includes(`${victimHost} Running`),
  { timeoutMs: 4 * 60_000, intervalMs: 5000 });
  // Lift the constraint via a plain update so the scheduler is free to move it.
  await ctx.docker(`service update --detach --constraint-rm 'node.hostname == ${victimHost}' ${single}_app`);

  const t0 = Date.now();
  log(`hard power-off ${victim.name} (${victimHost})`);
  await c.provider.kill(victim.name);

  await poll(
    `swarm marks ${victimHost} Down`,
    async () => (await ctx.docker(`node ls --format '{{.Hostname}} {{.Status}}'`)).includes(`${victimHost} Down`),
    { timeoutMs: 3 * 60_000, intervalMs: 3000 },
  );
  const downAfter = Math.round((Date.now() - t0) / 1000);
  await poll(
    'REST reports the node offline',
    async () => (await ctx.sdk.nodes.list({ limit: 100 })).data.some((n) => n.hostname === victimHost && n.status === 'offline'),
    { timeoutMs: 3 * 60_000, intervalMs: 5000 },
  );
  // Replicated 3 with max 1/node on a now-2-node swarm: 2 run elsewhere, the
  // third stays pending (correct). The solo service must be running elsewhere.
  await poll(
    `${single}_app rescheduled off ${victimHost}`,
    async () => {
      const out = await ctx.docker(`service ps ${single}_app --filter desired-state=running --format '{{.Node}} {{.CurrentState}}'`);
      return out.split('\n').some((l) => / Running/.test(l) && !l.startsWith(victimHost + ' '));
    },
    { timeoutMs: 5 * 60_000, intervalMs: 5000 },
  );
  const moved = Math.round((Date.now() - t0) / 1000);
  const after = await tasksOn();
  log(`after: ${after.join(' | ')}`);
  assert(after.filter((l) => / Running/.test(l) && !l.startsWith(victimHost + ' ')).length >= 2, `${svc}: fewer than 2 replicas running on surviving nodes`);

  // Bring the node back and prove it rejoins (agent reconnects on its stored session).
  await c.provider.start(victim.name);
  await c.refreshIps();
  await poll(
    `${victimHost} back online`,
    async () => (await ctx.sdk.nodes.list({ limit: 100 })).data.some((n) => n.hostname === victimHost && n.status === 'online'),
    { timeoutMs: 6 * 60_000, intervalMs: 5000 },
  );
  await ctx.sdk.stacks.remove(stack).catch(() => {});
  await ctx.sdk.stacks.remove(single).catch(() => {});
  return `node Down after ${downAfter}s, solo task moved after ${moved}s; node rejoined`;
}

// ── 9. controller move / restore (P3: SQLite + Litestream) ─────────────────
export async function controllerMove(ctx: Ctx) {
  const c = ctx.cluster;
  if (!(await ctx.session.hasProcedure('controllerStore.move'))) {
    throw new Skip('flagged off: controllerStore.move (P3: SQLite + Litestream) not in this build');
  }
  const target = c.workers[0];
  if (!target) throw new Skip('needs a second node to move to');
  const targetHost = await ctx.hostnameOf(target);

  // State that must come across: a stack and the harness's own API key.
  const stack = `e2e-move-${ctx.runId}`;
  await ctx.sdk.stacks.deploy({ name: stack, compose_source: 'services:\n  web:\n    image: nginx:1.27-alpine\n' });

  // 1. The target must be a manager.
  const nodes = (await ctx.sdk.nodes.list({ limit: 100 })).data;
  const tnode = nodes.find((n) => n.hostname === targetHost);
  assert(tnode, `no REST node for ${targetHost}`);
  await ctx.m('swarm.promote', { id: tnode.id });
  await poll(`${targetHost} is a swarm manager`, async () =>
    (await ctx.docker(`node ls --format '{{.Hostname}} {{.ManagerStatus}}'`)).split('\n').some((l) => l.startsWith(`${targetHost} `) && /Reachable|Leader/.test(l)),
  { timeoutMs: 3 * 60_000, intervalMs: 5000 });

  // 2. Replicate the controller store to the built-in object store (Garage).
  await ctx.m('storage.enable', undefined, 5 * 60_000).catch((e) => {
    if (!/already/i.test((e as Error).message)) throw e;
  });
  await poll('object store up', async () => (await ctx.q<{ enabled: boolean; endpoint: string | null }>('storage.status'))?.enabled, {
    timeoutMs: 8 * 60_000,
    intervalMs: 10_000,
  });
  await poll('controllerStore.enableReplication accepted', async () => (await ctx.m('controllerStore.enableReplication', { target: { kind: 'garage' } }), true), {
    timeoutMs: 8 * 60_000,
    intervalMs: 10_000,
  });
  // enableReplication restarts the controller with Litestream on.
  let st: any;
  await poll(
    'store replicating and caught up',
    async () => {
      try {
        st = await ctx.q('controllerStore.status');
      } catch {
        await ctx.connect(ctx.password || undefined).catch(() => {});
        return null;
      }
      return st?.mode === 'replicated' && st?.replicating && st?.lagSeconds === 0 ? st : null;
    },
    { timeoutMs: 10 * 60_000, intervalMs: 5000 },
  );
  log(`replicating to ${JSON.stringify(st.target)}; epoch ${st.epoch}; on ${st.hostname}`);
  const mv = (st.managers ?? []).find((m: any) => m.hostname === targetHost);
  assert(mv && !mv.blocked, `move target ${targetHost} not offered: ${JSON.stringify(st.managers)}`);

  // 3. Move, then find the controller on the target node.
  const t0 = Date.now();
  const res = await ctx.m<{ from: string; to: string }>('controllerStore.move', { swarmNodeId: mv.swarmNodeId });
  log(`move ${res.from} → ${res.to}`);
  await poll(
    `controller task running on ${targetHost}`,
    async () => (await ctx.docker(`service ps swarmy_controller --filter desired-state=running --format '{{.Node}} {{.CurrentState}}'`)).includes(`${targetHost} Running`),
    { timeoutMs: 10 * 60_000, intervalMs: 5000 },
  );
  // Host-mode publish: the API now answers on the target's address.
  c.controllerUrl = `http://${await c.provider.hostEndpoint(target.name, 3021)}`;
  await poll('controller healthy on the new node', () => c.controllerHealthy(), { timeoutMs: 5 * 60_000, intervalMs: 3000 });
  const movedIn = Math.round((Date.now() - t0) / 1000);

  // 4. Everything survived: login, the SAME API key, the stack, the nodes.
  await ctx.connect(ctx.password || undefined);
  const stacks = (await ctx.sdk.stacks.list({ limit: 200 })).data;
  assert(stacks.some((x) => x.name === stack), `stack ${stack} missing after the move`);
  await poll('all nodes online after the move', async () => (await ctx.sdk.nodes.list({ limit: 100 })).data.every((n) => n.status === 'online'), {
    timeoutMs: 5 * 60_000,
    intervalMs: 5000,
  });
  const after = await ctx.q('controllerStore.status');
  assert(after?.hostname === targetHost, `controllerStore.status says ${after?.hostname}`);
  await ctx.sdk.stacks.remove(stack).catch(() => {});
  return `controller ${res.from} → ${res.to} in ${movedIn}s (epoch ${st.epoch} → ${after.epoch}); login, API key, stack, nodes intact`;
}

// ── 10. platform upgrade previous → current ────────────────────────────────
export async function upgrade(ctx: Ctx) {
  const c = ctx.cluster;
  const hasButton = await ctx.session.hasProcedure('platform.start');
  const forced = upgradeEnabled(ctx);
  if (!hasButton && !forced) {
    throw new Skip('flagged off: no upgrade button (platform.start) in this build; --enable upgrade re-runs the installer instead (docs/UPGRADING.md)');
  }
  // State created on the installed build must survive the upgrade.
  const stack = `e2e-upg-${ctx.runId}`;
  await ctx.sdk.stacks.deploy({ name: stack, compose_source: 'services:\n  web:\n    image: nginx:1.27-alpine\n' });
  await poll(`${stack}_web running`, () => ctx.task(`${stack}_web`), { timeoutMs: 4 * 60_000, intervalMs: 5000 });
  const beforeNodes = (await ctx.sdk.nodes.list({ limit: 100 })).data.length;
  const beforeVersion = await (await fetch(`${c.controllerUrl}/version`)).text().catch(() => '?');

  // "Next" = the current source under a new tag (a distinct digest).
  // Without --enable upgrade the installed build IS the current source, so
  // "next" is that source rebuilt with a distinct commit stamp: a genuinely
  // new digest the upgrade has to roll out (same code).
  const nextTag = `${c.cfg.tag}-next-${ctx.runId}`;
  const digests = await c.buildImages(nextTag, c.srcDir, forced ? c.commit : `${c.commit}-next`);
  c.serveRoot = c.srcDir;
  let how: string;
  if (hasButton) {
    how = await upgradeViaButton(ctx, nextTag, digests);
  } else {
    await c.install(ctx.password || (await c.adminPasswordFromNode()), [], nextTag);
    how = 'installer re-run';
    await poll('controller healthy after upgrade', () => c.controllerHealthy(), { timeoutMs: 10 * 60_000, intervalMs: 5000 });
  }
  c.installedTag = nextTag;
  const img = await ctx.docker(`service inspect swarmy_controller --format '{{.Spec.TaskTemplate.ContainerSpec.Image}}'`);
  assert(img.includes(digests.controller) || img.includes(nextTag), `swarmy_controller still on ${img.trim()}`);
  // …and the RUNNING controller is the new one (not the old task mid-rollout).
  await poll(
    'new controller task running + healthy',
    async () => {
      const running = await ctx.docker(`ps --filter label=com.docker.swarm.service.name=swarmy_controller --format '{{.Image}}'`);
      const imgs = running.split('\n').filter(Boolean);
      return imgs.length > 0 && imgs.every((i) => i.includes(digests.controller) || i.includes(nextTag)) && (await c.controllerHealthy());
    },
    { timeoutMs: 10 * 60_000, intervalMs: 5000 },
  );

  await ctx.connect(ctx.password || undefined);
  const after = (await ctx.sdk.nodes.list({ limit: 100 })).data;
  assert(after.length === beforeNodes, `node count changed across upgrade: ${beforeNodes} → ${after.length}`);
  await poll('nodes online after upgrade', async () => (await ctx.sdk.nodes.list({ limit: 100 })).data.every((n) => n.status === 'online'), {
    timeoutMs: 5 * 60_000,
    intervalMs: 5000,
  });
  const svc = (await ctx.sdk.services.list({ limit: 200 })).data.find((x) => x.name === `${stack}_web`);
  assert(svc && svc.replicas.running >= 1, `${stack}_web lost across the upgrade`);
  await ctx.sdk.stacks.remove(stack).catch(() => {});
  const afterVersion = await (await fetch(`${c.controllerUrl}/version`)).text().catch(() => '?');
  const commitOf = (v: string) => /"commit":"([^"]+)"/.exec(v)?.[1] ?? v.slice(0, 20);
  return `${how}: ${commitOf(beforeVersion)} → ${commitOf(afterVersion)} (${digests.controller.slice(0, 19)}); login, API key, ${after.length} nodes and a stack survived`;
}

/**
 * The Settings → Platform button: sign a manifest for the next images with a
 * throwaway key, make the controller trust it, import, start, poll to done.
 */
async function upgradeViaButton(ctx: Ctx, nextTag: string, digests: { controller: string; agent: string }) {
  const c = ctx.cluster;
  const dir = join(c.cfg.workDir, `release-${ctx.runId}`);
  mkdirSync(dir, { recursive: true });
  const key = join(dir, 'k.pem');
  await must(['openssl', 'genpkey', '-algorithm', 'EC', '-pkeyopt', 'ec_paramgen_curve:P-256', '-out', key]);
  const pub = await must(['openssl', 'pkey', '-in', key, '-pubout']);
  const version = `0.0.1-e2e.${Date.now()}`;
  const reg = await c.registryHost();
  const out = join(dir, 'platform.json');
  await must(
    [
      'bun', join(c.srcDir, 'scripts/platform-manifest.ts'),
      '--version', version, '--channel', 'stable', '--commit', c.commit.replace(/-dirty$/, ''),
      '--digest', `controller=${digests.controller}`, '--digest', `agent=${digests.agent}`,
      '--image', `controller=${reg}/swarmy-controller`, '--image', `agent=${reg}/swarmy-agent`,
      '--sign-key', key, '--out', out,
    ],
    { cwd: c.srcDir },
    'platform-manifest.ts',
  );
  // Trust the throwaway key (the stack file doesn't pass it through yet).
  await c.mustSh(c.manager, 'umask 077; cat > /root/.swarmy-release.pub', { input: pub });
  await c.mustSh(
    c.manager,
    `docker service update --quiet --detach=false --env-add SWARMY_RELEASE_PUBKEY="$(cat /root/.swarmy-release.pub)" swarmy_controller >/dev/null`,
    { timeoutMs: 10 * 60_000 },
    'trust release key',
  );
  await poll('controller healthy with the release key', () => c.controllerHealthy(), { timeoutMs: 5 * 60_000, intervalMs: 3000 });
  await ctx.connect(ctx.password || undefined);

  const manifest = readFileSync(out, 'utf8');
  const signature = readFileSync(`${out}.sig`, 'utf8');
  await ctx.m('platform.importRelease', { manifest, signature });
  const started = await ctx.m<{ id?: string; run?: { id: string } }>('platform.start', { version, skipBackup: true });
  log(`platform.start → ${JSON.stringify(started).slice(0, 200)}`);

  let lastSteps = '';
  const final = await poll(
    'platform upgrade run finished',
    async () => {
      let st: any;
      try {
        st = await ctx.q('platform.status');
      } catch {
        // The controller restarts mid-run: reconnect and keep polling.
        await ctx.connect(ctx.password || undefined).catch(() => {});
        return null;
      }
      const run = st?.run;
      const steps = (run?.steps ?? []).map((x: any) => `${x.key}=${x.status}`).join(' ');
      if (steps !== lastSteps) log(`run ${run?.status}: ${(lastSteps = steps)}`);
      if (run?.status === 'failed' || run?.status === 'cancelled') {
        const bad = (run.steps ?? []).find((x: any) => x.status === 'failed');
        throw new Fatal(`upgrade run ${run.status}: ${run.error ?? ''} ${bad ? `(${bad.key}: ${bad.error ?? bad.detail ?? ''})` : ''}`);
      }
      return run?.status === 'done' ? st : null;
    },
    { timeoutMs: 20 * 60_000, intervalMs: 5000 },
  );
  assert(final.release?.current?.version === version, `current release is ${final.release?.current?.version}, want ${version}`);
  return `platform.start (${version})`;
}

// ── 11. teardown ───────────────────────────────────────────────────────────
export async function teardown(ctx: Ctx) {
  const c = ctx.cluster;
  c.stopFileServer();
  if (ctx.opts.keep) {
    throw new Skip(`--keep: cluster left up (${c.nodes.map((n) => `${n.name}=${n.ip}`).join(' ')}); controller ${c.controllerUrl}`);
  }
  // Revoke the harness's API key first (proves revoke works, leaves nothing live).
  if (ctx.apiKeyId) {
    await ctx.m('apiKeys.revoke', { id: ctx.apiKeyId }).catch(() => {});
    const r = await fetch(`${ctx.url}/api/v1/nodes`, { headers: { authorization: `Bearer ${ctx.apiKey}` } }).catch(() => null);
    assert(!r || r.status === 401, `revoked API key still accepted (HTTP ${r?.status})`);
  }
  await c.destroyAll();
  // The harness registry and its volume (only what this harness created).
  await run(['docker', 'rm', '-f', '-v', `${c.cfg.prefix}-registry`]);
  if (c.provider.kind === 'dind') await run(['docker', 'network', 'rm', 'swarmy-e2e']);
  const left = await c.provider.list(`${c.cfg.prefix}-`);
  assert(left.filter((n) => !n.endsWith('-registry')).length === 0, `nodes left behind: ${left.join(', ')}`);
  return 'API key revoked; nodes + harness registry deleted';
}
