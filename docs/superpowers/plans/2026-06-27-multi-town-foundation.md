# Multi-Town Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the schema, web, and CLI changes that let a single CORE
user own multiple towns (one per CORE workspace per account), with an
Aura table per town, a top-left town switcher, a public catalog
endpoint, and a CLI verb split (`town new` / `town clone` / `town
catalog`, `town deploy --slug`).

**Architecture:** Drop `Town.ownerId @unique`; key `User` on the
composite `(coreUserId, workspaceId)` so a CORE user signing into a
different workspace becomes a separate town-next account; pivot
`PlotRow`/`Npc` to `townId`; add a 1:1 `Aura` row per town; expose
`GET /api/catalog`; route the web app through a `town:active-slug`
cookie and a town-switcher popover; rework the CLI to use `town new`
+ `town clone` instead of `town init`. All endpoints accept `?slug=`
to disambiguate the target town.

**Tech Stack:** Next.js 15 (Route Handlers + Server Components),
Prisma + PostgreSQL, Commander + Clack (CLI), React 19. No test
runner is configured in this repo; tasks verify with `pnpm
typecheck`, `pnpm build`, and explicit `curl` / browser smoke checks.

## Global Constraints

- **Backfill-preserving migration.** Existing rows survive. The
  migration adds `townId` columns to `PlotRow` / `Npc` /
  `PlotSuggestion`, backfills from `Town.ownerId` (today's
  uniqueness invariant), hard-deletes orphan dependent rows, then
  tightens (drops old uniques, pivots PKs). No `pnpm db:migrate
  reset` required.
- **Identity key:** `(coreUserId, workspaceId)`. Replace the
  `coreUserId @unique` everywhere it surfaces in code.
- **No `Town.workspaceId` column.** Workspace is `owner.workspaceId`.
- **Active-slug cookie:** name `town:active-slug`, path `/`,
  `SameSite=Lax`, `HttpOnly`, `Secure` (in production), 30-day TTL.
- **Aura defaults:** `current = 1000`, `max = 1000`. Always created in
  the same transaction as the `Town` row.
- **`GET /api/catalog`:** public, `Cache-Control: public, max-age=300,
  stale-while-revalidate=60`.
- **CLI version bump:** `@town/cli@0.2.0` (breaking — `town init`
  removed).
- **Owner-only writes.** All write endpoints gate on `town.ownerId ===
  resolved.user.id`. No workspace-membership checks in v1.
- **Commit cadence:** one commit per task. Conventional Commits prefix
  (`feat`, `refactor`, `chore`, `fix`).

---

## File map

### Created

- `packages/db/prisma/migrations/<timestamp>_multi_town_foundation/migration.sql`
- `apps/web/src/lib/active-slug.ts`
- `apps/web/src/app/api/towns/mine/route.ts`
- `apps/web/src/app/api/catalog/route.ts`
- `apps/web/src/ui/TownSwitcher.tsx`
- `packages/town-cli/src/shared/scaffold.ts`
- `packages/town-cli/src/commands/new.ts`
- `packages/town-cli/src/commands/clone.ts`
- `packages/town-cli/src/commands/catalog.ts`

### Modified

- `packages/db/prisma/schema.prisma`
- `apps/web/src/lib/town.ts`
- `apps/web/src/lib/town-shape.ts`
- `apps/web/src/lib/auth-bearer.ts`
- `apps/web/src/app/api/auth/callback/route.ts`
- `apps/web/src/app/api/towns/me/route.ts`
- `apps/web/src/app/api/town/route.ts`
- `apps/web/src/app/api/plot/route.ts`
- `apps/web/src/app/page.tsx`
- `apps/web/src/app/[town]/page.tsx`
- `packages/town-cli/src/cli.ts`
- `packages/town-cli/src/commands/init.ts` (downgraded to a hint
  alias)
- `packages/town-cli/src/commands/deploy.ts`
- `packages/town-cli/package.json` (version bump)

---

## Task 1: Pre-flight — snapshot current row counts

**Files:**
- No source changes. Operator/observability step before the
  migration lands.

**Interfaces:**
- Consumes: live DB.
- Produces: a record of what numbers Task 2 should produce.

- [ ] **Step 1: Capture pre-migration counts**

```bash
pnpm --filter @town/db exec prisma db execute --stdin <<'EOF'
SELECT
  (SELECT count(*) FROM "User")            AS users,
  (SELECT count(*) FROM "Town")            AS towns,
  (SELECT count(*) FROM "PlotRow")         AS plots,
  (SELECT count(*) FROM "Npc")             AS npcs,
  (SELECT count(*) FROM "PlotSuggestion")  AS suggestions;
EOF
```

Expected: integers. Note `towns` and `plots` — Task 2's backfill
should leave `PlotRow.count` ≤ `towns` (the difference equals
orphan PlotRows hard-deleted by the migration). Same for NPCs and
PlotSuggestions.

- [ ] **Step 2 (prod only): pg_dump the affected tables**

```bash
pg_dump --no-owner --no-acl \
  --table='"User"' --table='"Town"' \
  --table='"PlotRow"' --table='"Npc"' --table='"PlotSuggestion"' \
  "$DATABASE_URL" > /tmp/pre-multi-town.sql
```

Skip on local dev — Prisma's migration is reversible by editing
the file.

- [ ] **Step 3: No commit** (operator step, no source change).

---

## Task 2: Land the schema migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (User, Town, PlotRow, Npc,
  PlotSuggestion, new Aura)
- Create: `packages/db/prisma/migrations/<timestamp>_multi_town_foundation/migration.sql`
  (generated by `prisma migrate dev`)

**Interfaces:**
- Consumes: nothing.
- Produces: the full schema later tasks read against. Names later
  tasks rely on:
  - `User.coreUserId`, `User.workspaceId` (composite unique)
  - `Town.aura?: Aura`, `Town.npcs: Npc[]`
  - `PlotRow.townId` (PK), `PlotRow.town: Town`
  - `Npc.townId`, `Npc.town: Town`
  - `PlotSuggestion.townId`, `PlotSuggestion.town: Town`
  - `Aura.townId` (PK), `Aura.current`, `Aura.max`

- [ ] **Step 1: Edit `packages/db/prisma/schema.prisma` — `User` block**

Replace the `User` model block (lines 19-44) with:

```prisma
model User {
  id          String   @id @default(cuid())
  coreUserId  String
  email       String
  name        String
  workspaceId String?
  character   String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  sessions     Session[]
  townEvents   TownEventRow[]
  integrations IntegrationRow[]
  aspects      AspectRow[]
  labels       LabelRow[]
  npcs         Npc[]
  towns        Town[]
  suggestions  PlotSuggestion[]
  sprites      Sprite[]

  @@unique([coreUserId, workspaceId])
  @@index([email])
}
```

Changes: drop `@unique` on `coreUserId`, drop the singular `plot
PlotRow?` and singular `town Town?` relations, change `town Town?`
→ `towns Town[]`, add the composite unique. Keep `npcs Npc[]` as a
back-relation slot — it will be unused by the app but Prisma needs
the back-relation to validate. (We will switch the Npc relation to
`Town` in step 3, so on a final pass this back-relation goes away;
keep it for now to make the schema parse incrementally.)

- [ ] **Step 2: Edit `packages/db/prisma/schema.prisma` — `Town` block**

Replace the `Town` model block (lines 54-78) with:

```prisma
model Town {
  id            String         @id @default(cuid())
  slug          String         @unique
  name          String
  ownerId       String
  owner         User           @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  shareCode     String         @unique
  catalogJson   Json?
  createdAt     DateTime       @default(now())
  updatedAt     DateTime       @updatedAt

  aura          Aura?
  plot          PlotRow?
  npcs          Npc[]
  conversations Conversation[]
  suggestions   PlotSuggestion[]

  @@index([ownerId])
}
```

Changes: drop `@unique` on `ownerId`; add `aura Aura?`, `npcs
Npc[]`, `suggestions PlotSuggestion[]` relations; index `ownerId`.

- [ ] **Step 3: Edit `packages/db/prisma/schema.prisma` — `PlotRow` block**

Replace the `PlotRow` model block (lines 165-177) with:

```prisma
model PlotRow {
  townId    String   @id
  town      Town     @relation(fields: [townId], references: [id], onDelete: Cascade)
  json      Json
  version   Int      @default(0)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

Changes: drop `userId` PK + relation; `townId` is now PK.

- [ ] **Step 4: Edit `packages/db/prisma/schema.prisma` — `Npc` block**

Replace the `Npc` model block (lines 259-288) with:

```prisma
model Npc {
  id          String   @id @default(cuid())
  townId      String
  town        Town     @relation(fields: [townId], references: [id], onDelete: Cascade)
  buildingId  String
  slotId      String   @default("")
  name        String
  description String
  prompt      String
  permissions Json?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  @@index([townId])
  @@index([townId, buildingId])
  @@index([townId, buildingId, slotId])
}
```

Changes: `userId` → `townId`; relation flips from `User` to `Town`.
Now go back to Step 1's edit and remove the `npcs Npc[]` line from
the `User` block — Prisma needed it momentarily for the
intermediate state, but the final schema has Npc related to Town,
not User. Drop the `npcs Npc[]` field from `User`.

- [ ] **Step 5: Edit `packages/db/prisma/schema.prisma` — `PlotSuggestion` block**

Replace the `PlotSuggestion` model block (lines 329-343) with:

```prisma
model PlotSuggestion {
  id            String    @id @default(cuid())
  userId        String
  user          User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  townId        String
  town          Town      @relation(fields: [townId], references: [id], onDelete: Cascade)
  kind          String
  status        String    @default("pending")
  payload       Json
  reason        String
  sourceEventId String?
  createdAt     DateTime  @default(now())
  resolvedAt    DateTime?

  @@index([userId, status])
  @@index([townId, status])
  @@index([userId, createdAt])
}
```

Changes: add `townId` + `town` relation + `@@index([townId, status])`.

- [ ] **Step 6: Append the `Aura` model to `schema.prisma`**

Append after the `GroupMessage` block (around the end of the file,
before any closing braces):

```prisma
// Per-town energy. v1 stores just current + max. The follow-up
// ledger spec adds debit/top-up event rows; keeping Aura in its
// own table means those changes don't touch Town.
model Aura {
  townId    String   @id
  town      Town     @relation(fields: [townId], references: [id], onDelete: Cascade)
  current   Int      @default(1000)
  max       Int      @default(1000)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
}
```

- [ ] **Step 7: Generate the migration SQL skeleton (no apply yet)**

```bash
pnpm --filter @town/db exec prisma migrate dev \
  --name multi_town_foundation --create-only
