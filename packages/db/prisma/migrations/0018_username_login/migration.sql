-- Email is optional (owner decision 2026-09-24): username sign-in via the
-- Better Auth username plugin. Accounts without email carry a reserved
-- *.swarmy.invalid placeholder in "email".
ALTER TABLE "user" ADD COLUMN "username" TEXT,
ADD COLUMN "displayUsername" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "user_username_key" ON "user"("username");
