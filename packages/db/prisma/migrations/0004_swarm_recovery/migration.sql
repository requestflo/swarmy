-- Swarm quorum recovery tooling (roadmap WS2).
--
-- SwarmConfig gains the encrypted autolock unlock key (`SWMKEY-…`), stored
-- next to the join tokens it already holds. Null means autolock is off or the
-- operator chose to store the key themselves (setAutolock { storeKey: false }).

-- AlterTable
ALTER TABLE "swarm_config" ADD COLUMN "unlockKeyEnc" TEXT;