```

Expected: writes
`packages/db/prisma/migrations/<timestamp>_multi_town_foundation/migration.sql`
with the diff between the live DB and the new schema, **without**
applying it. The DDL it contains will drop columns Prisma can't
backfill on its own (PlotRow.userId, Npc.userId, the unique
indexes). We need to inject the backfill SQL before the drops.

- [ ] **Step 8: Edit the generated `migration.sql`**

Open the file. Prisma will have produced something like
"add columns → drop columns → tighten" already. Reorder/insert so
the file reads, in order:

```sql
-- 1. ADD NULLABLE COLUMNS + AURA TABLE
ALTER TABLE "PlotRow"        ADD COLUMN "townId" TEXT;
ALTER TABLE "Npc"            ADD COLUMN "townId" TEXT;
ALTER TABLE "PlotSuggestion" ADD COLUMN "townId" TEXT;

CREATE TABLE "Aura" (
  "townId"    TEXT PRIMARY KEY,
  "current"   INTEGER NOT NULL DEFAULT 1000,
  "max"       INTEGER NOT NULL DEFAULT 1000,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "Aura_townId_fkey" FOREIGN KEY ("townId")
    REFERENCES "Town"("id") ON DELETE CASCADE
);

-- 2. BACKFILL
UPDATE "PlotRow"
SET "townId" = t.id
FROM "Town" t WHERE t."ownerId" = "PlotRow"."userId";

UPDATE "Npc"
SET "townId" = t.id
FROM "Town" t WHERE t."ownerId" = "Npc"."userId";

UPDATE "PlotSuggestion"
SET "townId" = t.id
FROM "Town" t WHERE t."ownerId" = "PlotSuggestion"."userId";

INSERT INTO "Aura" ("townId", "current", "max", "updatedAt")
SELECT id, 1000, 1000, NOW() FROM "Town";

-- 3. HARD-DELETE ORPHAN ROWS (pre-onboarding state)
DELETE FROM "PlotRow"        WHERE "townId" IS NULL;
DELETE FROM "Npc"            WHERE "townId" IS NULL;
DELETE FROM "PlotSuggestion" WHERE "townId" IS NULL;

-- 4. TIGHTEN
-- PlotRow PK pivot
ALTER TABLE "PlotRow" ALTER COLUMN "townId" SET NOT NULL;
ALTER TABLE "PlotRow" DROP CONSTRAINT "PlotRow_pkey";
ALTER TABLE "PlotRow" DROP COLUMN "userId";
ALTER TABLE "PlotRow" ADD CONSTRAINT "PlotRow_pkey" PRIMARY KEY ("townId");
ALTER TABLE "PlotRow" ADD CONSTRAINT "PlotRow_townId_fkey"
  FOREIGN KEY ("townId") REFERENCES "Town"("id") ON DELETE CASCADE;

-- Npc townId tighten + index swap
ALTER TABLE "Npc" ALTER COLUMN "townId" SET NOT NULL;
DROP INDEX IF EXISTS "Npc_userId_idx";
DROP INDEX IF EXISTS "Npc_userId_buildingId_idx";
DROP INDEX IF EXISTS "Npc_userId_buildingId_slotId_idx";
ALTER TABLE "Npc" DROP COLUMN "userId";
ALTER TABLE "Npc" ADD CONSTRAINT "Npc_townId_fkey"
  FOREIGN KEY ("townId") REFERENCES "Town"("id") ON DELETE CASCADE;
CREATE INDEX "Npc_townId_idx" ON "Npc"("townId");
CREATE INDEX "Npc_townId_buildingId_idx" ON "Npc"("townId", "buildingId");
CREATE INDEX "Npc_townId_buildingId_slotId_idx"
  ON "Npc"("townId", "buildingId", "slotId");

-- PlotSuggestion townId FK + index
ALTER TABLE "PlotSuggestion" ALTER COLUMN "townId" SET NOT NULL;
ALTER TABLE "PlotSuggestion" ADD CONSTRAINT "PlotSuggestion_townId_fkey"
  FOREIGN KEY ("townId") REFERENCES "Town"("id") ON DELETE CASCADE;
CREATE INDEX "PlotSuggestion_townId_status_idx"
  ON "PlotSuggestion"("townId", "status");

-- Town uniqueness swap (drop owner unique, add index)
DROP INDEX IF EXISTS "Town_ownerId_key";
CREATE INDEX "Town_ownerId_idx" ON "Town"("ownerId");

-- User composite unique
DROP INDEX IF EXISTS "User_coreUserId_key";
CREATE UNIQUE INDEX "User_coreUserId_workspaceId_key"
  ON "User"("coreUserId", "workspaceId");
```

Inspect carefully — Prisma may have generated slightly different
constraint names (e.g. `Npc_userId_idx` vs whatever was actually
created). Cross-check with:

```bash
pnpm --filter @town/db exec prisma db execute --stdin <<'EOF'
SELECT indexname FROM pg_indexes
WHERE schemaname = 'public' AND tablename IN ('Npc','PlotRow','Town','User','PlotSuggestion');
EOF
```

Use the actual names from that output in the migration file.

- [ ] **Step 9: Apply the migration**

```bash
pnpm --filter @town/db exec prisma migrate dev
```

Expected: migration applies cleanly; counts match the pre-flight
snapshot (Task 1) minus any orphan deletes. Spot-check:

```bash
pnpm --filter @town/db exec prisma db execute --stdin <<'EOF'
SELECT count(*) AS towns FROM "Town";
SELECT count(*) AS plots FROM "PlotRow";
SELECT count(*) AS npcs FROM "Npc";
SELECT count(*) AS aura_rows FROM "Aura";
EOF
```

Expected: `plots ≤ towns`, `aura_rows == towns`.

- [ ] **Step 10: Typecheck (will fail — that's expected)**

```bash
pnpm typecheck
```

Expected: failures in `apps/web/src/lib/town.ts`,
`town-shape.ts`, `auth-bearer.ts`, the route handlers, and the
CLI because they reference dropped fields. These get fixed in the
following tasks.

- [ ] **Step 11: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations
git commit -m "feat(db): multi-town foundation schema + backfill"
```

---

## Task 3: Update `apps/web/src/lib/town.ts` for multi-town

**Files:**
- Modify: `apps/web/src/lib/town.ts`

**Interfaces:**
- Consumes: schema from Task 2 (`Town`, `Aura`, `PlotRow`).
- Produces:
  - `getTownsByOwner(ownerId: string): Promise<Town[]>` (replaces `getTownByOwner`)
  - `getTownBySlug(slug: string): Promise<Town | null>` (already
    exists; expand return to include aura join)
  - `getActiveTownForUser(ownerId: string, cookieSlug: string | null):
    Promise<(Town & { aura: Aura }) | null>`
  - `pickTown(input)` now creates `Aura` in the same transaction
  - `bootstrapPlot` keys on `townId`, not `userId`

- [ ] **Step 1: Replace the file contents**

Overwrite `apps/web/src/lib/town.ts` with:

