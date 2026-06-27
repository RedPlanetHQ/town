-- AlterTable
ALTER TABLE "Aura" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Town" ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'active';

-- CreateTable
CREATE TABLE "CreatorConversation" (
    "id" TEXT NOT NULL,
    "townId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorChange" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreatorChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CreatorConversation_townId_status_idx" ON "CreatorConversation"("townId", "status");

-- CreateIndex
CREATE INDEX "CreatorConversation_userId_status_idx" ON "CreatorConversation"("userId", "status");

-- CreateIndex
CREATE INDEX "CreatorMessage_conversationId_createdAt_idx" ON "CreatorMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "CreatorChange_conversationId_createdAt_idx" ON "CreatorChange"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "CreatorConversation" ADD CONSTRAINT "CreatorConversation_townId_fkey" FOREIGN KEY ("townId") REFERENCES "Town"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorConversation" ADD CONSTRAINT "CreatorConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorMessage" ADD CONSTRAINT "CreatorMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "CreatorConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorChange" ADD CONSTRAINT "CreatorChange_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "CreatorConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
