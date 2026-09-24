-- Notification channels: Discord, Telegram, ntfy and Gotify (launch-blocker #6).
-- AlterEnum
ALTER TYPE "NotificationChannelKind" ADD VALUE 'DISCORD';
ALTER TYPE "NotificationChannelKind" ADD VALUE 'TELEGRAM';
ALTER TYPE "NotificationChannelKind" ADD VALUE 'NTFY';
ALTER TYPE "NotificationChannelKind" ADD VALUE 'GOTIFY';

-- Default alert rules are deletable: a deleted default leaves an opt-out
-- tombstone so the per-org seed never re-creates it.
-- AlterTable
ALTER TABLE "alert_rule" ADD COLUMN "optedOutAt" TIMESTAMPTZ(3);