```ts
// Town persistence helpers.
//
// A town-next user can own N towns. Identity is keyed on
// (coreUserId, workspaceId); Town.ownerId is no longer unique.
// Every Town has a 1:1 Aura row created in the same transaction
// as the Town.

import { catalog } from "@town/catalog";
import { generatePlot } from "@town/plot-gen";
import type { Manifest, Plot } from "@town/plot";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { prisma } from "./db";
import { OWNER_DEFAULT_CHARACTER } from "./characters";
import { seedNpcs } from "./plot";
import {
  generateShareCode,
  isValidSlug,
  normalizeSlug,
} from "./town-code";

let cachedManifest: Manifest | null = null;
function getManifest(): Manifest {
  if (cachedManifest) return cachedManifest;
  const path = resolve(
    process.cwd(),
    "public",
    "sprites",
    "extras",
    "MANIFEST.json",
  );
  cachedManifest = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  return cachedManifest;
}

function bootstrapPlot(townId: string): Plot {
  return generatePlot({
    seed: townId,
    catalog,
    manifest: getManifest(),
    activeCount: 3,
    id: `plot-${townId}`,
  });
}

export type PickTownInput = {
  ownerId: string;
  name: string;
  slug?: string;
};

export type TownRow = Awaited<ReturnType<typeof getTownBySlug>>;

export async function getTownsByOwner(ownerId: string) {
  return prisma.town.findMany({
    where: { ownerId },
    include: { aura: true },
    orderBy: { updatedAt: "desc" },
  });
}

export async function getTownBySlug(slug: string) {
  return prisma.town.findUnique({
    where: { slug },
    include: { aura: true },
  });
}

export async function getActiveTownForUser(
  ownerId: string,
  cookieSlug: string | null,
) {
  if (cookieSlug) {
    const byCookie = await prisma.town.findFirst({
      where: { slug: cookieSlug, ownerId },
      include: { aura: true },
    });
    if (byCookie) return byCookie;
  }
  return prisma.town.findFirst({
    where: { ownerId },
    include: { aura: true },
    orderBy: { updatedAt: "desc" },
  });
}

export async function pickTown({ ownerId, name, slug: explicitSlug }: PickTownInput) {
  const slug = normalizeSlug(explicitSlug ?? name);
  if (!isValidSlug(slug)) {
    const err = new Error("slug-invalid") as Error & { code: string };
    err.code = "slug-invalid";
    throw err;
  }

  let town: Awaited<ReturnType<typeof prisma.town.create>> | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const shareCode = generateShareCode();
    try {
      town = await prisma.$transaction(async (tx) => {
        const created = await tx.town.create({
          data: { slug, name: name.trim(), ownerId, shareCode },
        });
        await tx.aura.create({ data: { townId: created.id } });
        const plot = bootstrapPlot(created.id);
        await tx.plotRow.create({
          data: {
            townId: created.id,
            json: plot as unknown as object,
            version: 1,
          },
        });
        return created;
      });
      break;
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "P2002") {
        const meta = (e as { meta?: { target?: string[] } }).meta;
        const target = meta?.target ?? [];
        if (target.includes("slug")) {
          const err = new Error("slug-taken") as Error & { code: string };
          err.code = "slug-taken";
          throw err;
        }
        lastError = e;
        continue;
      }
      throw e;
    }
  }
  if (!town) throw lastError ?? new Error("town-create-failed");

  // Seed default NPCs against the freshly-built plot (idempotent).
  const plotRow = await prisma.plotRow.findUnique({ where: { townId: town.id } });
  if (plotRow) {
    await seedNpcs(town.id, plotRow.json as unknown as Plot);
  }

  // Default sprite for new owners (no clobber if they already picked one).
  await prisma.user.updateMany({
    where: { id: ownerId, character: null },
    data: { character: OWNER_DEFAULT_CHARACTER },
  });

  return town;
}

export async function rotateShareCode(townId: string) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const shareCode = generateShareCode();
    try {
      return await prisma.town.update({
        where: { id: townId },
        data: { shareCode },
      });
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "P2002") continue;
      throw e;
    }
  }
  throw new Error("rotate-share-code-failed");
}
```

Key changes vs. the previous file:
- `getTownByOwner` is gone; `getTownsByOwner` returns an array,
  `getActiveTownForUser` picks one.
- `pickTown` no longer throws `already-onboarded`; users can own
  multiple towns.
- Aura + PlotRow are created in the same transaction as Town.
- `seedNpcs(ownerId, plot)` becomes `seedNpcs(townId, plot)` — the
  signature change happens in Task 4.

- [ ] **Step 2: Note the breakage**

`seedNpcs` still takes `userId` until Task 4 patches it. Typecheck
will fail on the call site at the bottom of `pickTown`. Move on —
Task 4 closes the gap.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/town.ts
git commit -m "refactor(town-lib): multi-town helpers + transactional aura/plot create"
```

---

## Task 4: Re-key `apps/web/src/lib/town-shape.ts` and `plot.ts` on `townId`

**Files:**
- Modify: `apps/web/src/lib/town-shape.ts`
- Modify: `apps/web/src/lib/plot.ts`

**Interfaces:**
- Consumes: schema from Task 2.
- Produces:
  - `seedNpcs(townId: string, plot: Plot): Promise<void>`
  - `getTownShape(townId: string): Promise<{ shape, version, npcs }>`
  - `applyTownShape(townId: string, input: TownShape): Promise<{ plot, version }>`

- [ ] **Step 1: Read the current shape of both files**

```bash
sed -n '1,80p' apps/web/src/lib/town-shape.ts
sed -n '1,80p' apps/web/src/lib/plot.ts
```

Expected: both files key their queries on `userId`. You're going
to repoint them at `townId`. Carefully read each function.

- [ ] **Step 2: Edit `town-shape.ts`**

For every Prisma call inside `town-shape.ts`:
- Replace `where: { userId }` with `where: { townId }` on
  `prisma.plotRow.*`.
- Replace `where: { userId }` with `where: { townId }` on
  `prisma.npc.*`.
- Rename function parameters `userId` → `townId` throughout the
  file.
- Update the JSDoc / leading comments to mention "town" not
  "user".

The function signatures become:

```ts
export async function getTownShape(townId: string): Promise<{
  shape: TownShape;
  version: number;
  npcs: NpcRow[];
}>;

export async function applyTownShape(townId: string, input: TownShape): Promise<{
  plot: Plot;
  version: number;
}>;
```

- [ ] **Step 3: Edit `plot.ts` — `seedNpcs` signature**

Find `seedNpcs` and change its first parameter from `userId` to
`townId`. Every Prisma write inside it (`prisma.npc.createMany`,
etc.) keys on `townId` instead of `userId`. Update the JSDoc.

- [ ] **Step 4: Find every other call to `seedNpcs` and `getTownShape` / `applyTownShape`**

```bash
grep -rn "seedNpcs\|getTownShape\|applyTownShape" apps/web/src packages
```

For each call site, update the argument from `userId` → the
appropriate `townId`. (Most call sites already have `town.id` in
scope.)

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```

Expected: most lib-level errors clear. Route-handler errors
remain (Task 7+).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/town-shape.ts apps/web/src/lib/plot.ts
git commit -m "refactor(town-lib): re-key town-shape + seedNpcs on townId"
```

---

## Task 5: Composite-key upsert in OAuth callback + PAT path

**Files:**
- Modify: `apps/web/src/app/api/auth/callback/route.ts`
- Modify: `apps/web/src/lib/auth-bearer.ts`

**Interfaces:**
- Consumes: `User` schema with `@@unique([coreUserId, workspaceId])`.
- Produces: every signed-in user resolves to the right
  workspace-scoped account.

- [ ] **Step 1: Edit `apps/web/src/app/api/auth/callback/route.ts`**

Find the existing `prisma.user.upsert` (around lines 66-80) and
replace it with the composite-key upsert **plus the one-shot
grace path** that adopts pre-migration `workspaceId = NULL` rows
on next login:

```ts
const workspaceId = info.workspace_id ?? null;
const email = info.email ?? "";
const name = info.name ?? info.preferred_username ?? "Traveler";

let user;
if (workspaceId) {
  // One-shot grace: adopt this login's workspace into the
  // pre-migration row instead of creating a duplicate. Only
  // fires until the row's workspaceId is filled.
  const legacy = await prisma.user.findFirst({
    where: { coreUserId: info.sub, workspaceId: null },
  });
  if (legacy) {
    user = await prisma.user.update({
      where: { id: legacy.id },
      data: { workspaceId, email, name },
    });
  }
}
if (!user) {
  user = await prisma.user.upsert({
    where: {
      coreUserId_workspaceId: { coreUserId: info.sub, workspaceId },
    },
    create: { coreUserId: info.sub, workspaceId, email, name },
    update: { email, name },
  });
}
```

(The composite-key parameter name `coreUserId_workspaceId` is the
exact one Prisma generates from `@@unique([coreUserId, workspaceId])`.)

- [ ] **Step 2: Edit `apps/web/src/lib/auth-bearer.ts`**

Replace the `prisma.user.upsert` block (lines 85-98) with the
same grace-path-aware logic:

```ts
const workspaceId = me.workspaceId ?? null;
const email = me.email ?? "";
const name = me.name ?? "";

