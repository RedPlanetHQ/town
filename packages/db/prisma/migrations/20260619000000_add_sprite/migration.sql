-- User-uploaded PNG bytes for CustomPlot sprites (exterior / interior /
-- prop). Served via /api/sprites/<contentHash>.png with immutable cache.

-- CreateTable
CREATE TABLE "Sprite" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Sprite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Sprite_userId_contentHash_key" ON "Sprite"("userId", "contentHash");

-- CreateIndex
CREATE INDEX "Sprite_userId_idx" ON "Sprite"("userId");

-- AddForeignKey
ALTER TABLE "Sprite" ADD CONSTRAINT "Sprite_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
