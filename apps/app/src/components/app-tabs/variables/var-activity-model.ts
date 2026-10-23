import type { AuditEntryView } from '@swarmy/core';
import type { Tone } from '@/components/calm';

/** The audit prefixes the feed asks for: every secret event, and service updates that set secret variables. */
export const VAR_AUDIT_ACTIONS = ['secrets.', 'service.deploy'];

export interface AppScope {
  /** Live service ids and swarm names of the app. */
  serviceIds: ReadonlySet<string>;
  serviceNames: ReadonlySet<string>;
  /** Secret families the app reads (or that were made from its workspace). */
  families: ReadonlySet<string>;
  stack: string;
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);

/** Is this audit row about this app's variables or secrets? */
export function aboutApp(e: AuditEntryView, s: AppScope): boolean {
  const m = e.metadata;
  const service = str(m.service);
  const onService = (e.targetType === 'service' && !!e.targetId && (s.serviceIds.has(e.targetId) || s.serviceNames.has(e.targetId))) || (!!service && s.serviceNames.has(service));
  if (e.action === 'service.deploy') return onService && m.update === true && !!m.secretVars;
  if (!e.action.startsWith('secrets.')) return false;
  const family = e.targetType === 'secretFamily' || e.targetType === 'secret' ? e.targetId : null;
  return onService || (!!family && s.families.has(family)) || m.stack === s.stack;
}

const short = (name: string | null, stack: string): string => (name && name.startsWith(`${stack}_`) ? name.slice(stack.length + 1) : (name ?? 'a service'));

/** One plain sentence per event, never a value. */
export function describeEvent(e: AuditEntryView, stack: string): { text: string; tone: Tone } {
  const m = e.metadata;
  const who = e.actorLabel;
  const svc = short(str(m.service), stack);
  const what = e.targetId ?? 'a secret';
  switch (e.action) {
    case 'secrets.rotate': {
      const n = Array.isArray(m.redeployed) ? m.redeployed.length : null;
      return { text: `${who} rotated ${what}${n ? ` · ${n} ${n === 1 ? 'service' : 'services'} restarted` : ''}`, tone: 'ok' };
    }
    case 'secrets.reveal':
      return { text: `${who} revealed ${str(m.key) ?? 'a secret'} on ${svc}${m.ok === false ? ' · it could not be read' : ' · on the audit log'}`, tone: 'warn' };
    case 'secrets.appVar.set':
      return { text: `${who} set ${str(m.key) ?? 'a secret'} on ${svc}${m.rotated ? ` · v${String(m.version)}` : ''}`, tone: 'ok' };
    case 'secrets.appVar.remove':
      return { text: `${who} removed ${str(m.key) ?? 'a secret'} from ${svc}`, tone: 'idle' };
    case 'secrets.create':
      return { text: `${who} created ${what}`, tone: 'ok' };
    case 'secrets.attach':
      return { text: `${who} gave ${svc} ${what}`, tone: 'ok' };
    case 'secrets.detach':
      return { text: `${who} took ${what} off ${svc}`, tone: 'idle' };
    case 'secrets.delete':
      return { text: `${who} deleted ${what}`, tone: 'bad' };
    case 'secrets.pruneVersions':
      return { text: `${who} pruned old versions of ${what}`, tone: 'idle' };
    case 'service.deploy':
      return { text: `${who} changed secret variables on ${short(e.targetId, stack)}`, tone: 'ok' };
    default:
      return { text: `${who} · ${e.action}`, tone: 'idle' };
  }
}
