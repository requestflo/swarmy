/**
 * Email service router (epic developer-platform §8). Reads are org-scoped;
 * every mutation goes through the policy seam: `email.write` (owner/admin by
 * default) for configuration, `email.send` for the test send, `secrets.read`
 * to reveal a credential. The services write the domain audit rows.
 */
import { z } from 'zod';
import { orgProcedure, router } from '../trpc';
import { abacProcedure } from '../abac';
import {
  addEmailDomain,
  addSuppression,
  checkEmailDomain,
  createEmailCredential,
  emailOverview,
  emailSendLog,
  listEmailTemplates,
  listSuppressions,
  probePort25,
  removeEmailCredential,
  removeEmailDomain,
  removeEmailTemplate,
  removeSuppression,
  revealEmailCredential,
  rotateDkimKey,
  saveEmailTemplate,
  sendTestEmail,
  setEmailEnabled,
  setEmailSettings,
  setInboundToken,
  updateEmailCredential,
  updateEmailDomain,
} from '../services/email.service';

const Relay = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['tls', 'starttls', 'none']),
  username: z.string().max(256).nullish(),
  /** Write-only; omit to keep the stored one. */
  password: z.string().max(1024).nullish(),
  spfInclude: z.string().max(253).nullish(),
});
const Dmarc = z.enum(['none', 'quarantine', 'reject']);
const Id = z.object({ id: z.string().min(1) });
const EVENTS = ['queued', 'accepted', 'rejected', 'delivered', 'deferred', 'failed', 'bounced', 'complained'] as const;

export const emailRouter = router({
  overview: orgProcedure.query(({ ctx }) => emailOverview(ctx)),

  setEnabled: abacProcedure('email.write')
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => setEmailEnabled(ctx, input.enabled)),

  setSettings: abacProcedure('email.write')
    .input(z.object({ logBodies: z.boolean().optional(), systemDomainId: z.string().nullish() }))
    .mutation(({ ctx, input }) => setEmailSettings(ctx, input)),

  setInbound: abacProcedure('email.write')
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ ctx, input }) => setInboundToken(ctx, input.enabled)),

  addDomain: abacProcedure('email.write')
    .input(
      z.object({
        domain: z.string().min(3).max(253),
        delivery: z.enum(['direct', 'relay']),
        relay: Relay.nullish(),
        dmarcPolicy: Dmarc.optional(),
      }),
    )
    .mutation(({ ctx, input }) => addEmailDomain(ctx, input)),

  updateDomain: abacProcedure('email.write')
    .input(Id.extend({ delivery: z.enum(['direct', 'relay']).optional(), relay: Relay.nullish(), dmarcPolicy: Dmarc.optional() }))
    .mutation(({ ctx, input }) => {
      const { id, ...rest } = input;
      return updateEmailDomain(ctx, id, rest);
    }),

  removeDomain: abacProcedure('email.write').input(Id).mutation(({ ctx, input }) => removeEmailDomain(ctx, input.id)),
  rotateDkim: abacProcedure('email.write').input(Id).mutation(({ ctx, input }) => rotateDkimKey(ctx, input.id)),
  /** Re-check DNS now (a read of DNS, but it may flip the verification gate). */
  checkDomain: abacProcedure('email.write').input(Id).mutation(({ ctx, input }) => checkEmailDomain(ctx, input.id)),
  probePort25: abacProcedure('email.write').mutation(({ ctx }) => probePort25(ctx)),

  createCredential: abacProcedure('email.write')
    .input(
      z.object({
        name: z.string().min(1).max(40),
        domains: z.array(z.string().max(253)).max(50).optional(),
        webhookUrl: z.string().url().max(2048).nullish(),
      }),
    )
    .mutation(({ ctx, input }) => createEmailCredential(ctx, input)),

  updateCredential: abacProcedure('email.write')
    .input(
      Id.extend({
        domains: z.array(z.string().max(253)).max(50).optional(),
        webhookUrl: z.string().url().max(2048).nullish(),
        disabled: z.boolean().optional(),
      }),
    )
    .mutation(({ ctx, input }) => {
      const { id, ...rest } = input;
      return updateEmailCredential(ctx, id, rest);
    }),

  removeCredential: abacProcedure('email.write').input(Id).mutation(({ ctx, input }) => removeEmailCredential(ctx, input.id)),
  revealCredential: abacProcedure('secrets.read').input(Id).mutation(({ ctx, input }) => revealEmailCredential(ctx, input.id)),

  templates: orgProcedure.query(({ ctx }) => listEmailTemplates(ctx)),
  saveTemplate: abacProcedure('email.write')
    .input(z.object({ name: z.string().min(1).max(64), subject: z.string().min(1).max(998), html: z.string().max(512 * 1024).nullish(), text: z.string().max(512 * 1024).nullish() }))
    .mutation(({ ctx, input }) => saveEmailTemplate(ctx, input)),
  removeTemplate: abacProcedure('email.write').input(Id).mutation(({ ctx, input }) => removeEmailTemplate(ctx, input.id)),

  suppressions: orgProcedure
    .input(z.object({ search: z.string().max(254).optional(), limit: z.number().int().min(1).max(500).optional() }).optional())
    .query(({ ctx, input }) => listSuppressions(ctx, input ?? {})),
  addSuppression: abacProcedure('email.write')
    .input(z.object({ address: z.string().min(3).max(254) }))
    .mutation(({ ctx, input }) => addSuppression(ctx, input.address)),
  removeSuppression: abacProcedure('email.write').input(Id).mutation(({ ctx, input }) => removeSuppression(ctx, input.id)),

  log: orgProcedure
    .input(
      z
        .object({
          search: z.string().max(254).optional(),
          event: z.enum(EVENTS).optional(),
          credential: z.string().max(128).optional(),
          before: z.string().max(40).optional(),
          limit: z.number().int().min(1).max(500).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) => emailSendLog(ctx, input ?? {})),

  testSend: abacProcedure('email.send')
    .input(z.object({ from: z.string().min(3).max(320), to: z.string().min(3).max(320) }))
    .mutation(({ ctx, input }) => sendTestEmail(ctx, input)),
});
