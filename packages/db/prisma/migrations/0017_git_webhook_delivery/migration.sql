-- CreateTable
CREATE TABLE "git_webhook_delivery" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "receivedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "git_webhook_delivery_receivedAt_idx" ON "git_webhook_delivery"("receivedAt");
