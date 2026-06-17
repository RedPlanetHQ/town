<p align="center">
  <img src="apps/web/public/town_logo_light.svg" alt="town" width="120" />
</p>

<h1 align="center">town</h1>

<p align="center"><em>Your world, as a tiny pixel town that grows itself.</em></p>

<p align="center">
  <img src="docs/assets/screenshot-tenkai.png" alt="An overworld screenshot of a town named Tenkai — three buildings nestled in a dense forest, signpost reading 'Tenkai · Harshith Mullapudi · 2 miles'." width="780" />
</p>

The things you care about — fitness, films, art, the side project — turn into
buildings. Locals show up to live in them: a gym coach here, a film critic
there, whoever your world calls for. Give them personalities, plug them into
your tools, then share the address. Friends wander in, meet your locals, bump
into each other — and learn who you are faster than any profile.

Powered by [CORE](https://app.getcore.me). Rendered with
[kaplay](https://kaplayjs.com). Top-down, browser-native, deterministic from a
seed so your town stays *your* town across logins.

---

## Make it yours

Editing a town is the same as editing a folder. Two commands.

### 1. Log in

```bash
pnpm dlx @redplanethq/town login
```

Pick your CORE host (default `https://app.getcore.me`) and town server, then
authorize in the browser. The CLI saves a PAT to `~/.town/config.json` (mode
0600 — it's a credential).

### 2. Create or clone a town

```bash
town init
```

This is the only entry point — it decides what to do by asking the server:

- **No town yet?** It prompts you for a name and creates one. Folder gets
  scaffolded at `./<slug>/` with the day-zero trio (home / library / store)
  and an empty `customPlots/`.
- **Town already exists?** It confirms and clones into `./<slug>/` — your
  current buildings, customPlots, and NPC files materialize on disk.

Either way you end up with:

```
<slug>/
  town.json           ← buildings list + customPlots references
  customPlots/        ← one folder per user-defined plot
  npcs/               ← one .mdx per NPC (frontmatter = identity, body = prompt)
  catalog.json        ← slim reference of what's available
  manifest.json       ← decor sprite reference
  AGENTS.md           ← orientation for coding agents
```

### 3. Edit

Open `<slug>/town.json`:

```json
{
  "buildings": [
    { "id": "home",    "plotKey": "home" },
    { "id": "library", "plotKey": "library" },
    { "id": "store",   "plotKey": "store" }
  ],
  "customPlots": []
}
```

- **Add a building** → append `{ "id": "cafe", "plotKey": "cafe" }`.
- **Remove a building** → delete its entry.
- **Swap a variant** → add `"variantId": "cafe.bookshop"` (look up valid ids
  in `catalog.json`).

You never write tile coordinates, paths, ponds, or decor. The server picks a
free cell, routes a path from home, refills the surrounding forest. Re-deploy
twice and the same edit lands in the same spot — it's seeded.

NPCs work the same way: one MDX per building, drop a `<buildingId>.mdx` with
frontmatter (`name`, `description`, `buildingId`) and a prompt body.

### 4. Deploy

```bash
cd <slug>
town deploy
```

Uploads any new PNGs you added (more on that below), then POSTs the whole
shape to `/api/town`. The server diffs against your persisted plot and runs
the incremental layout ops — no full regenerations, no churn on untouched
buildings.

---

## Bring your own building

If the catalog doesn't have what you want, define a `customPlot`. Mirror the
catalog's shape: an interior shell + props + one or more exterior variants.

### Folder shape

```
<slug>/
  customPlots/
    record-store/
      plot.json
      exterior.png         ← optional: your own PNG
      interior.png         ← optional
      props/
        crate.png          ← optional
```

`plot.json`:

```json
{
  "id": "record-store",
  "label": "Record Store",
  "category": "MARKET",
  "interior": {
    "spriteCandidates": ["./interior.png"],
    "props": [
      { "tx": 4, "ty": 3, "sprite": "./props/crate.png" },
      { "tx": 6, "ty": 3, "sprite": "props/lamp-standing.png" }
    ]
  },
  "variants": [
    {
      "id": "record-store.classic",
      "exteriorSpriteCandidates": ["./exterior.png"],
      "npcPosition": { "tx": 5, "ty": 4, "label": "shopkeep" }
    }
  ]
}
```

Reference it from `town.json` as `"plotKey": "custom:record-store"`.

### Mix and match

Every sprite field accepts one of three ref types — independently per field:

| Looks like | Means | Source |
| --- | --- | --- |
| `"exteriors/home/villa-1.png"` | Existing catalog asset | Server's `/sprites/catalog/` |
| `"./exterior.png"` | Local PNG in this customPlot folder | `town deploy` uploads it |
| `"sprite:abc123…"` | Previously uploaded asset | `/api/sprites/abc123.png` |

So a customPlot can pair an existing catalog exterior with a custom interior,
or a custom exterior with the catalog's prop set, or any combination. Open
`catalog.json` in your folder — `exteriorSprites`, `interiorSprites`,
`propSprites` list every catalog path you can reuse.

On `town deploy` the CLI walks every ref, uploads each local PNG to
`/api/sprites` (PNG-only, 1 MiB cap, content-addressed in Postgres), and
rewrites the ref to `sprite:<hash>` before sending. Re-deploying is free —
hashes that already exist are no-ops.

---

## Hack on the repo

### Stack

- **pnpm + Turbo** monorepo (`pnpm@10`, Node 20+)
- **Next.js 16** (App Router) — server routes, OAuth callback, webhooks
- **kaplay 3001** — game runtime
- **Prisma + Postgres** — sessions, plot state, sprite blobs, event log
- **BullMQ + Redis** — event worker for inbound CORE webhooks
- **AI SDK** (Anthropic / OpenAI) — plot naming + NPC dialog

### Workspace layout

```
apps/
  web/                  Next.js app — game, UI, API routes, worker
packages/
  catalog/              Shared asset catalog (plots, variants, sprite paths)
  plot/                 Per-user plot schema + validator + default plot
  plot-gen/             Deterministic plot generator + incremental ops
  db/                   Prisma schema + client (@town/db)
  types/                Shared TS types
  town-cli/             The `town` CLI documented above
docs/                   Design notes (variant taxonomy, etc.)
```

Each package has its own README — start there when working in one.

### Getting started

```bash
cp .env.example .env
# Fill DATABASE_URL and the CORE_OAUTH_* vars.
# CORE_OAUTH_CLIENT_ID/SECRET come from POST /api/oauth/clients on
# app.getcore.me — see comments in .env.example for the payload.

pnpm install
pnpm db:migrate --name init
pnpm dev
```

Then open <http://localhost:3001>. `.env` lives at the repo root;
`apps/web/.env` is a symlink so Next picks it up, and `@town/db` scripts
load it via `dotenv-cli`.

### Common commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | `turbo run dev` — starts the web app |
| `pnpm build` | Production build of every package |
| `pnpm typecheck` | `tsc --noEmit` across the monorepo |
| `pnpm lint` | Lint every package |
| `pnpm db:migrate` | `prisma migrate dev` in `@town/db` |
| `pnpm db:generate` | Regenerate the Prisma client |
| `pnpm db:studio` | Open Prisma Studio |
| `pnpm catalog:sync` | Rebuild `public/sprites/catalog/variants.json` from `@town/catalog` |
| `pnpm plot:build-default` | Regenerate the committed default plot |

The event worker (BullMQ consumer for CORE webhooks) runs separately:

```bash
pnpm --filter @town/web run worker
```

### Auth & CORE integration

CORE OAuth2 + PKCE. The browser only ever sees an opaque session cookie
(`core-town:sid`); access and refresh tokens live in the `Session` table.
The `town` CLI authenticates with a CORE PAT instead — every API route that
accepts cookies also accepts `Authorization: Bearer <pat>`.

- Client entry points: `apps/web/src/game/auth.ts`
- Server endpoints: `apps/web/src/app/api/auth/{login,callback,me,logout}/route.ts`
- CORE wire calls: `apps/web/src/lib/oauth.ts`
- Session bookkeeping + refresh: `apps/web/src/lib/session.ts`

To call CORE from a Route Handler, read the session id from the cookie,
resolve a fresh access token via `getAccessTokenForSession(sid)`, then:

```ts
fetch(`${CORE_OAUTH_BASE}/api/v1/...`, {
  headers: { authorization: `Bearer ${token}` },
});
```

Inbound webhooks land at `/api/events` and are HMAC-verified against
`TOWN_WEBHOOK_SECRET` (`X-Town-Signature: sha256(secret, rawBody)`).

### Where to read next

- [`AGENTS.md`](./AGENTS.md) — guardrails and quick map for AI agents
- [`packages/catalog/README.md`](./packages/catalog/README.md) — asset catalog model
- [`packages/plot/README.md`](./packages/plot/README.md) — per-user plot schema
- [`packages/plot-gen/README.md`](./packages/plot-gen/README.md) — deterministic generator + incremental ops
- [`docs/variant-catalog-draft.md`](./docs/variant-catalog-draft.md) — variant taxonomy + tone bible
