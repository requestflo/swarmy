-- CreateTable
CREATE TABLE "user_preference" (
    "userId" TEXT NOT NULL PRIMARY KEY,
    "depth" TEXT,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "user_preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
