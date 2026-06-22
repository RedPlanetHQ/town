-- CreateTable
CREATE TABLE "TownActivity" (
    "id" TEXT NOT NULL,
    "townSlug" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "subjectName" TEXT NOT NULL,
    "subjectCharacter" TEXT,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TownActivity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TownActivity_townSlug_createdAt_idx" ON "TownActivity"("townSlug", "createdAt");

-- CreateIndex
CREATE INDEX "TownActivity_townSlug_kind_subjectKey_createdAt_idx" ON "TownActivity"("townSlug", "kind", "subjectKey", "createdAt");
