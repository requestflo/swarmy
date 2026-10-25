/**
 * Public DTOs for notification channels (`/notification-channels`). The
 * destination (`config`) is WRITE-ONLY: accepted on create/update, stored
 * vault-encrypted exactly as the dashboard stores it, and never returned —
 * a read carries only the redacted `target` and whether a secret is set.
 */
import { z } from '@hono/zod-openapi';
import { NOTIFICATION_CHANNEL_KINDS } from '@swarmy/core';
import { listEnvelope } from './dto';

export const NotificationChannelKindDto = z.enum(NOTIFICATION_CHANNEL_KINDS).openapi('NotificationChannelKind', {
  description: 'Where the channel delivers. Open enum: new kinds may be added.',
});

export const NotificationChannelDto = z
  .object({
    id: z.string(),
    name: z.string(),
    kind: NotificationChannelKindDto,
    enabled: z.boolean(),
    target: z.string().openapi({ description: 'Redacted destination (an email address or a host). Never a secret.' }),
    has_secret: z.boolean().openapi({ description: 'A signing secret or token is stored (webhook secret, ntfy/gotify/telegram token).' }),
    created_at: z.string(),
  })
  .openapi('NotificationChannel');

export const NotificationChannelList = listEnvelope(NotificationChannelDto, 'NotificationChannelList');

/** The fields each kind takes; the rest are ignored. Write-only. */
export const NotificationChannelConfigDto = z
  .object({
    kind: NotificationChannelKindDto,
    to: z.string().max(320).optional().openapi({ description: '`email`: the address.' }),
    url: z.string().max(1024).optional().openapi({ description: '`slack`, `teams`, `discord`, `webhook`: the incoming-webhook URL.' }),
    secret: z.string().max(256).optional().openapi({ description: '`webhook`: optional HMAC secret (8+ characters); deliveries are signed.' }),
    bot_token: z.string().max(256).optional().openapi({ description: '`telegram`: the BotFather token (`123456:ABC…`).' }),
    chat_id: z.string().max(128).optional().openapi({ description: '`telegram`: numeric chat id or `@channel`.' }),
    thread_id: z.number().int().positive().optional().openapi({ description: '`telegram`: forum topic thread.' }),
    server: z.string().max(1024).optional().openapi({ description: '`ntfy`, `gotify`: the server URL.' }),
    topic: z.string().max(64).optional().openapi({ description: '`ntfy`: the topic.' }),
    token: z.string().max(256).optional().openapi({ description: '`ntfy` (optional), `gotify`: the access/app token.' }),
  })
  .openapi('NotificationChannelConfig', {
    description: 'The destination. Write-only: stored encrypted and never returned.',
  });

export const CreateNotificationChannelBody = z
  .object({
    name: z.string().min(1).max(120),
    config: NotificationChannelConfigDto,
  })
  .openapi('CreateNotificationChannelRequest', { description: 'New channels start enabled.' });

export const UpdateNotificationChannelBody = z
  .object({
    name: z.string().min(1).max(120).optional(),
    enabled: z.boolean().optional(),
    config: NotificationChannelConfigDto.optional().openapi({
      description: 'Replaces the destination (same kind only). Left out keeps it.',
    }),
  })
  .openapi('UpdateNotificationChannelRequest');
