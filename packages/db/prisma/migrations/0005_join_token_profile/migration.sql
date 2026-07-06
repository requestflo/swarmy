-- Install profiles (roadmap WS7).
--
-- JoinToken gains an optional profile — the label bundle stamped onto nodes
-- enrolled with the token ('edge' | 'storage' | 'database' | 'private-mesh').
-- Null means the default profile (no bundled labels).

-- AlterTable
ALTER TABLE "join_token" ADD COLUMN "profile" TEXT;
