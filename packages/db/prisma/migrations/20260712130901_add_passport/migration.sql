/*
  Warnings:

  - A unique constraint covering the columns `[passportId]` on the table `User` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passportId" TEXT;

-- CreateTable
CREATE TABLE "PassportStamp" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "townId" TEXT NOT NULL,
    "firstVisitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastVisitedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "visitCount" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "PassportStamp_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PassportStamp_userId_firstVisitedAt_idx" ON "PassportStamp"("userId", "firstVisitedAt");

-- CreateIndex
CREATE INDEX "PassportStamp_townId_idx" ON "PassportStamp"("townId");

-- CreateIndex
CREATE UNIQUE INDEX "PassportStamp_userId_townId_key" ON "PassportStamp"("userId", "townId");

-- CreateIndex
CREATE UNIQUE INDEX "User_passportId_key" ON "User"("passportId");

-- AddForeignKey
ALTER TABLE "PassportStamp" ADD CONSTRAINT "PassportStamp_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PassportStamp" ADD CONSTRAINT "PassportStamp_townId_fkey" FOREIGN KEY ("townId") REFERENCES "Town"("id") ON DELETE CASCADE ON UPDATE CASCADE;
