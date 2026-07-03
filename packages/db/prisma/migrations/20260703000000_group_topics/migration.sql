-- User-created ephemeral topics inside each building's group chat.
-- topicId=null on GroupMessage remains the always-on "#general" room.

-- AlterTable
ALTER TABLE "GroupMessage" ADD COLUMN "topicId" TEXT;

-- CreateIndex
CREATE INDEX "GroupMessage_channelId_topicId_createdAt_idx" ON "GroupMessage"("channelId", "topicId", "createdAt");

-- CreateTable
CREATE TABLE "GroupTopic" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "townSlug" TEXT NOT NULL,
    "buildingId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "createdByKey" TEXT NOT NULL,
    "createdByName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "GroupTopic_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GroupTopic_channelId_expiresAt_idx" ON "GroupTopic"("channelId", "expiresAt");

-- CreateIndex
CREATE INDEX "GroupTopic_channelId_createdByKey_expiresAt_idx" ON "GroupTopic"("channelId", "createdByKey", "expiresAt");
