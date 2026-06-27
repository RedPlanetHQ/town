# Multi-Town Foundation

Date: 2026-06-27
Status: Draft for review

## Why

Today town-next is hard-coded to one town per user (`Town.ownerId` is
`@unique`, `PlotRow.userId` is the PK, NPCs/sprites/etc. all key on
`userId`). The next wave of work — `town new` chat creator, Aura
economy, and workspace-attached showcases — needs the data model to
allow **multiple towns per CORE-user-in-a-workspace**.

We pick the **simplest possible identity model**: a town-next account
is keyed by `(coreUserId, workspaceId)`. If the same CORE user signs
in via a *different* workspace, a fresh town-next account is created.
No cross-workspace switcher, no CORE workspaces API call, no
denormalised `Town.workspaceId`. The workspace is implicit on the
owning `User` row.

This spec lands the *foundation* only: schema migration, web town
switcher, CLI verb split, catalog endpoint, and an Aura table. AI
ops, top-ups, tier upgrades, the `town new` chat flow, and the
sprite-gen backend are explicitly deferred to follow-up specs.

## Goals

1. A town-next account is `(coreUserId, workspaceId)`-unique, and a
   single account can own N towns.
2. Logging in via the same CORE user but a different workspace
   creates a brand-new town-next account — no shared identity, no
   cross-workspace UI.
3. The web app shows a top-left town switcher to flip between the
   current account's towns and points users at the CLI for creation.
4. The CLI exposes `town new`, `town clone`, and `town deploy`, each
   operating on a named slug. `town init` is removed.
5. Every town has an `Aura` row (separate table) with `current` and
   `max` both defaulting to 1000, so later sub-projects can debit /
   refill / upgrade without re-migrating `Town`.
6. The global catalog (plotKeys, variants, NPC slot positions,
   interior dimensions) is exposed through a read-only HTTP endpoint
   so the CLI — and, later, the chat-creator agent — can derive
   `town.json` and custom plots without bundling the manifest.
7. Existing single-town users migrate cleanly with no data loss.

## Non-goals

- Aura debits, top-ups, tier upgrades, or a ledger / audit log.
- The `pi-tui` chat creator inside `town new`, site-crawl tooling,
  and the "clone from a public template" flavour of `town clone`
  (v1 only pulls towns the caller owns).
