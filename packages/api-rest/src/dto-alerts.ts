/**
 * Public DTOs for alert rules (`/alert-rules`). snake_case, decoupled from the
 * `@swarmy/core` views; `mappers-alerts.ts` absorbs the translation. Request
 * bodies are re-checked with the tRPC procedure's own input schema in the
 * route (`parseWith`), so both front doors accept exactly the same rules.
 */
import { z } from '@hono/zod-openapi';
import { ALERT_SIGNALS } from '@swarmy/core';
import { listEnvelope } from './dto';

export const AlertSignalDto = z.enum(ALERT_SIGNALS).openapi('AlertSignal', {
  description: 'What the rule watches. Open enum: new signals may be added.',
});

const targetName = z.string().trim().min(1).max(128);

export const AlertSelectorDto = z
  .object({
    app: targetName.optional().openapi({ description: 'App (stack) name — app signals.' }),
    server: targetName.optional().openapi({ description: 'Server (node) name — server signals.' }),
    service: targetName.optional().openapi({ description: 'Part (service short name) inside `app`; needs `app`.' }),
  })
  .strict()
  .openapi('AlertSelector', { description: 'What the rule is narrowed to. Empty = any subject of the signal.' });

const threshold = z.number().finite().openapi({
  format: 'double',
  description: 'The signal’s threshold (percent, count, days, … per signal). Null = the signal has none.',
});

export const AlertRuleDto = z
  .object({
    id: z.string(),
    name: z.string(),
    signal: AlertSignalDto,
    selector: AlertSelectorDto,
    threshold: threshold.nullable(),
    for_seconds: z.number().int().openapi({ description: 'How long the condition must hold before it fires.' }),
    channel_ids: z.array(z.string()).openapi({ description: 'Notification channels it sends to.' }),
    enabled: z.boolean(),
    is_default: z.boolean().openapi({ description: 'One of the seeded per-signal rules (deleting it opts the org out).' }),
    muted_until: z.string().nullable().openapi({ description: 'Muted (records, sends nothing) until then; null = not muted.' }),
    created_at: z.string(),
  })
  .openapi('AlertRule');

export const AlertRuleList = listEnvelope(AlertRuleDto, 'AlertRuleList');

const forSeconds = z.number().int().min(0).max(86_400);
const channelIds = z.array(z.string().min(1)).max(50);

export const CreateAlertRuleBody = z
  .object({
    name: z.string().min(1).max(120),
    signal: AlertSignalDto,
    selector: AlertSelectorDto.optional(),
    threshold: threshold.nullable().optional(),
    for_seconds: forSeconds.optional().openapi({ description: 'Default 0.' }),
    channel_ids: channelIds.optional(),
    enabled: z.boolean().optional().openapi({ description: 'Default true.' }),
  })
  .openapi('CreateAlertRuleRequest');

export const UpdateAlertRuleBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    selector: AlertSelectorDto.optional().openapi({ description: 'Replaces the target; `{}` = any.' }),
    threshold: threshold.nullable().optional(),
    for_seconds: forSeconds.optional(),
    channel_ids: channelIds.optional().openapi({ description: 'Replaces the channel set.' }),
    enabled: z.boolean().optional(),
  })
  .openapi('UpdateAlertRuleRequest', { description: 'Fields left out keep their value; the signal never changes.' });