let row;
if (workspaceId) {
  const legacy = await prisma.user.findFirst({
    where: { coreUserId: me.id, workspaceId: null },
  });
  if (legacy) {
    row = await prisma.user.update({
      where: { id: legacy.id },
      data: { workspaceId, email, name },
    });
  }
}
if (!row) {
  row = await prisma.user.upsert({
    where: {
      coreUserId_workspaceId: { coreUserId: me.id, workspaceId },
    },
    create: { coreUserId: me.id, workspaceId, email, name },
    update: { email, name },
  });
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: auth-side errors clear.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/auth/callback/route.ts apps/web/src/lib/auth-bearer.ts
git commit -m "feat(auth): composite (coreUserId, workspaceId) identity"
```

---

## Task 6: Active-slug cookie helpers

**Files:**
- Create: `apps/web/src/lib/active-slug.ts`

**Interfaces:**
- Consumes: Next.js `cookies()`.
- Produces:
  - `readActiveSlug(): Promise<string | null>`
  - `writeActiveSlug(slug: string): Promise<void>`
  - `ACTIVE_SLUG_COOKIE` constant (`"town:active-slug"`)

- [ ] **Step 1: Create the file**

```ts
// Persistent "which town is this user looking at?" cookie. Read on
// the root `/` route to choose the redirect target; written on every
// /{slug} render where the user owns the town.
//
// Path `/`, SameSite=Lax, HttpOnly, Secure in production, 30-day TTL.

import { cookies } from "next/headers";

export const ACTIVE_SLUG_COOKIE = "town:active-slug";
const THIRTY_DAYS = 60 * 60 * 24 * 30;

export async function readActiveSlug(): Promise<string | null> {
  const jar = await cookies();
  const value = jar.get(ACTIVE_SLUG_COOKIE)?.value;
  return value && value.length > 0 ? value : null;
}

export async function writeActiveSlug(slug: string): Promise<void> {
  const jar = await cookies();
  jar.set(ACTIVE_SLUG_COOKIE, slug, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: THIRTY_DAYS,
  });
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/active-slug.ts
git commit -m "feat(web): active-slug cookie helpers"
```

---

## Task 7: `GET /api/towns/mine` list endpoint

**Files:**
- Create: `apps/web/src/app/api/towns/mine/route.ts`

**Interfaces:**
- Consumes: `getTownsByOwner` (Task 3), `resolveUser` (auth-bearer),
  `readActiveSlug` (Task 6).
- Produces: `{ towns: Array<{ id, slug, name, updatedAt, aura: { current, max } }>, activeSlug: string | null }`.

- [ ] **Step 1: Create the file**

```ts
// /api/towns/mine
//
//   GET → { towns: [...], activeSlug }
//
// Owner is read from session or PAT. The list is implicitly
// workspace-scoped: a session belongs to one town-next User row,
// which belongs to one CORE workspace.

import { NextResponse } from "next/server";

import { resolveUser } from "@/lib/auth-bearer";
import { readActiveSlug } from "@/lib/active-slug";
import { getTownsByOwner } from "@/lib/town";

export async function GET(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const towns = await getTownsByOwner(resolved.user.id);
  const activeSlug = await readActiveSlug();
  return NextResponse.json({
    towns: towns.map((t) => ({
      id: t.id,
      slug: t.slug,
      name: t.name,
      updatedAt: t.updatedAt,
      aura: t.aura
        ? { current: t.aura.current, max: t.aura.max }
        : { current: 1000, max: 1000 },
    })),
    activeSlug,
  });
}
```

- [ ] **Step 2: Smoke check**

In one terminal:

```bash
pnpm dev
```

In another, hit the endpoint as an unauthenticated request:

```bash
curl -i http://localhost:3000/api/towns/mine
```

Expected: `HTTP/1.1 401` with `{"error":"unauthorized"}`.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/app/api/towns/mine/route.ts
git commit -m "feat(api): GET /api/towns/mine"
```

---

## Task 8: `/api/towns/me` — allow N towns + create Aura

**Files:**
- Modify: `apps/web/src/app/api/towns/me/route.ts`

**Interfaces:**
- Consumes: `pickTown` (Task 3) — no longer throws
  `already-onboarded`.
- Produces: same response shape as today; semantically every call
  creates a new town now.

- [ ] **Step 1: Edit the POST handler**

Open the file and find the POST handler. Inside the `try` block,
remove the `already-onboarded` branch from the error mapping:

Replace:

```ts
if (code === "slug-taken" || code === "slug-invalid" || code === "already-onboarded") {
  return NextResponse.json({ error: code }, { status: 409 });
}
```

With:

```ts
if (code === "slug-taken" || code === "slug-invalid") {
  return NextResponse.json({ error: code }, { status: 409 });
}
```

- [ ] **Step 2: Update the GET handler to use `getTownsByOwner`**

Replace the existing GET body with:

```ts
export async function GET(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // Backward-compat: return the oldest owned town as `town`, or null.
  const towns = await getTownsByOwner(resolved.user.id);
  const oldest = towns.length > 0 ? towns[towns.length - 1] : null;
  return NextResponse.json({
    town: oldest
      ? { id: oldest.id, slug: oldest.slug, name: oldest.name }
      : null,
  });
}
```

Update the import at the top:

```ts
import { getTownsByOwner, pickTown } from "@/lib/town";
```

- [ ] **Step 3: Typecheck**

```bash
pnpm typecheck
```

Expected: no errors in this file.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/towns/me/route.ts
git commit -m "feat(api): /api/towns/me allows N towns, GET returns oldest"
```

---

## Task 9: `/api/town` slug-scoping

**Files:**
- Modify: `apps/web/src/app/api/town/route.ts`

**Interfaces:**
- Consumes: `getTownsByOwner`, `getTownBySlug`, `getTownShape`,
  `applyTownShape`.
- Produces: identical response shape today, gated on `?slug=`.

- [ ] **Step 1: Add a slug resolver helper at the top of the file**

After the existing imports, add:

```ts
import { getTownsByOwner, getTownBySlug } from "@/lib/town";

type SlugResolution =
  | { ok: true; townId: string; slug: string }
  | { ok: false; status: number; body: Record<string, unknown> };

async function resolveTownForOwner(
  req: Request,
  ownerId: string,
): Promise<SlugResolution> {
  const url = new URL(req.url);
  const explicit = url.searchParams.get("slug");
  if (explicit) {
    const town = await getTownBySlug(explicit);
    if (!town || town.ownerId !== ownerId) {
      return { ok: false, status: 404, body: { error: "town-not-found" } };
    }
    return { ok: true, townId: town.id, slug: town.slug };
  }
  const owned = await getTownsByOwner(ownerId);
  if (owned.length === 0) {
    return { ok: false, status: 404, body: { error: "no-towns" } };
  }
  if (owned.length > 1) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "missing-slug",
        slugs: owned.map((t) => t.slug),
      },
    };
  }
  return { ok: true, townId: owned[0]!.id, slug: owned[0]!.slug };
}
```

- [ ] **Step 2: Repoint GET**

Replace the body of `GET` with:

```ts
export async function GET(req: Request) {
  const resolved = await resolveUser(req);
  if (!resolved) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const r = await resolveTownForOwner(req, resolved.user.id);
  if (!r.ok) return NextResponse.json(r.body, { status: r.status });

  const { shape, version, npcs } = await getTownShape(r.townId);
  const town = await prisma.town.findUnique({
    where: { id: r.townId },
    select: { catalogJson: true },
  });
  return NextResponse.json({
    buildings: shape.buildings,
    customPlots: shape.customPlots,
    npcs,
    version,
    ...(town?.catalogJson ? { catalog: town.catalogJson } : {}),
  });
}
```

- [ ] **Step 3: Repoint POST**

Replace the section of POST that derives `userId` and runs the
transaction. The original keys everything on `userId`; rewrite to
key on `townId`. Specifically:

Find the line `const userId = resolved.user.id;` and the lines
beneath it that use `userId` for `applyTownShape`, the `reflow`
delete, and the inner `prisma.$transaction`. Replace the whole
block with:

```ts
const r = await resolveTownForOwner(req, resolved.user.id);
if (!r.ok) return NextResponse.json(r.body, { status: r.status });
const townId = r.townId;

const input: TownShape = {
  buildings: parsed.buildings,
  customPlots: (parsed.customPlots ?? []) as CustomPlot[],
};

const url = new URL(req.url);
if (url.searchParams.get("reflow") === "1") {
  await prisma.plotRow.delete({ where: { townId } }).catch(() => {});
}

let applied;
try {
  applied = await applyTownShape(townId, input);
} catch (e) {
  if (e instanceof IncrementalError) {
    return NextResponse.json(
      { error: "incremental-failed", code: e.code, detail: e.message },
      { status: 400 },
    );
  }
  throw e;
}

const check = validatePlot(applied.plot as Plot, loadManifest());
if (!check.ok) {
  return NextResponse.json(
    { error: "validation-failed", issues: check.issues },
    { status: 400 },
  );
}

let npcCount = 0;
try {
  const result = await prisma.$transaction(async (tx) => {
    let count = 0;
    if (parsed.npcs && parsed.npcs.length >= 0) {
      await tx.npc.deleteMany({ where: { townId } });
      if (parsed.npcs.length > 0) {
        const created = await tx.npc.createMany({
          data: parsed.npcs.map((n) => ({
            ...(n.id ? { id: n.id } : {}),
            townId,
            buildingId: n.buildingId,
            slotId: n.slotId,
            name: n.name,
            description: n.description,
            prompt: n.prompt,
            ...(n.permissions !== undefined
              ? {
                  permissions: normalizePermissions(
                    n.permissions,
                  ) as unknown as object,
                }
              : {}),
          })),
        });
        count = created.count;
      }
    }
    if (parsed.catalog) {
      await tx.town.update({
        where: { id: townId },
        data: { catalogJson: parsed.catalog as unknown as object },
      });
    }
    return count;
  });
  npcCount = result;
} catch (e) {
  const code = (e as { code?: string }).code;
  if (code === "P2025") {
    return NextResponse.json(
      {
        error: "no-town-row",
        detail:
          "Could not find the town. Did the slug resolve correctly?",
      },
      { status: 409 },
    );
  }
  throw e;
}

return NextResponse.json({
  version: applied.version,
  count: npcCount,
});
```

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: clean on this file.

- [ ] **Step 5: Smoke check**

```bash
pnpm dev
```

Hit the endpoint unauthenticated:

```bash
curl -i http://localhost:3000/api/town
```

Expected: `HTTP/1.1 401 unauthorized`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/app/api/town/route.ts
git commit -m "feat(api): /api/town accepts ?slug= and gates by ownership"
```

---

## Task 10: `/api/plot` slug-scoping

**Files:**
- Modify: `apps/web/src/app/api/plot/route.ts`

**Interfaces:**
- Consumes: `getTownsByOwner`, `getTownBySlug`, `PlotRow` keyed on
  `townId`.
- Produces: identical response shape, gated on `?slug=`.

- [ ] **Step 1: Read the current file**

```bash
sed -n '1,200p' apps/web/src/app/api/plot/route.ts
```

Note the existing GET / POST shapes; they key on `userId`.

- [ ] **Step 2: Add the same `resolveTownForOwner` helper**

