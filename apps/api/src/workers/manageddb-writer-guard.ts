import type { ServiceSpec } from '@swarmy/core/protocol';
import { planWriterRepair, type WriterRepair, type WriterRepairInput } from './manageddb-writer-repair';

/**
 * The manageddb reconcile's writer guard: each tick, before the topology
 * steps, a writer a promotion left unpinned, or a geo cluster whose writer
 * lost its region declarations, is repaired (the pure
 * `planWriterRepair`, manageddb-writer-repair.ts). It runs before the geo
 * step on purpose: a geo writer without its declarations would have the
 * other region siblings removed that same tick.
 *
 * Signature-gated: one repair is sent once; the same repair is not sent
 * again while the inventory catches up, and a repaired cluster plans nothing.
 * Every repair is audited (`db.writer.repair`, system actor) and goes on the
 * cluster's incident timeline (`db.writer.repair`).
 */

export interface WriterGuardIo {
  deploy(spec: ServiceSpec): Promise<boolean>;
  setLabels(service: string, add: Record<string, string>, removeKeys: string[]): Promise<boolean>;
  audit(metadata: Record<string, unknown>): Promise<unknown>;
  incident(message: string, meta: Record<string, unknown>): Promise<unknown>;
}

/** `${orgId}/${stack}/${cluster}` → the signature of the repair last sent. */
const sent = new Map<string, string>();

/** In plain words, for the timeline. */
export function repairMessage(r: WriterRepair, cluster: string): string {
  const parts: string[] = [];
  if (r.pinnedTo) parts.push(`pinned ${r.writer} to ${r.pinnedTo}, the server its data is on`);
  if (r.restored.length > 0) parts.push(`put the region declarations back on ${r.writer} (${r.restored.join(', ')})`);
  if (r.strip.length > 0) parts.push(`took the writer's declarations off ${r.strip.map((s) => s.service).join(', ')}`);
  return `${cluster}: swarmy ${parts.join('; ')}.`;
}

/** Plan, gate, send, record. Returns the repair it sent (the cluster waits a tick), else null. */
export async function guardWriter(key: string, cluster: string, input: WriterRepairInput, io: WriterGuardIo): Promise<WriterRepair | null> {
  const r = planWriterRepair(input);
  if (!r) {
    sent.delete(key);
    return null;
  }
  if (sent.get(key) === r.signature) return null;
  const relabel = Object.keys(r.add).length + r.removeKeys.length > 0;
  const ok = r.spec ? await io.deploy(r.spec) : !relabel || (await io.setLabels(r.writer, r.add, r.removeKeys));
  if (!ok) return null; // nothing recorded: the next tick tries again
  for (const s of r.strip) await io.setLabels(s.service, {}, s.removeKeys);
  sent.set(key, r.signature);
  const meta = { writer: r.writer, pinnedTo: r.pinnedTo, restored: r.restored, stripped: r.strip.map((s) => s.service) };
  await io.audit(meta);
  await io.incident(repairMessage(r, cluster), meta);
  return r;
}

/** Test seam: forget what was sent. */
export function resetWriterGuard(): void {
  sent.clear();
}
