/**
 * A control-plane `restore` (a move here, or a restore onto a node that hosted
 * it before): bring the NEWEST state into the `swarmy-mesh-control` volume.
 *
 * It used to restore only into an empty volume and otherwise keep whatever
 * was there, so moving back to a node that hosted the control plane before
 * brought back its stale NetBird state (old peers, old setup keys). Now a
 * one-shot Litestream reads both copies, `chooseRestoreSource` (@swarmy/mesh,
 * pure) picks the newer one, and a restore keeps the replaced files aside in
 * the volume. The choice and its reason come back in plain words.
 *
 * NetBird and its Litestream sidecar must be stopped first (the caller does).
 */
import type { DockerClient } from '@swarmy/core/docker';
import type { MeshControlRestore, MeshControlSpec } from '@swarmy/core/protocol';
import { chooseRestoreSource } from '@swarmy/mesh';
import { runSidecar } from './backup';
import { DATA_DIR, PROBE_SCRIPT, RESTORE_SCRIPT, keptAsName, parseProbe } from './mesh-control-restore-probe';

/** Same name as MESH_CONTROL_VOLUME in mesh-control.ts (kept here to avoid an import cycle). */
const VOLUME = 'swarmy-mesh-control';

const tail = (s: string): string => s.trim().split('\n').slice(-4).join(' ').slice(-600);

function oneShot(spec: MeshControlSpec, script: string, extraEnv: string[], ms: number, what: string) {
  const ls = spec.litestream!;
  return {
    image: ls.image,
    entrypoint: ['sh', '-c', script],
    args: [],
    env: [...Object.entries(ls.env).map(([k, v]) => `${k}=${v}`), `SWARMY_LS_CONFIG=${Buffer.from(ls.configYaml).toString('base64')}`, ...extraEnv],
    binds: [`${VOLUME}:${DATA_DIR}`],
    networkMode: ls.network,
    timeout: { ms, what },
  };
}

export async function restoreNewest(docker: DockerClient, spec: MeshControlSpec, log: (m: string) => void, now = new Date()): Promise<MeshControlRestore> {
  if (!spec.litestream) throw new Error('restore needs a litestream replica');
  const probe = await runSidecar(docker, oneShot(spec, PROBE_SCRIPT, [], 120_000, 'reading the control-plane backup'));
  if (probe.exitCode !== 0) throw new Error(`reading the control-plane backup failed: ${tail(probe.stderr || probe.stdout)}`);
  const choice = chooseRestoreSource(parseProbe(probe.stdout));
  log(`mesh control plane restore: ${choice.reason}`);
  if (choice.use === 'refuse') throw new Error(choice.reason);
  if (choice.use !== 'replica') return { used: choice.use, reason: choice.reason };

  const keepAs = keptAsName(now);
  const r = await runSidecar(docker, { ...oneShot(spec, RESTORE_SCRIPT, [`SWARMY_KEEP_AS=${keepAs}`], 240_000, 'the control-plane restore'), pull: false });
  if (r.exitCode !== 0) {
    const files = r.stdout.includes('@@moving') ? ` Nothing was deleted: files already moved are in ${keepAs} in the ${VOLUME} volume.` : " This server's files were not touched.";
    throw new Error(`restoring the control-plane backup failed: ${tail(r.stderr || r.stdout)}.${files}`);
  }
  const kept = /^@@kept (\S+)/m.exec(r.stdout)?.[1];
  if (!kept) return { used: 'replica', reason: choice.reason };
  return { used: 'replica', reason: `${choice.reason} This server's old copy is kept as ${kept} in the ${VOLUME} volume.`, keptAs: kept };
}