Either import it from a shared module (recommended — extract it to
`apps/web/src/lib/resolve-town.ts`) or duplicate the function from
Task 9. To avoid the duplicate, extract to a shared module:

```bash
cat > apps/web/src/lib/resolve-town.ts <<'EOF'
import { NextResponse } from "next/server";

import { getTownBySlug, getTownsByOwner } from "./town";

export type SlugResolution =
  | { ok: true; townId: string; slug: string }
  | { ok: false; status: number; body: Record<string, unknown> };

export async function resolveTownForOwner(
  req: Request,
  ownerId: string,
): Promise<SlugResolution> {
  const url = new URL(req.url);
  const explicit = url.searchParams.get("slug");
  if (explicit) {
    const town = await getTownBySlug(explicit);
    if (!town || town.ownerId !== ownerId) {
      return { ok: false, status: 404, body: { error: "town-not-found" } };
    }
    return { ok: true, townId: town.id, slug: town.slug };
  }
  const owned = await getTownsByOwner(ownerId);
  if (owned.length === 0) {
    return { ok: false, status: 404, body: { error: "no-towns" } };
  }
  if (owned.length > 1) {
    return {
      ok: false,
      status: 400,
      body: { error: "missing-slug", slugs: owned.map((t) => t.slug) },
    };
  }
  return { ok: true, townId: owned[0]!.id, slug: owned[0]!.slug };
}
EOF
```

Then update `apps/web/src/app/api/town/route.ts` to import from
the shared module and delete its inline copy.

- [ ] **Step 3: Edit `/api/plot/route.ts`**

For every Prisma call inside the file:
- Replace `where: { userId: ... }` on `prisma.plotRow` with `where:
  { townId: ... }`.
- At the top of each handler, replace whatever currently extracts
  `userId` with:

```ts
const resolved = await resolveUser(req);
if (!resolved) {
  return NextResponse.json({ error: "unauthorized" }, { status: 401 });
}
const r = await resolveTownForOwner(req, resolved.user.id);
if (!r.ok) return NextResponse.json(r.body, { status: r.status });
const townId = r.townId;
```

Then use `townId` for all subsequent Prisma calls.

- [ ] **Step 4: Typecheck**

```bash
pnpm typecheck
```

Expected: clean on `/api/plot/route.ts` and the shared module.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/resolve-town.ts apps/web/src/app/api/town/route.ts apps/web/src/app/api/plot/route.ts
git commit -m "feat(api): /api/plot accepts ?slug= via shared resolver"
```

---

## Task 11: `GET /api/catalog` public endpoint

**Files:**
- Create: `apps/web/src/app/api/catalog/route.ts`

**Interfaces:**
- Consumes: `loadManifest()` from `@/lib/manifest`, `catalog` from
  `@town/catalog`.
- Produces: `{ plotKeys: Array<{ key, category, widthTiles,
  heightTiles, variants, npcSlots }> }`.

- [ ] **Step 1: Inspect the manifest + catalog shapes**

```bash
grep -n "export" packages/catalog/src/index.ts | head -20
sed -n '1,40p' apps/web/src/lib/manifest.ts
```

Expected: `catalog` is a `Record<string, PlotKey>` (or similar
shape) listing every available plotKey; `loadManifest()` returns
sprite metadata for each.

- [ ] **Step 2: Create the route**

```ts
// /api/catalog
//
//   GET → { plotKeys: [...] }
//
// Public, cached. Returns the global building catalog in a
// tool-friendly shape so the CLI and (future) chat-creator agent
// can scaffold town.json without bundling the manifest.

import { NextResponse } from "next/server";

import { catalog } from "@town/catalog";
import { loadManifest } from "@/lib/manifest";

export const dynamic = "force-static";
export const revalidate = 300;

export async function GET() {
  const manifest = loadManifest();
  const plotKeys = Object.entries(catalog).map(([key, def]) => ({
    key,
    category: def.category,
    widthTiles: def.widthTiles,
    heightTiles: def.heightTiles,
    variants: def.variants.map((v) => ({
      id: v.id,
      exteriorSprite: v.exteriorSprite,
    })),
    npcSlots: (def.npcSlots ?? []).map((s) => ({
      id: s.id,
      tx: s.tx,
      ty: s.ty,
    })),
  }));
  return NextResponse.json(
    { plotKeys },
    {
      headers: {
        "Cache-Control":
          "public, max-age=300, stale-while-revalidate=60",
      },
    },
  );
}
```

If the field names on `catalog`/`manifest` differ in your tree,
adapt. Fields produced (`key`, `category`, `widthTiles`,
`heightTiles`, `variants[*].{id,exteriorSprite}`,
`npcSlots[*].{id,tx,ty}`) are the contract the CLI will rely on.

- [ ] **Step 3: Smoke check**

```bash
pnpm dev
curl -s http://localhost:3000/api/catalog | head -c 200
```

Expected: JSON with a `"plotKeys"` array; includes at least
`home`, `library`, `store`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/catalog/route.ts
git commit -m "feat(api): GET /api/catalog (public, cached)"
```

---

## Task 12: Root page + `/[town]/page.tsx` use `active-slug`

**Files:**
- Modify: `apps/web/src/app/page.tsx`
- Modify: `apps/web/src/app/[town]/page.tsx`

**Interfaces:**
- Consumes: `getActiveTownForUser`, `readActiveSlug`,
  `writeActiveSlug`.
- Produces: root `/` redirects to the active town; visiting a
  `/{slug}` writes the cookie.

- [ ] **Step 1: Edit `apps/web/src/app/page.tsx`**

Replace the existing default export:

```tsx
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { readActiveSlug } from "@/lib/active-slug";
import { getSessionFromCookie } from "@/lib/session";
import { getActiveTownForUser } from "@/lib/town";
import { Landing } from "@/ui/Landing";
import { Onboarding } from "@/ui/Onboarding";

export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

export const metadata: Metadata = {
  title: { absolute: "town" },
  description:
    "Welcome to town. Sign in with CORE to claim yours, or take the guest tour first.",
  openGraph: {
    title: "town",
    description:
      "Welcome to town. Sign in with CORE to claim yours, or take the guest tour first.",
  },
  twitter: {
    title: "town",
    description:
      "Welcome to town. Sign in with CORE to claim yours, or take the guest tour first.",
  },
};

export default async function Home() {
  const session = await getSessionFromCookie();
  if (!session) return <Landing />;
  const cookieSlug = await readActiveSlug();
  const active = await getActiveTownForUser(session.user.id, cookieSlug);
  if (active) redirect(`/${active.slug}`);
  return <Onboarding userName={session.user.name} />;
}
```

- [ ] **Step 2: Edit `apps/web/src/app/[town]/page.tsx`**

After the `isOwner = !!session && ...` line (around line 96), add
a cookie-write side effect for owners. Insert:

```tsx
if (isOwner) {
  // Persist the active slug so the next root-redirect comes back here.
  void (await import("@/lib/active-slug")).writeActiveSlug(town.slug);
  // ... rest of the existing isOwner block
}
```

Or, cleaner, hoist the import to the top:

```ts
import { writeActiveSlug } from "@/lib/active-slug";
```

…and put `await writeActiveSlug(town.slug);` as the first line of
the existing `if (isOwner) { ... }` branch.

- [ ] **Step 3: Smoke check in the browser**

```bash
pnpm dev
```

1. Open `http://localhost:3000` while signed in with a CORE account
   that owns no towns yet — should render the onboarding page.
2. Run `npx town new` (after Task 14) to create a town, or for now
   make one via `pickTown` from a tinker script. Then revisit `/` —
   should redirect to `/{slug}`.
3. Visit `/{slug}` directly — cookie `town:active-slug` should
   appear in DevTools → Application → Cookies.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/page.tsx apps/web/src/app/[town]/page.tsx
git commit -m "feat(web): active-slug redirect on root, write on /[town]"
```

---

## Task 13: `<TownSwitcher>` component + HUD mount

**Files:**
- Create: `apps/web/src/ui/TownSwitcher.tsx`
- Modify: `apps/web/src/ui/TownGame.tsx` (mount the switcher in the
  top-left HUD)

**Interfaces:**
- Consumes: `GET /api/towns/mine` (Task 7).
- Produces: visible popover lets the owner flip between owned towns
  and copy the `npx town new` command.

- [ ] **Step 1: Create the component**

```tsx
// Top-left town switcher. Lists every town the signed-in owner has
// in this CORE workspace (the API list is implicitly workspace-
// scoped via the User row). The "+ New town" entry pops a modal
// that copies the `npx town new` CLI command.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type TownEntry = {
  id: string;
  slug: string;
  name: string;
  updatedAt: string;
  aura: { current: number; max: number };
};

type TownsMineResponse = {
  towns: TownEntry[];
  activeSlug: string | null;
};

