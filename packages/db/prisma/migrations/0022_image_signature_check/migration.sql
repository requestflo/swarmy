-- CreateTable
CREATE TABLE "image_signature_check" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "orgId" TEXT NOT NULL,
    "digest" TEXT NOT NULL,
    "imageRef" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "keyName" TEXT,
    "source" TEXT NOT NULL,
    "checkedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "image_signature_check_orgId_fkey" FOREIGN KEY ("orgId") REFERENCES "organization" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "image_signature_check_orgId_digest_checkedAt_idx" ON "image_signature_check"("orgId", "digest", "checkedAt");