- Sprite-gen backend / paid sprite generation.
- Workspace-membership sync from CORE. We only know the workspace
  the user is currently signed into (it's pinned on the `User` row).
- Cross-workspace town visibility. Towns owned by a different
  town-next account (same CORE user, different workspace) are
  invisible — log out and log back in via that workspace to reach
  them.
- Cross-user town visibility (workspace teammates browsing each
  other's towns). v1 still gates on `Town.ownerId == user.id`.
- Any CORE workspaces-list API call. The OAuth `userinfo`
  `workspace_id` field is the only workspace signal we use.

## Locked decisions

- **Identity:** a town-next `User` row is unique on
  `(coreUserId, workspaceId)`. The current `@unique` on
  `coreUserId` is replaced. A user with no workspace yet (legacy
  rows pre-migration) is treated as `workspaceId = NULL` until
  their next login fills it.
- **Per-workspace accounts:** the same CORE user signing in via a
  different workspace produces a brand-new town-next `User`,
  `Session`, and town set. No UI lets you flip between them; the
  way to switch is to log out and log back in via CORE selecting
  the other workspace.
- **User ↔ Town:** 1:N. Drop the `@unique` on `Town.ownerId`.
- **Workspace ↔ Town:** implicit — a town belongs to its owner's
  workspace. No `Town.workspaceId` column.
- **Active town persistence:** cookie `town:active-slug` (path
  `/`, SameSite=Lax, 30-day TTL). Wins over "last visited URL"
  because it survives a fresh tab and lets the root `/` route
  redirect cheaply.
- **Aura lives in its own table** (not on `Town`). Lets the
  follow-up ledger spec evolve the row without touching `Town`.

## Schema changes

### `User` — composite identity

```prisma
model User {
  id          String   @id @default(cuid())
  coreUserId  String                                  // was @unique — removed
  email       String
  name        String
  workspaceId String?                                 // NULL only on legacy rows; required for new sign-ups
  character   String?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  sessions     Session[]
  townEvents   TownEventRow[]
  integrations IntegrationRow[]
  aspects      AspectRow[]
  labels       LabelRow[]
  suggestions  PlotSuggestion[]
  sprites      Sprite[]
  towns        Town[]                                 // was singular `town Town?`

  @@unique([coreUserId, workspaceId])                 // composite identity
  @@index([email])
}
```

The OAuth callback's upsert switches from
`where: { coreUserId }` to `where: { coreUserId_workspaceId: { coreUserId, workspaceId } }`.

### `Town` — drop unique on owner

```prisma
model Town {
  id          String   @id @default(cuid())
  slug        String   @unique
  name        String
  ownerId     String                                  // was @unique — removed
  owner       User     @relation(fields: [ownerId], references: [id], onDelete: Cascade)
  shareCode   String   @unique

  catalogJson Json?
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  aura          Aura?                                 // NEW — 1:1
  plot          PlotRow?
  conversations Conversation[]
  npcs          Npc[]                                 // NEW relation

  @@index([ownerId])
}
```

No `workspaceId` column. A town's workspace is its
`owner.workspaceId`.

### `Aura` — new table, 1:1 with Town

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

A town is considered "out of aura" when `current == 0`. The v1
spec does not consume aura — debit logic lives in the ledger
sub-project — but readers (CLI status, web HUD) display
`current / max` from this row.

### `PlotRow` — repivot to `townId` PK

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

Drop `userId` and the `User.plot` back-relation. A plot belongs to a
town; users don't own plots directly.

### `Npc` — pivot to `townId`

```prisma
model Npc {
  id          String   @id @default(cuid())
  townId      String                                  // was userId
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

Drop `userId` and `User.npcs`.

### `PlotSuggestion` — add `townId`

```prisma
model PlotSuggestion {
  id            String    @id @default(cuid())
  userId        String                                // kept — author / approver
  user          User      @relation(fields: [userId], references: [id], onDelete: Cascade)
  townId        String                                // NEW — which town this targets
  town          Town      @relation(fields: [townId], references: [id], onDelete: Cascade)
  kind          String
  status        String    @default("pending")
  payload       Json
  reason        String
  sourceEventId String?
  createdAt     DateTime  @default(now())
  resolvedAt    DateTime?

  @@index([townId, status])
  @@index([userId, status])
}
```

### Unchanged (intentionally user-scoped)

- `Sprite` — user-uploaded assets, reusable across the user's towns.
- `Aspect`, `Integration`, `Label`, `TownEventRow` — mirror CORE's
  per-user state, not per-town. The events worker that derives plot
  suggestions reads CORE state from these and writes
  `PlotSuggestion` rows keyed to the active town.
- `Conversation`, `Message`, `VisitorTag`, `VisitorItem`,
  `TownActivity`, `GroupMessage` — already town-scoped.

## Migration `20260627_multi_town_foundation`

Backfill-preserving migration. Existing data stays put. The whole
thing runs as a single Prisma migration whose `migration.sql`
chains DDL + data backfill + tightening:

1. **Add nullable columns + the `Aura` table.**
   - `PlotRow.townId TEXT NULL`
   - `Npc.townId TEXT NULL`
   - `PlotSuggestion.townId TEXT NULL`
   - `CREATE TABLE "Aura" (...)` with `current` / `max` defaulting
     to 1000.

2. **Backfill from today's invariant** (every `Town.ownerId` is
   unique, so every dependent row maps unambiguously to its
   owner's only town):

   ```sql
   UPDATE "PlotRow" SET "townId" = t.id
   FROM "Town" t WHERE t."ownerId" = "PlotRow"."userId";

   UPDATE "Npc" SET "townId" = t.id
   FROM "Town" t WHERE t."ownerId" = "Npc"."userId";

   UPDATE "PlotSuggestion" SET "townId" = t.id
   FROM "Town" t WHERE t."ownerId" = "PlotSuggestion"."userId";

   INSERT INTO "Aura" ("townId", "current", "max", "createdAt", "updatedAt")
   SELECT id, 1000, 1000, NOW(), NOW() FROM "Town";
   ```

3. **Hard-delete orphan rows** that pointed at no `Town`
   (pre-onboarding users; their state regenerates on next visit):

   ```sql
   DELETE FROM "PlotRow" WHERE "townId" IS NULL;
   DELETE FROM "Npc" WHERE "townId" IS NULL;
   DELETE FROM "PlotSuggestion" WHERE "townId" IS NULL;
   ```

4. **Tighten.**
   - `ALTER COLUMN "townId" SET NOT NULL` on PlotRow, Npc,
     PlotSuggestion.
   - Repivot `PlotRow`: drop the existing `PlotRow_pkey` (was
     `userId`), drop the `userId` column, add `townId` PK + FK +
     cascade.
   - Drop `Npc.userId` column and its FK + indexes; add `townId`
     FK and the three `townId`-prefixed indexes.
   - Add `PlotSuggestion.townId` FK + `@@index([townId, status])`.
   - Drop `Town_ownerId_key` (was unique); add `Town_ownerId_idx`.
   - Drop `User_coreUserId_key` (was unique); add the composite
     `User_coreUserId_workspaceId_key`. Today's coreUserId values
     are unique by themselves and PostgreSQL treats NULL as
     distinct, so the composite lands without collisions even
     while every existing user still has `workspaceId = NULL`.

Local dev workflow: `pnpm db:migrate dev` once the migration file
is committed (no reset required).

### Why backfill is safe

- Today's invariant is `Town.ownerId @unique`, so every `PlotRow`,
  `Npc`, and `PlotSuggestion` belongs to a user who has at most
  one `Town`. The four `UPDATE ... FROM "Town"` statements are
  unambiguous joins.
- Existing `User.workspaceId = NULL` rows survive the new
  composite unique because PostgreSQL unique constraints treat
  NULL as distinct, and `coreUserId` was unique on its own today.
  No two rows collide.
- Orphan dependent rows (user started onboarding but never
  reached `pickTown`, so no `Town` row) hard-delete during step
  3. Pre-onboarding state regenerates on next visit.

### Data-loss safety

- Operators **should** `pg_dump` the four affected tables
  (`User`, `Town`, `PlotRow`, `Npc`, `PlotSuggestion`) to S3
  before running in prod, even though the migration is
  data-preserving.
- The migration is rejected (via a failing `SELECT count(*) ...
  WHERE "townId" IS NULL` guard at the end of step 3) if any
  orphan delete missed.

### OAuth callback grace path

After the migration, existing `User` rows still have
`workspaceId = NULL`. On their next login, a vanilla
composite-key upsert would treat the incoming non-null
`workspaceId` as distinct from NULL and insert a brand-new row,
orphaning their towns. The callback runs a one-shot grace path
instead:

```ts
const workspaceId = info.workspace_id ?? null;

if (workspaceId) {
  // One-shot grace: adopt this login's workspace into the
  // pre-migration row instead of creating a duplicate. Only
  // ever fires until the row's workspaceId is filled.
  const legacy = await prisma.user.findFirst({
    where: { coreUserId: info.sub, workspaceId: null },
  });
  if (legacy) {
    return prisma.user.update({
      where: { id: legacy.id },
      data: { workspaceId, email, name },
    });
  }
}

return prisma.user.upsert({
  where: {
    coreUserId_workspaceId: { coreUserId: info.sub, workspaceId },
  },
  create: { coreUserId: info.sub, workspaceId, email, name },
  update: { email, name },
});
```

The same branch lives in `apps/web/src/lib/auth-bearer.ts` for
the PAT flow.

## Application changes

### OAuth callback (`apps/web/src/app/api/auth/callback/route.ts`)

Replaces today's `coreUserId`-only upsert with the composite-key
upsert plus the one-shot grace path that adopts pre-migration
`workspaceId = NULL` rows. See the **OAuth callback grace path**
subsection inside the migration section above for the exact code;
the same branch lives in `apps/web/src/lib/auth-bearer.ts` for
PAT-based requests.

### `apps/web/src/lib/town.ts`

- `getTownByOwner(userId)` → `getTownsByOwner(userId)` returns array.
- Add `getTownBySlug(slug)` (already used implicitly via the
  `/{slug}` page; promote to first-class export).
- Add `getActiveTownForUser(userId, fromCookie?)` — returns the
  user's last-visited town (cookie) or the most-recently-updated.

### `apps/web/src/app/page.tsx`

```ts
const session = await getSessionFromCookie();
if (!session) return <Landing />;
const active = await getActiveTownForUser(session.user.id, await readActiveSlugCookie());
if (active) redirect(`/${active.slug}`);
return <Onboarding userName={session.user.name} />;
```

### New endpoint: `GET /api/towns/mine`

```
GET /api/towns/mine
→ {
    towns: [
      {
        id, slug, name, updatedAt,
        aura: { current: 1000, max: 1000 }
      },
      ...
    ],
    activeSlug: string | null
  }
```

Reads owner from session/PAT, returns every owned town. `aura` is
inlined from the joined `Aura` row. The list is implicitly
workspace-scoped: a session belongs to one town-next account, which
belongs to one workspace.

### Updated endpoints (accept `?slug=`)

- `GET  /api/town?slug=<slug>`
- `POST /api/town?slug=<slug>`
- `GET  /api/plot?slug=<slug>`

If `?slug=` is absent: fall back to the user's *only* town if they
own exactly one (preserves existing single-town clients); otherwise
return `400 missing-slug` with the available slugs in the body so the
CLI can prompt.

All POSTs gate on `Town.ownerId === user.id` (and never on workspace
membership in v1 — owner-only writes).

### Endpoint kept as-is

- `GET /api/towns/me` — returns the *first* (oldest) owned town, or
  `null`. Now mostly used by `town clone` with no `--slug` to detect
  "this user only has one town, just clone it." Kept around so
  external integrations that already call it don't break.
- `POST /api/towns/me` — keep. Both `town new` and the older PAT-based
  callers use it to create a town. No longer enforces "one town per
  user" — the unique constraint on `Town.ownerId` is dropped in this
  migration.

### Top-left town switcher

New component `apps/web/src/ui/TownSwitcher.tsx`, mounted on
`/{slug}/page.tsx` in the existing HUD slot. Behavior:

- Pill button shows the active town's name + a chevron.
- Click opens a popover listing:
  - Each owned town (slug + name + aura bar `1000 / 1000`).
  - A separator.
  - "**+ New town**" → opens a modal.
- The modal shows:
  - `npx town new` — the v1 verb (plain prompt-driven scaffolder,
    see CLI section below). The pi-tui chat creator that this
    command will eventually open into ships in a follow-up spec.
  - A "Copy" button.
  - A note: "Towns are created from the CLI to keep authoring
    close to your editor."
- A subtle footer line in the popover shows the current account's
  workspace name + a "log out to switch workspace" link. No
  in-app workspace flip — that's a re-login.

### Active-slug persistence

- Cookie: `town:active-slug` (path `/`, SameSite=Lax, 30-day TTL).
- Written on every `/{slug}` render where the user owns the town.
- Read on the root `/` route to choose the redirect target.

## Catalog tools

The CLI — and, in a follow-up spec, the `town new` chat-creator
agent — both need to read the global catalog (plotKeys, variants,
NPC slot positions, interior dimensions) to construct `town.json`
and `customPlots/`. v1 exposes this as one HTTP endpoint plus a
thin CLI wrapper. The follow-up agent spec wires both into
function-call tools; the endpoint shape is the durable contract.

### `GET /api/catalog`

Public, read-only. Returns the global manifest in a tool-friendly
shape:

```
GET /api/catalog
→ {
    plotKeys: [
      {
        key: "library",
        category: "civic",
        widthTiles: 8,
        heightTiles: 6,
        variants: [
          { id: "library-basic", exteriorSprite: "..." },
          ...
        ],
        npcSlots: [
          { id: "front-desk", tx: 4, ty: 3 },
          ...
        ]
      },
      ...
    ]
  }
```

Sources from `loadManifest()` (`apps/web/src/lib/manifest.ts`).
`Cache-Control: public, max-age=300, stale-while-revalidate=60`
because the manifest only changes on deploy.

### Per-town catalog

Already returned inline by `GET /api/town?slug=<slug>` (the
existing `{ catalog: { tags, items } }` field on Town). No new
endpoint needed; agents and the CLI read it from the same town
fetch. v1 keeps the existing gating on `Town.ownerId === user.id`.

### `town catalog [--slug <slug>]` (new CLI command)

- Without `--slug`: print the global catalog summary (plotKey →
  human-readable label, variant count, NPC slot count). Reuses
  the existing `catalogSummary` util in
  `packages/town-cli/src/shared/catalog-summary.ts`.
- With `--slug`: additionally fetch the named town's catalog via
  `GET /api/town?slug=` and print tag + item summaries.

The output is intentionally machine-parseable (one row per
plotKey, tab-separated) so the future chat-creator agent can
pipe `town catalog` into its tool surface as a fallback when the
HTTP endpoint isn't reachable.

### Agent-tool readiness

The chat-creator spec will wrap these as function-call tools
(`list_catalog`, `get_town_catalog`). v1 has no agent, so the
tools themselves aren't built here — only the underlying
endpoint and CLI wrapper.

## CLI changes

`town init` is **removed**. Two new verbs replace it:

### `town new`

Create a brand-new town and scaffold the local edit folder.

Flow:
1. Prompt for a name (`p.text`). Slug is server-generated from the
   name (existing `pickTown` behaviour); the CLI surfaces it back.
2. `POST /api/towns/me { name }` to create the row. Workspace is
   implicit (the caller's `User.workspaceId`). The same transaction
   creates the matching `Aura` row (defaults 1000/1000).
3. Materialise `<cwd>/<slug>/` with the day-zero trio (home /
   library / store), seed default NPCs (current `scaffoldNew`
   logic, lifted from `init.ts`).
4. Print `Edit ${slug}/town.json …, then run \`town deploy\``.

No `--slug` flag — `town new` always creates and the slug is
server-derived. Works whether the caller has 0 or N existing towns.

### `town clone [--slug <slug>]`

Pull an existing owned town into a local folder.

Flow:
- With `--slug`: fetch + materialise the named town. 404 with the
  owned-towns list if the slug isn't owned by the caller.
- Without `--slug`:
  - Caller owns 0 towns → error: "No towns to clone. Run
    `town new` first."
  - Caller owns 1 town → confirm + clone it (preserves today's
    single-user UX).
  - Caller owns >1 town → print the owned-towns table and exit
    non-zero asking the user to re-run with `--slug`.

Reuses today's `cloneExisting()` logic from `init.ts` (renamed
into a shared module).

### `town deploy [--slug <slug>] [--dir <path>]`

- With `--slug`: deploy to the named town.
- Without `--slug`: infer the slug from the `<dir>` folder name
  (which equals the slug after `town clone` or `town new`).

### `town login` — unchanged.

### Removal grace

`town init` is dropped from `cli.ts` and the dist build. To soften
the break, the CLI registers a hidden alias that prints:

> `town init` has been replaced. Use `town new` to create a town or
> `town clone` to pull an existing one.

…and exits non-zero. We bump the package to `0.2.0` (breaking) and
mention this in the release notes.

## Testing

### Schema / migration

- **Backfill happy path.** Seed a snapshot with 3 users × 1 town
  × 1 plot × 2 NPCs × 1 PlotSuggestion each. Run the migration.
  Assert:
  - `User` has `@@unique([coreUserId, workspaceId])`; the bare
    `@unique` on `coreUserId` is gone.
  - `Town` has no `@unique` on `ownerId`, no `workspaceId`
    column.
  - Every `PlotRow.townId` populated; PK is `townId`; `userId`
    column is gone.
  - Every `Npc.townId` populated; `userId` column is gone; the
    three `townId`-prefixed indexes exist.
  - Every `PlotSuggestion.townId` populated; FK + `@@index([townId, status])`
    exist.
  - Every `Town` has a matching `Aura` row at `current=1000`,
    `max=1000`.
- **Orphan delete.** Seed an extra user with a `PlotRow` but no
  `Town` (simulating mid-onboarding state). Migration completes;
  that user's `PlotRow` is gone.
- **Aura on new towns.** Create a `Town` through `POST /api/towns/me`:
  assert a matching `Aura` row is created in the same
  transaction.
- **Composite identity isolation.** Simulate the same CORE user
  logging in via workspace A, then workspace B (post-migration):
  two `User` rows exist, fully isolated — towns, sprites,
  aspects, integrations, sessions all separate.
- **Grace path.** Pre-migration: one `User` row with
  `workspaceId = NULL` who owns a town. Run migration. Simulate
  their next login with `workspace_id = "ws_42"`: the row is
  updated in place; no duplicate is created; their town stays
  attached.

### API

- `GET /api/towns/mine` returns the right list for the owner; 401
  for unauthenticated; empty array for a user with no towns. Each
  row includes `aura: { current, max }`.
- `POST /api/town?slug=other-users-slug` from user A is rejected
  403.
- Cross-tenant `POST /api/plot?slug=...` is 403.
- `GET /api/town` without `?slug=` on a multi-town user returns 400
  with the available slugs.
- `GET /api/catalog` returns a non-empty `plotKeys` array with the
  expected day-zero entries (`home`, `library`, `store`); no auth
  required.
- `POST /api/towns/me { name }` creates both the `Town` and `Aura`
  rows in the same transaction; a failure on either rolls the other
  back.

### CLI

- `town new` on a 0-town user creates one and scaffolds the folder.
- `town new` on a 2-town user creates a third (no `--slug` flag).
- `town clone --slug` on a 2-town user materialises only the named
  town.
- `town clone` with no `--slug` on a 2-town user prints the list
  and exits non-zero.
- `town clone` with no `--slug` on a 1-town user clones it
  (preserves the existing single-town UX).
- `town deploy --slug` round-trips the named town and leaves the
  others untouched.
- `town catalog` prints the global plotKey summary.
- `town catalog --slug` adds the per-town tag + item summary.
- `town init` exits non-zero with the migration hint message.

### Web UI

- Town switcher lists all owned towns; clicking changes the route.
- Cookie persists active slug across reloads.
- "+ New town" modal shows the CLI command.

## Risks

- **Backfill correctness.** The migration relies on today's
  unique `Town.ownerId` to map dependent rows. Mitigation: a
  guard `SELECT count(*) ... WHERE "townId" IS NULL` after step
  3 aborts the migration if any orphan slipped through.
- **Migration-time write blip.** The `PlotRow` PK pivot is not
  online; brief deploy gate during the migration window.
- **Pre-onboarding orphans get hard-deleted.** Acceptable —
  state regenerates on next visit. Logged with a count for
  audit.
- **Hidden call sites.** `getTownByOwner` is referenced from
  multiple route handlers and lib helpers. Mitigation: rename it,
  not just replace its body — the type checker becomes the audit
  tool.
- **CLI breakage.** Users on `town@0.1.x` hit the `town init`
  removal hint and must `npm i -g @town/cli@latest`. Document
  in the release notes.

## Open questions

- **`GET /api/catalog` auth.** Currently spec'd as public because
  the manifest ships in the JS bundle anyway, but a future move
  to per-workspace catalog overrides would force this to become
  session-gated. Leave public for now; revisit when overrides land.
- **Per-town catalog endpoint shape.** v1 piggy-backs on `GET
  /api/town?slug=` (existing field). A dedicated `GET
  /api/towns/:slug/catalog` would be more agent-friendly. Defer
  the split until the chat-creator spec needs it.
- **Workspace display name on the switcher footer.** The OAuth
  `userinfo` exposes `workspace_id` but not necessarily a
  human-readable name. The CLI's `fetchCoreWorkspace` already
  resolves a name via a separate call (`packages/town-cli/src/shared/seed-npcs.ts`).
  We can mirror that on the web at login and stash the name on
  `User`. Defer to follow-up if it adds login latency.

## Follow-up specs

1. **Aura ledger + debits** — debit kinds, op pricing, top-up flow,
   tier upgrade SKU.
2. **`town new` chat creator** — pi-tui chat UI on top of the v1
   `town new` scaffolder, site-crawl tool, AI-driven NPC/building
   proposals.
3. **Sprite-gen backend** — endpoint, cost model, fail-graceful.
4. **Workspace membership sync** — pull memberships from CORE so
   workspace-mate towns are discoverable.
5. **Template-based `town clone`** — clone from a public town or a
   curated template (current `town clone` only pulls towns the
   caller owns).
6. **Workspace membership sync / unified switcher** — if/when CORE
   exposes a memberships API, fetch the list at login and offer a
   cross-workspace town picker without re-auth.
