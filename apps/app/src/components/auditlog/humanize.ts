import type { AuditEntryView } from '@swarmy/core';
import type { StatusTone } from '@swarmy/ui';

/**
 * Turn dotted audit action names into short human sentences for the timeline
 * ("deployed stack storefront", "rotated secret stripe-api-key") plus a status
 * tone so destructive actions read hot at a glance.
 */

/** Exact action → verb phrase (the target is appended by `humanizeAction`). */
const EXACT: Record<string, string> = {
  'stack.deploy': 'deployed stack',
  'stack.deploy.override': 'deployed stack (override)',
  'service.builder.deploy': 'deployed service',
  'templates.deploy': 'deployed template',
  'cicd.autodeploy': 'auto-deployed',
  'cicd.triggerBuild': 'triggered a build for',
  'release.rollback': 'rolled back',
  'secrets.create': 'created secret',
  'secrets.rotate': 'rotated secret',
  'secrets.attach': 'attached secret',
  'secrets.detach': 'detached secret',
  'secrets.delete': 'deleted secret',
  'configs.create': 'created config',
  'configs.newVersion': 'edited config',
  'configs.apply': 'applied config',
  'terminal.open': 'opened a terminal on',
  'terminal.kill': 'killed terminal session',
  'policy.create': 'created policy',
  'policy.update': 'updated policy',
  'policy.delete': 'deleted policy',
  'backup.run': 'backed up',
  'backup.restore': 'restored',
  'db.backup': 'backed up database',
  'db.restore': 'restored database',
  'controller.backup.run': 'backed up the controller for',
  'apiKey.create': 'created API key',
  'apiKey.revoke': 'revoked API key',
  'audit.export': 'exported the audit log',
  'audit.retention.set': 'changed audit retention for',
  'alert.fire': 'raised alert',
  'alert.resolve': 'resolved alert',
};

/** camelCase / dotted tail → spaced words ("retryFailed" → "retry failed"). */
function words(segment: string): string {
  return segment.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
}

/** Verb phrase for an action; falls back to "<area>: <tail words>". */
export function actionPhrase(action: string): string {
  const exact = EXACT[action];
  if (exact) return exact;
  const parts = action.split('.');
  if (parts.length === 1) return words(action);
  const tail = parts.slice(1).map(words).join(' ');
  return `${parts[0]}: ${tail}`;
}

/** Full sentence for a row (no actor — the row shows the actor separately). */
export function humanizeAction(e: AuditEntryView): string {
  const phrase = actionPhrase(e.action);
  return e.targetId ? `${phrase} ${e.targetId}` : phrase;
}

const DESTRUCTIVE = /\b(delete|remove|revoke|kill|destroy|blocked|failed|deny)/i;
const CREATIVE = /\b(create|deploy|add|register|enable|restore|join)/i;
const MUTATIVE = /\b(update|set|rotate|scale|apply|edit|toggle|override)/i;

/** Status tone for the action chip: hot for destructive, calm for reads. */
export function actionTone(action: string): StatusTone {
  if (DESTRUCTIVE.test(action)) return 'offline';
  if (CREATIVE.test(action)) return 'online';
  if (MUTATIVE.test(action)) return 'progress';
  return 'neutral';
}
