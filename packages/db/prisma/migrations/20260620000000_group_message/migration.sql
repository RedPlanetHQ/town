-- Per-house group chat message log. One row per posted message; live
-- fan-out happens over Centrifugo, this table only backs the 1-hour
-- history backfill that new joiners pull on subscribe.

-- CreateTable
CREATE TABLE "GroupMessage" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "authorKey" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "isNpc" BOOLEAN NOT NULL DEFAULT false,
    "text" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GroupMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroupMessage_channelId_createdAt_idx" ON "GroupMessage"("channelId", "createdAt");
