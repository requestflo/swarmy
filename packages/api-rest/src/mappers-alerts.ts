/**
 * Alert rules + notification channels: view → DTO (camel → snake) and request
 * body → the tRPC procedure's input, parsed with that procedure's own schema
 * (`@swarmy/core` inputs) so defaults and refusals match the dashboard's.
 */
import type { z } from '@hono/zod-openapi';
import {
  CreateAlertRuleInput,
  CreateChannelInput,
  UpdateAlertRuleInput,
  UpdateChannelInput,
  type AlertRuleView,
  type NotificationChannelView,
} from '@swarmy/core';
import type { AlertRuleDto, CreateAlertRuleBody, UpdateAlertRuleBody } from './dto-alerts';
import type {
  CreateNotificationChannelBody,
  NotificationChannelConfigDto,
  NotificationChannelDto,
  UpdateNotificationChannelBody,
} from './dto-channels';
import { parseWith } from './route-kit';

export function alertRuleToDto(v: AlertRuleView): z.infer<typeof AlertRuleDto> {
  return {
    id: v.id,
    name: v.name,
    signal: v.signal as z.infer<typeof AlertRuleDto>['signal'],
    selector: { ...v.selector },
    threshold: v.threshold,
    for_seconds: v.forSeconds,
    channel_ids: v.channelIds,
    enabled: v.enabled,
    is_default: v.isDefault,
    muted_until: v.mutedUntil,
    created_at: v.createdAt,
  };
}

/** Drop the keys a body left out, so the core schema sees "not given". */
function given<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function createAlertRuleInput(b: z.infer<typeof CreateAlertRuleBody>): CreateAlertRuleInput {
  return parseWith(
    CreateAlertRuleInput,
    given({
      name: b.name,
      signal: b.signal,
      selector: b.selector,
      threshold: b.threshold,
      forSeconds: b.for_seconds,
      channelIds: b.channel_ids,
      enabled: b.enabled,
    }),
  );
}

export function updateAlertRuleInput(id: string, b: z.infer<typeof UpdateAlertRuleBody>): UpdateAlertRuleInput {
  return parseWith(
    UpdateAlertRuleInput,
    given({
      id,
      name: b.name,
      selector: b.selector,
      threshold: b.threshold,
      forSeconds: b.for_seconds,
      channelIds: b.channel_ids,
      enabled: b.enabled,
    }),
  );
}

export function notificationChannelToDto(v: NotificationChannelView): z.infer<typeof NotificationChannelDto> {
  return {
    id: v.id,
    name: v.name,
    kind: v.kind,
    enabled: v.enabled,
    target: v.target,
    has_secret: v.hasSecret,
    created_at: v.createdAt,
  };
}

/** The destination as the core `ChannelConfigInput` union expects it (camelCase). */
function channelConfig(c: z.infer<typeof NotificationChannelConfigDto>): Record<string, unknown> {
  return given({
    kind: c.kind,
    to: c.to,
    url: c.url,
    secret: c.secret,
    botToken: c.bot_token,
    chatId: c.chat_id,
    threadId: c.thread_id,
    server: c.server,
    topic: c.topic,
    token: c.token,
  });
}

export function createChannelInput(b: z.infer<typeof CreateNotificationChannelBody>): CreateChannelInput {
  return parseWith(CreateChannelInput, { name: b.name, config: channelConfig(b.config) });
}

export function updateChannelInput(id: string, b: z.infer<typeof UpdateNotificationChannelBody>): UpdateChannelInput {
  return parseWith(
    UpdateChannelInput,
    given({ id, name: b.name, enabled: b.enabled, config: b.config ? channelConfig(b.config) : undefined }),
  );
}