export function TownSwitcher({ activeSlug }: { activeSlug: string }) {
  const [towns, setTowns] = useState<TownEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (towns) return;
    fetch("/api/towns/mine", { credentials: "include" })
      .then((r) => r.json())
      .then((data: TownsMineResponse) => setTowns(data.towns))
      .catch(() => setTowns([]));
  }, [open, towns]);

  const active = towns?.find((t) => t.slug === activeSlug);

  return (
    <div className="absolute left-3 top-3 z-50 text-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-md bg-zinc-900/80 px-3 py-1.5 text-zinc-100 backdrop-blur hover:bg-zinc-900"
      >
        {active?.name ?? activeSlug}
        <span className="ml-2 opacity-60">▾</span>
      </button>
      {open && (
        <div className="mt-2 w-64 rounded-md bg-zinc-900/95 p-2 text-zinc-100 shadow-xl backdrop-blur">
          {towns === null && (
            <div className="px-2 py-1 text-zinc-400">Loading…</div>
          )}
          {towns?.map((t) => (
            <Link
              key={t.id}
              href={`/${t.slug}`}
              className={`block rounded px-2 py-1 hover:bg-zinc-800 ${
                t.slug === activeSlug ? "bg-zinc-800" : ""
              }`}
              onClick={() => setOpen(false)}
            >
              <div className="flex items-center justify-between">
                <span>{t.name}</span>
                <span className="text-xs text-zinc-400">
                  {t.aura.current} / {t.aura.max}
                </span>
              </div>
            </Link>
          ))}
          <div className="my-1 border-t border-zinc-700" />
          <button
            onClick={() => {
              setOpen(false);
              setShowModal(true);
            }}
            className="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800"
          >
            + New town
          </button>
          <div className="mt-2 border-t border-zinc-700 pt-1 text-xs text-zinc-500">
            Log out to switch CORE workspace.
          </div>
        </div>
      )}
      {showModal && (
        <NewTownModal onClose={() => setShowModal(false)} />
      )}
    </div>
  );
}

function NewTownModal({ onClose }: { onClose: () => void }) {
  const cmd = "npx town new";
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[420px] rounded-lg bg-zinc-900 p-5 text-zinc-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Create a new town</h2>
        <p className="mt-2 text-sm text-zinc-300">
          Towns are created from the CLI to keep authoring close to
          your editor.
        </p>
        <div className="mt-3 flex items-center gap-2 rounded border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm">
          <code className="flex-1">{cmd}</code>
          <button
            onClick={copy}
            className="rounded bg-zinc-800 px-2 py-1 text-xs hover:bg-zinc-700"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="mt-4 text-right">
          <button
            onClick={onClose}
            className="rounded bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Mount in `TownGame.tsx`**

```bash
grep -n "export function TownGame" apps/web/src/ui/TownGame.tsx
```

Open the file at that line. Add this near the top-left HUD slot
inside the returned JSX (next to whatever wraps the existing
on-screen UI overlays), passing the current slug from props:

```tsx
import { TownSwitcher } from "./TownSwitcher";
// ...
{viewerMode !== "visitor" && (
  <TownSwitcher activeSlug={townSlug} />
)}
```

(Don't render the switcher for read-only visitors.)

- [ ] **Step 3: Visual smoke check**

```bash
pnpm dev
```

Sign in, visit `/{slug}`. Confirm: the switcher pill renders
top-left, opens on click, shows the town with `1000 / 1000`, and
the "+ New town" modal copies the command.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/ui/TownSwitcher.tsx apps/web/src/ui/TownGame.tsx
git commit -m "feat(web): town switcher popover + new-town modal"
```

---

## Task 14: CLI shared `scaffold.ts` module

**Files:**
- Create: `packages/town-cli/src/shared/scaffold.ts`

**Interfaces:**
- Consumes: existing `town-io.ts` helpers (`writeTownJson`,
  `writeCustomPlot`, `writeNpcMdx`, `writeItemsDir`),
  `seed-npcs.ts` helpers (`fetchCoreWorkspace`, `writeDefaultNpcs`),
  `readme.ts` (`townFolderReadme`).
- Produces:
  - `scaffoldNew(pat, targetDir, coreUrl): Promise<void>`
  - `cloneExisting(townUrl, pat, targetDir, slug?): Promise<TownGetResponse>`
  - Shared `TownGetResponse` type re-exported.

- [ ] **Step 1: Extract from `init.ts`**

Open `packages/town-cli/src/commands/init.ts`. Cut the bodies of
`scaffoldNew` (lines 140-166) and `cloneExisting` (lines 168-209)
plus the `TownGetResponse` interface, `getJson`, and any helpers
they share. Paste into a new file:

```ts
// packages/town-cli/src/shared/scaffold.ts
//
// Reusable scaffolders shared by `town new` and `town clone`.

import * as p from "@clack/prompts";
import chalk from "chalk";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { townFolderReadme } from "./readme.js";
import { fetchCoreWorkspace, writeDefaultNpcs } from "./seed-npcs.js";
import {
  writeCustomPlot,
  writeItemsDir,
  writeNpcMdx,
  writeTownJson,
  type CustomPlotDTO,
  type NpcDTO,
  type TownBuilding,
  type TownItemBundle,
  type TownTagDef,
} from "./town-io.js";

export interface TownGetResponse {
  buildings: TownBuilding[];
  customPlots: CustomPlotDTO[];
  npcs: Array<NpcDTO & { id: string }>;
  version: number;
  catalog?: {
    tags: TownTagDef[];
    items: TownItemBundle[];
  };
}

interface DefaultBuilding {
  id: string;
  plotKey: string;
}

const DEFAULT_BUILDINGS: DefaultBuilding[] = [
  { id: "home", plotKey: "home" },
  { id: "library", plotKey: "library" },
  { id: "store", plotKey: "store" },
];

export async function getJson<T>(url: string, pat: string): Promise<T> {
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${pat}` },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`GET ${url} → ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as T;
}

export async function postJson<T>(
  url: string,
  pat: string,
  body: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${pat}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let parsed: { error?: string } = {};
    try {
      parsed = (await res.json()) as { error?: string };
    } catch {
      /* ignore */
    }
    throw new Error(`POST ${url} → ${res.status} ${parsed.error ?? "unknown"}`);
  }
  return (await res.json()) as T;
}

export async function ensureSlugDir(
  targetDir: string,
  slug: string,
): Promise<void> {
  if (!existsSync(targetDir)) {
    await mkdir(targetDir, { recursive: true });
    return;
  }
  const entries = await readdir(targetDir);
  const reserved = new Set([
    "town.json",
    "plot.json",
    "README.md",
    "AGENTS.md",
    "catalog.json",
    "manifest.json",
    "npcs",
    "customPlots",
  ]);
  const conflicts = entries.filter((e) => reserved.has(e));
  if (conflicts.length === 0) return;
  const ok = (await p.confirm({
    message: `${slug}/ already has ${conflicts.join(", ")} — overwrite?`,
    initialValue: false,
  })) as boolean;
  if (!ok) {
    p.cancel("Aborted");
    process.exit(1);
  }
}

export async function scaffoldNew(
  pat: string,
  targetDir: string,
  coreUrl: string,
): Promise<void> {
  await writeTownJson(targetDir, { buildings: DEFAULT_BUILDINGS });
  await mkdir(join(targetDir, "customPlots"), { recursive: true });

  const spinner = p.spinner();
  spinner.start("Fetching workspace name…");
  const workspace = await fetchCoreWorkspace(coreUrl, pat);
  spinner.stop(
    workspace
      ? chalk.green(`Butler name set to ${workspace.name}`)
      : chalk.yellow("Workspace lookup skipped — butler defaults to Hudson"),
  );
  await writeDefaultNpcs(targetDir, workspace?.name ?? null);
  await writeFile(join(targetDir, "README.md"), townFolderReadme());
}

export async function cloneExisting(
  townUrl: string,
  pat: string,
  targetDir: string,
  slug?: string,
): Promise<TownGetResponse> {
  const spinner = p.spinner();
  spinner.start("Fetching town…");
  const qs = slug ? `?slug=${encodeURIComponent(slug)}` : "";
  const town = await getJson<TownGetResponse>(
    `${townUrl}/api/town${qs}`,
    pat,
  );
  const catalogTags = town.catalog?.tags ?? [];
  const catalogItems = town.catalog?.items ?? [];
  spinner.stop(
    chalk.green(
      `Fetched town v${town.version} — ${town.buildings.length} building(s), ` +
        `${town.customPlots.length} customPlot(s), ${town.npcs.length} NPC(s)` +
        (town.catalog
          ? `, ${catalogTags.length} tag(s), ${catalogItems.length} item template(s)`
          : ""),
    ),
  );

  await writeTownJson(targetDir, {
    buildings: town.buildings,
    ...(catalogTags.length > 0 ? { tags: catalogTags } : {}),
  });
  await mkdir(join(targetDir, "customPlots"), { recursive: true });
  for (const cp of town.customPlots) {
    await writeCustomPlot(targetDir, cp);
  }
  await mkdir(join(targetDir, "npcs"), { recursive: true });
  for (const npc of town.npcs) {
    await writeNpcMdx(targetDir, npc);
  }
  if (catalogItems.length > 0) {
    await writeItemsDir(targetDir, catalogItems);
  }
  await writeFile(join(targetDir, "README.md"), townFolderReadme());

  return town;
}
```

- [ ] **Step 2: Typecheck the CLI package**

```bash
pnpm --filter @town/cli run typecheck
```

Expected: clean (the new file is self-contained; `init.ts` still
imports its pre-extraction copies, so don't worry about it
breaking yet — Task 18 deletes `init.ts`).

- [ ] **Step 3: Commit**

```bash
git add packages/town-cli/src/shared/scaffold.ts
git commit -m "refactor(cli): extract shared scaffold helpers"
```

---

## Task 15: `town new` command

**Files:**
- Create: `packages/town-cli/src/commands/new.ts`
- Modify: `packages/town-cli/src/cli.ts` (register)

**Interfaces:**
- Consumes: `scaffoldNew`, `ensureSlugDir`, `postJson` from
  `shared/scaffold.ts`.
- Produces: `npx town new` creates a town on the server and
  scaffolds `<cwd>/<slug>/`.

- [ ] **Step 1: Write `commands/new.ts`**

```ts
// `town new` — create a fresh town and scaffold the local edit
// folder. Replaces the create-half of the old `town init`.

import { Command } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { resolve } from "node:path";

import { getConfig } from "../config.js";
import {
  ensureSlugDir,
  postJson,
  scaffoldNew,
} from "../shared/scaffold.js";

interface CreatedTown {
  town: { id: string; slug: string; name: string };
}

async function runNew(): Promise<void> {
  p.intro(chalk.bgCyan(chalk.black(" town new ")));

  const cfg = getConfig();
  if (!cfg.auth?.pat || !cfg.auth.townUrl) {
    p.cancel("Not logged in — run `town login` first.");
    process.exit(1);
  }
  const { townUrl, pat, coreUrl } = cfg.auth;

  const name = (await p.text({
    message: "Town name",
    placeholder: "My Town",
    validate: (v) =>
      v && v.trim().length > 0 ? undefined : "Name can't be empty",
  })) as string;
  if (p.isCancel(name)) {
    p.cancel("new cancelled");
    return;
  }

  const spinner = p.spinner();
  spinner.start("Creating town on the server…");
  let created: CreatedTown;
  try {
    created = await postJson<CreatedTown>(
      `${townUrl}/api/towns/me`,
      pat,
      { name: name.trim() },
    );
  } catch (err) {
    spinner.stop(chalk.red("Town creation failed"));
    p.outro(chalk.red(err instanceof Error ? err.message : "unknown error"));
    process.exit(1);
  }
  spinner.stop(
    chalk.green(`Created ${created.town.name} (/${created.town.slug})`),
  );

  const targetDir = resolve(process.cwd(), created.town.slug);
  await ensureSlugDir(targetDir, created.town.slug);
  await scaffoldNew(pat, targetDir, coreUrl);

  p.log.success(`Scaffolded ./${created.town.slug}/ with the day-zero trio`);
  p.outro(
    chalk.green(
      `Edit ${created.town.slug}/town.json (+ customPlots / npcs), then run \`town deploy\` from inside ${created.town.slug}/.`,
    ),
  );
}

export function registerNew(program: Command): void {
  program
    .command("new")
    .description(
      "Create a brand-new town and scaffold a local edit folder",
    )
    .action(async () => {
      await runNew();
    });
}
```

- [ ] **Step 2: Register in `cli.ts`**

Edit `packages/town-cli/src/cli.ts`:

```ts
import { registerLogin } from "./commands/login.js";
import { registerNew } from "./commands/new.js";
import { registerDeploy } from "./commands/deploy.js";
// ...
registerLogin(program);
registerNew(program);
registerDeploy(program);
```

(Other registrations land in later tasks.)

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @town/cli run typecheck
```

Expected: `new.ts` is clean. `init.ts` is still in the build but
unused — leave for Task 18.

- [ ] **Step 4: Smoke check (end-to-end)**

```bash
pnpm --filter @town/cli run build
node packages/town-cli/dist/cli.js new
```

Expected: prompts for a town name, calls `POST /api/towns/me`
against the local dev server, scaffolds the folder.

- [ ] **Step 5: Commit**

```bash
git add packages/town-cli/src/commands/new.ts packages/town-cli/src/cli.ts
git commit -m "feat(cli): town new"
```

---

## Task 16: `town clone` command

**Files:**
- Create: `packages/town-cli/src/commands/clone.ts`
- Modify: `packages/town-cli/src/cli.ts` (register)

**Interfaces:**
- Consumes: `cloneExisting`, `ensureSlugDir`, `getJson` from
  `shared/scaffold.ts`.
- Produces: `npx town clone --slug <slug>` (or no flag when the
  user owns exactly one town).

- [ ] **Step 1: Write `commands/clone.ts`**

```ts
// `town clone` — pull an existing owned town into a local folder.

import { Command } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { resolve } from "node:path";

import { getConfig } from "../config.js";
import {
  cloneExisting,
  ensureSlugDir,
  getJson,
} from "../shared/scaffold.js";

interface TownsMineResponse {
  towns: Array<{
    id: string;
    slug: string;
    name: string;
  }>;
}

async function runClone(opts: { slug?: string }): Promise<void> {
  p.intro(chalk.bgCyan(chalk.black(" town clone ")));

  const cfg = getConfig();
  if (!cfg.auth?.pat || !cfg.auth.townUrl) {
    p.cancel("Not logged in — run `town login` first.");
    process.exit(1);
  }
  const { townUrl, pat } = cfg.auth;

  const list = await getJson<TownsMineResponse>(
    `${townUrl}/api/towns/mine`,
    pat,
  );
  if (list.towns.length === 0) {
    p.outro(chalk.red("No towns to clone. Run `town new` first."));
    process.exit(1);
  }

  let slug = opts.slug;
  if (!slug) {
    if (list.towns.length === 1) {
      slug = list.towns[0]!.slug;
      const ok = (await p.confirm({
        message: `Clone ${list.towns[0]!.name} into ./${slug}/?`,
        initialValue: true,
      })) as boolean;
      if (p.isCancel(ok) || !ok) {
        p.cancel("clone cancelled");
        return;
      }
    } else {
      p.log.warn("You own more than one town. Re-run with --slug:");
      for (const t of list.towns) {
        p.log.message(`  • ${t.slug}  (${t.name})`);
      }
      process.exit(1);
    }
  } else {
    const match = list.towns.find((t) => t.slug === slug);
    if (!match) {
      p.log.error(`You don't own a town with slug "${slug}". Yours:`);
      for (const t of list.towns) {
        p.log.message(`  • ${t.slug}  (${t.name})`);
      }
      process.exit(1);
    }
  }

  const targetDir = resolve(process.cwd(), slug);
  await ensureSlugDir(targetDir, slug);
  await cloneExisting(townUrl, pat, targetDir, slug);

  p.log.success(`Cloned town into ./${slug}/`);
  p.outro(
    chalk.green(`Edit, then run \`town deploy\` from inside ${slug}/.`),
  );
}

