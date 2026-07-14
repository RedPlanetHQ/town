-- CreateTable
CREATE TABLE "ModelKey" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "encryptedKey" TEXT NOT NULL,
    "last4" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ModelKey_userId_idx" ON "ModelKey"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ModelKey_userId_provider_key" ON "ModelKey"("userId", "provider");

-- AddForeignKey
ALTER TABLE "ModelKey" ADD CONSTRAINT "ModelKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
