/**
 * The checks an ingress settings patch must pass before anything is written
 * — pure. Every field is judged and EVERY reason is collected, so a refusal
 * names each field that failed, not just the first; nothing is written when
 * there is any. The refusal is one BAD_REQUEST carrying `fieldErrors`
 * (tRPC `data.fieldErrors`, REST `invalid_params`).
 */
import { TRPCError } from '@trpc/server';
import { normalizeAutoAddressBase } from '@swarmy/ingress';
import {
  IngressSettingsPatchSchema,
  type CurrentIngressFacts,
  type IngressPatchField,
  type IngressSettingsPatch,
} from './ingress-settings.schema';

/** One refused field (`tls.onDemand`, `tunnel.runToken`, …) and why. */
export interface IngressFieldIssue {
  field: string;
  message: string;
}

const SHAPE = IngressSettingsPatchSchema.shape;

/**
 * Parse an untrusted patch field by field: the fields that parse form the
 * patch, every other one becomes an issue (unknown fields too — the patch is
 * strict).
 */
export function parseIngressFields(input: unknown): { patch: IngressSettingsPatch; issues: IngressFieldIssue[] } {
  if (input === undefined || input === null) return { patch: {}, issues: [] };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { patch: {}, issues: [{ field: 'patch', message: 'Expected an object of ingress settings' }] };
  }
  const patch: Record<string, unknown> = {};
  const issues: IngressFieldIssue[] = [];
  for (const [key, value] of Object.entries(input)) {
    const schema = SHAPE[key as IngressPatchField];
    if (!schema) {
      issues.push({ field: key, message: 'Not an ingress setting' });
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) {
      if (parsed.data !== undefined) patch[key] = parsed.data;
      continue;
    }
    for (const issue of parsed.error.issues) issues.push({ field: [key, ...issue.path].join('.'), message: issue.message });
  }
  return { patch: patch as IngressSettingsPatch, issues };
}

/**
 * The cross-field checks, judged on the settings AFTER the patch. `tunnelId`
 * is what the patch's run token decodes to (null = not a tunnel token).
 * Fields the patch leaves alone are never judged, so an unrelated write
 * can't fail on them.
 */
export function ingressRuleIssues(
  patch: IngressSettingsPatch,
  current: CurrentIngressFacts,
  tunnelId: string | null,
): IngressFieldIssue[] {
  const issues: IngressFieldIssue[] = [];
  if (patch.tls) {
    const onDemand = patch.tls.onDemand ?? current.onDemand;
    const email = patch.tls.acmeEmail !== undefined ? patch.tls.acmeEmail : current.acmeEmail;
    const ask = patch.tls.askUrl !== undefined ? patch.tls.askUrl : current.askUrl;
    if (onDemand && !email && !ask) {
      issues.push({ field: 'tls.onDemand', message: 'on-demand TLS requires an ACME email or an ask endpoint' });
    }
  }
  if (patch.tunnel?.runToken && !tunnelId) {
    issues.push({
      field: 'tunnel.runToken',
      message: 'That doesn’t look like a Cloudflare tunnel token — copy it from the tunnel’s install command.',
    });
  }
  if (patch.tunnel && !patch.tunnel.runToken && !current.tunnelConfigured) {
    issues.push({ field: 'tunnel.runToken', message: 'Connect the tunnel with its run token first.' });
  }
  if (patch.geoip?.mode === 'file' && !patch.geoip.path) {
    issues.push({ field: 'geoip.path', message: 'a file path is required for the file mode' });
  }
  const base = patch.autoAddressBase;
  if (base && base.trim() !== '' && !normalizeAutoAddressBase(base)) {
    issues.push({
      field: 'autoAddressBase',
      message: `${base} is not a domain name — use a wildcard-IP DNS service such as sslip.io or nip.io`,
    });
  }
  return issues;
}

/**
 * The one refusal for a patch with issues. A lone rule keeps its plain
 * sentence (what the dashboard shows); otherwise every field and its reason.
 */
export function invalidIngressSettings(schemaIssues: IngressFieldIssue[], ruleIssues: IngressFieldIssue[]): TRPCError {
  const all = [...schemaIssues, ...ruleIssues];
  const message =
    schemaIssues.length === 0 && ruleIssues.length === 1
      ? ruleIssues[0]!.message
      : `invalid ingress settings: ${all.map((i) => `${i.field}: ${i.message}`).join('; ')}`;
  return new TRPCError({ code: 'BAD_REQUEST', message, cause: { fieldErrors: all } });
}