export function registerClone(program: Command): void {
  program
    .command("clone")
    .description("Pull an existing owned town into a local folder")
    .option("--slug <slug>", "Slug of the town to clone")
    .action(async (opts: { slug?: string }) => {
      await runClone(opts);
    });
}
```

- [ ] **Step 2: Register**

```ts
import { registerClone } from "./commands/clone.js";
// ...
registerClone(program);
```

- [ ] **Step 3: Typecheck + smoke**

```bash
pnpm --filter @town/cli run typecheck
pnpm --filter @town/cli run build
node packages/town-cli/dist/cli.js clone --slug some-slug
```

Expected: prints owned-towns list if `--slug` mismatch; clones
into `./some-slug/` on hit.

- [ ] **Step 4: Commit**

```bash
git add packages/town-cli/src/commands/clone.ts packages/town-cli/src/cli.ts
git commit -m "feat(cli): town clone --slug"
```

---

## Task 17: `town catalog` command

**Files:**
- Create: `packages/town-cli/src/commands/catalog.ts`
- Modify: `packages/town-cli/src/cli.ts` (register)

**Interfaces:**
- Consumes: `GET /api/catalog` (Task 11), `GET /api/town?slug=`,
  `catalogSummary` util.
- Produces: machine-parseable global + per-town catalog dumps.

- [ ] **Step 1: Write the command**

```ts
// `town catalog` — print available plotKeys (and per-town tags +
// item templates when --slug is provided). Reuses the shared
// catalog summary util.

import { Command } from "commander";
import * as p from "@clack/prompts";
import chalk from "chalk";

import { getConfig } from "../config.js";
import { getJson } from "../shared/scaffold.js";

interface CatalogResponse {
  plotKeys: Array<{
    key: string;
    category: string;
    widthTiles: number;
    heightTiles: number;
    variants: Array<{ id: string; exteriorSprite: string }>;
    npcSlots: Array<{ id: string; tx: number; ty: number }>;
  }>;
}

interface TownGetResponse {
  catalog?: {
    tags: Array<{ id: string; label: string }>;
    items: Array<{ id: string; label: string }>;
  };
}

async function runCatalog(opts: { slug?: string }): Promise<void> {
  p.intro(chalk.bgCyan(chalk.black(" town catalog ")));

  const cfg = getConfig();
  if (!cfg.auth?.pat || !cfg.auth.townUrl) {
    p.cancel("Not logged in — run `town login` first.");
    process.exit(1);
  }
  const { townUrl, pat } = cfg.auth;

  const global = await getJson<CatalogResponse>(
    `${townUrl}/api/catalog`,
    pat, // catalog is public; PAT is harmless extra header
  );

  p.log.message(chalk.bold("Buildings (plotKeys):"));
  for (const k of global.plotKeys) {
    p.log.message(
      `  ${k.key.padEnd(18)} ${k.category.padEnd(10)} ` +
        `${k.widthTiles}×${k.heightTiles}  ` +
        `${k.variants.length} variant(s), ${k.npcSlots.length} slot(s)`,
    );
  }

  if (opts.slug) {
    const town = await getJson<TownGetResponse>(
      `${townUrl}/api/town?slug=${encodeURIComponent(opts.slug)}`,
      pat,
    );
    p.log.message("");
    p.log.message(chalk.bold(`Per-town catalog for /${opts.slug}:`));
    const tags = town.catalog?.tags ?? [];
    const items = town.catalog?.items ?? [];
    p.log.message(`  Tags (${tags.length}):`);
    for (const t of tags) p.log.message(`    ${t.id.padEnd(20)} ${t.label}`);
    p.log.message(`  Items (${items.length}):`);
    for (const it of items)
      p.log.message(`    ${it.id.padEnd(20)} ${it.label}`);
  }

  p.outro(chalk.green("Done."));
}

