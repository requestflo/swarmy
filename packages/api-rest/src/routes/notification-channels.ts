import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  createNotificationChannel,
  deleteNotificationChannel,
  getNotificationChannel,
  listNotificationChannels,
  resolveConfigRow,
  updateNotificationChannel,
} from '@swarmy/trpc';
import type { RestEnv } from '../middleware';
import { requireAction, requireScope } from '../middleware';
import { RemovedDto } from '../dto';
import {
  CreateNotificationChannelBody,
  NotificationChannelDto,
  NotificationChannelList,
  UpdateNotificationChannelBody,
} from '../dto-channels';
import { createChannelInput, notificationChannelToDto, updateChannelInput } from '../mappers-alerts';
import { idParam, jsonBody, jsonRes, problemRes } from '../route-kit';
import { run } from '../respond';

/**
 * Notification channels (`/v1/notification-channels`) over `alerts.service` —
 * the twins of tRPC `alerts.channels|createChannel|updateChannel|
 * deleteChannel`. The destination is write-only: stored vault-encrypted by the
 * service exactly as the dashboard stores it; reads return the redacted
 * target only. A delete runs the `alert.remove` policy step.
 */

const TAG = 'Notification Channels';
const sec = [{ bearerApiKey: [] }];

export function registerNotificationChannelRoutes(app: OpenAPIHono<RestEnv>): void {
  app.openapi(
    createRoute({
      method: 'get', path: '/notification-channels', tags: [TAG], security: sec,
      summary: 'List notification channels (destinations are never returned)',
      middleware: [requireScope('read')] as const,
      responses: { 200: jsonRes(NotificationChannelList, 'Channels'), 401: problemRes },
    }),
    (c) =>
      run(c, async () => ({
        data: (await listNotificationChannels(c.get('orgCtx'))).map(notificationChannelToDto),
        next_cursor: null,
      })),
  );

  app.openapi(
    createRoute({
      method: 'get', path: '/notification-channels/{id}', tags: [TAG], security: sec,
      summary: 'Get one notification channel',
      middleware: [requireScope('read')] as const,
      request: { params: idParam },
      responses: { 200: jsonRes(NotificationChannelDto, 'Channel'), 404: problemRes },
    }),
    (c) =>
      run(c, async () =>
        notificationChannelToDto(await getNotificationChannel(c.get('orgCtx'), c.req.valid('param').id)),
      ),
  );

  app.openapi(
    createRoute({
      method: 'post', path: '/notification-channels', tags: [TAG], security: sec,
      summary: 'Add a notification channel (email, Slack, Teams, Discord, Telegram, ntfy, Gotify, webhook)',
      middleware: [requireScope('write')] as const,
      request: { body: jsonBody(CreateNotificationChannelBody) },
      responses: { 201: jsonRes(NotificationChannelDto, 'Created'), 400: problemRes, 403: problemRes },
    }),
    (c) =>
      run(
        c,
        async () =>
          notificationChannelToDto(
            await createNotificationChannel(c.get('orgCtx'), createChannelInput(c.req.valid('json'))),
          ),
        201,
      ),
  );

  app.openapi(
    createRoute({
      method: 'patch', path: '/notification-channels/{id}', tags: [TAG], security: sec,
      summary: 'Rename, enable/disable or repoint a notification channel',
      middleware: [requireScope('write')] as const,
      request: { params: idParam, body: jsonBody(UpdateNotificationChannelBody) },
      responses: { 200: jsonRes(NotificationChannelDto, 'Updated'), 400: problemRes, 404: problemRes },
    }),
    (c) =>
      run(c, async () =>
        notificationChannelToDto(
          await updateNotificationChannel(
            c.get('orgCtx'),
            updateChannelInput(c.req.valid('param').id, c.req.valid('json')),
          ),
        ),
      ),
  );

  app.openapi(
    createRoute({
      method: 'delete', path: '/notification-channels/{id}', tags: [TAG], security: sec,
      summary: 'Remove a notification channel',
      middleware: [
        requireScope('write'),
        requireAction('alert.remove', resolveConfigRow('notificationChannel')),
      ] as const,
      request: { params: idParam },
      responses: { 200: jsonRes(RemovedDto, 'Deleted'), 403: problemRes, 404: problemRes },
    }),
    (c) =>
      run(c, async () => {
        const id = c.req.valid('param').id;
        await deleteNotificationChannel(c.get('orgCtx'), { id });
        return { id, removed: true as const };
      }),
  );
}
