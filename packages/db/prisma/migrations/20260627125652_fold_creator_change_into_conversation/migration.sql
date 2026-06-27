/*
  Warnings:

  - You are about to drop the `CreatorChange` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "CreatorChange" DROP CONSTRAINT "CreatorChange_conversationId_fkey";

-- AlterTable
ALTER TABLE "CreatorConversation" ADD COLUMN     "pendingChanges" JSONB NOT NULL DEFAULT '[]';

-- DropTable
DROP TABLE "CreatorChange";