export function registerCatalog(program: Command): void {
  program
    .command("catalog")
    .description("Print the global catalog (and per-town tags/items with --slug)")
    .option("--slug <slug>", "Also dump the named town's catalog")
    .action(async (opts: { slug?: string }) => {
      await runCatalog(opts);
    });
}
```

- [ ] **Step 2: Register**

```ts
import { registerCatalog } from "./commands/catalog.js";
// ...
registerCatalog(program);
```

- [ ] **Step 3: Typecheck + smoke**

```bash
pnpm --filter @town/cli run typecheck
pnpm --filter @town/cli run build
node packages/town-cli/dist/cli.js catalog
```

Expected: prints a list of available buildings with dimensions
and variant counts.

- [ ] **Step 4: Commit**

```bash
git add packages/town-cli/src/commands/catalog.ts packages/town-cli/src/cli.ts
git commit -m "feat(cli): town catalog"
```

---

## Task 18: `town deploy --slug`

**Files:**
- Modify: `packages/town-cli/src/commands/deploy.ts`

**Interfaces:**
- Consumes: `GET /api/towns/mine`, `POST /api/town?slug=`.
- Produces: deploy targets the named slug or the only-owned slug.

- [ ] **Step 1: Edit `deploy.ts`**

Find `runDeploy` and update the option signature to include
`slug?: string`. After the auth check, add slug resolution:

```ts
async function resolveDeploySlug(
  townUrl: string,
  pat: string,
  flag: string | undefined,
  dir: string,
): Promise<string> {
  if (flag) return flag;
  // Default to the folder name; town init / clone / new always
  // materialise into <cwd>/<slug>/.
  const folderSlug = dir.split("/").filter(Boolean).pop() ?? "";
  if (folderSlug) return folderSlug;
  throw new Error("Could not infer --slug from the current directory");
}
```

Inside `runDeploy`, after the dir validity check, resolve the
slug:

```ts
const slug = await resolveDeploySlug(townUrl, pat, opts.slug, dir);
```

Then everywhere the POST URL is built, append the slug:

```ts
const url = opts.reflow
  ? `${townUrl}/api/town?slug=${encodeURIComponent(slug)}&reflow=1`
  : `${townUrl}/api/town?slug=${encodeURIComponent(slug)}`;
```

Update the `option(...)` chain at the bottom:

```ts
program
  .command("deploy")
  .description("Upload local town.json + customPlots + npcs to the server")
  .option("-d, --dir <path>", "Folder containing town.json (defaults to CWD).")
  .option("--slug <slug>", "Town slug to deploy to (default: infer from folder).")
  .option("--reflow", "Wipe the server-side plot before applying.")
  .action(async (opts: { dir?: string; reflow?: boolean; slug?: string }) => {
    await runDeploy(opts);
  });
```

- [ ] **Step 2: Typecheck + smoke**

```bash
pnpm --filter @town/cli run typecheck
pnpm --filter @town/cli run build
cd /tmp && mkdir -p town-deploy-test && cd town-deploy-test
# After running `town new` in this dir, then `town deploy`:
node /Users/harshithmullapudi/Documents/town-next/packages/town-cli/dist/cli.js deploy --slug my-test-slug
```

Expected: deploy posts to `/api/town?slug=my-test-slug`. If the
caller doesn't own that slug, server returns 404.

- [ ] **Step 3: Commit**

```bash
git add packages/town-cli/src/commands/deploy.ts
git commit -m "feat(cli): town deploy --slug"
```

---

## Task 19: Drop `town init`, register migration alias, bump version

**Files:**
- Modify: `packages/town-cli/src/commands/init.ts` (downgrade to a
  hint message)
- Modify: `packages/town-cli/src/cli.ts`
- Modify: `packages/town-cli/package.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `npx town init` prints the migration message + exits
  non-zero. Version bumps to `0.2.0`.

- [ ] **Step 1: Rewrite `init.ts` as a hint alias**

Replace the file contents with:

```ts
// `town init` is removed in 0.2.0. This stub keeps the verb
// registered so users get a clear migration message.

import { Command } from "commander";
import chalk from "chalk";

export function registerInit(program: Command): void {
  program
    .command("init")
    .description("[REMOVED] Use `town new` or `town clone` instead")
    .action(() => {
      console.error(
        chalk.red(
          "`town init` has been replaced. Use `town new` to create a town " +
            "or `town clone` to pull an existing one.",
        ),
      );
      process.exit(1);
    });
}
```

- [ ] **Step 2: Update `cli.ts`**

Ensure `registerInit` is imported and registered so the alias
fires. Final `cli.ts` reads:

```ts
import { Command } from "commander";
import { registerLogin } from "./commands/login.js";
import { registerNew } from "./commands/new.js";
import { registerClone } from "./commands/clone.js";
import { registerCatalog } from "./commands/catalog.js";
import { registerDeploy } from "./commands/deploy.js";
import { registerInit } from "./commands/init.js";

const program = new Command();

program
  .name("town")
  .description("Build, edit, and deploy your CORE town.")
  .version("0.2.0");

registerLogin(program);
registerNew(program);
registerClone(program);
registerCatalog(program);
registerDeploy(program);
registerInit(program);

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
```

- [ ] **Step 3: Bump version**

Edit `packages/town-cli/package.json`:

```json
"version": "0.2.0",
```

- [ ] **Step 4: Build + smoke**

```bash
pnpm --filter @town/cli run build
node packages/town-cli/dist/cli.js --version    # → 0.2.0
node packages/town-cli/dist/cli.js init         # → migration message, exit 1
node packages/town-cli/dist/cli.js --help       # → new, clone, catalog, deploy listed
```

- [ ] **Step 5: Commit**

```bash
git add packages/town-cli/src/commands/init.ts packages/town-cli/src/cli.ts packages/town-cli/package.json
git commit -m "chore(cli): bump to 0.2.0 (town init removed)"
```

---

## Task 20: End-to-end smoke + release notes

**Files:**
- Modify: `README.md` (changelog/migration notes — optional).
- Modify: `packages/town-cli/README.md` if it exists (optional).

**Interfaces:**
- Consumes: every preceding task.
- Produces: a single happy-path sanity check covering everything.

- [ ] **Step 1: Full happy path**

```bash
pnpm dev
```

In another shell:

```bash
node packages/town-cli/dist/cli.js login           # OAuth round-trip
node packages/town-cli/dist/cli.js new              # → enter "Test One"
cd test-one
node packages/town-cli/dist/cli.js deploy
cd ..
node packages/town-cli/dist/cli.js new              # → enter "Test Two"
node packages/town-cli/dist/cli.js clone --slug test-one
node packages/town-cli/dist/cli.js catalog
node packages/town-cli/dist/cli.js catalog --slug test-one
```

Expected: every command succeeds; both towns visible at
`http://localhost:3000/test-one` and `/test-two`; the top-left
switcher lists both with aura `1000 / 1000`; the active-slug
cookie is set after each visit.

- [ ] **Step 2: Run the full typecheck and build**

```bash
pnpm typecheck
pnpm build
```

Expected: both clean.

- [ ] **Step 3: Add a short release note**

Add to the top of `README.md` (or whichever changelog file the
project uses):

```markdown
## 0.2.0 — Multi-town foundation

- A CORE user can own multiple towns. Identity is now
  `(coreUserId, workspaceId)`; signing in via a different
  workspace creates a separate town-next account.
- New CLI verbs: `town new`, `town clone --slug`, `town catalog`.
  `town init` is removed (prints a migration hint).
- `town deploy` accepts `--slug`; without it, infers from the
  folder name.
- New `Aura` table (per-town energy, defaults `1000/1000`). Not
  yet consumed.
- New endpoints: `GET /api/towns/mine`, `GET /api/catalog`.
- DB migration preserves existing data via backfill — `pnpm
  db:migrate dev` is enough; no `reset` required.
```

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: 0.2.0 release notes"
```

---

## Spec coverage checklist

| Spec section | Task(s) |
|---|---|
| Identity `(coreUserId, workspaceId)` | 2, 5 |
| User ↔ Town 1:N, drop `@unique` ownerId | 2, 3 |
| No `Town.workspaceId` column | 2 |
| `Aura` table (1000/1000 default) | 2, 3 |
| `PlotRow.townId` PK | 2, 4 |
| `Npc.townId` | 2, 4 |
| `PlotSuggestion.townId` | 2 |
| OAuth callback composite upsert | 5 |
| `auth-bearer` composite upsert | 5 |
| `GET /api/towns/mine` | 7 |
| `POST /api/towns/me` allows N + creates Aura | 8 (POST), 3 (Aura tx) |
| `GET/POST /api/town?slug=` | 9 |
| `GET/POST /api/plot?slug=` | 10 |
| Shared resolver helper | 10 |
| `GET /api/catalog` (public, cached) | 11 |
| Active-slug cookie | 6, 12 |
| Root `/` redirects to active town | 12 |
| `<TownSwitcher>` HUD popover | 13 |
| "+ New town" modal | 13 |
| CLI shared scaffold | 14 |
| `town new` | 15 |
| `town clone [--slug]` | 16 |
| `town catalog [--slug]` | 17 |
| `town deploy --slug` | 18 |
| Remove `town init` + hint | 19 |
| Version bump 0.2.0 | 19 |
| Release notes | 20 |
| Schema test (operator-driven via DB reset + happy path) | 20 |
