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

Editing a town is the same as editing a folder. Three steps.

### 1. Log in

```bash
pnpm dlx @redplanethq/town login
```

Pick your CORE host and town server, then authorize in the browser. The
CLI saves a PAT to `~/.town/config.json` (mode 0600).

### 2. Create or clone

```bash
town init
```

This is the only entry point — it decides what to do by asking the server:

- **No town yet?** Prompts for a name and creates one. Folder gets
  scaffolded at `./<slug>/` with the day-zero trio (home / library / store).
- **Town already exists?** Confirms and clones into `./<slug>/` — your
  current buildings, customPlots, and NPC files materialize on disk.

<details>
<summary>What the folder looks like</summary>

```
<slug>/
  town.json           ← buildings list + customPlots references
  customPlots/        ← one folder per user-defined plot
  npcs/               ← one .mdx per NPC (frontmatter = identity, body = prompt)
  catalog.json        ← slim reference of what's available
  manifest.json       ← decor sprite reference
  AGENTS.md           ← orientation for coding agents
```

</details>

### 3. Edit

Everything lives in `<slug>/`. You edit JSON + MDX; the server owns layout.

<details>
<summary><strong>Add, remove, or swap a building</strong></summary>

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
- **Swap a variant** → add `"variantId": "cafe.bookshop"` (look up valid
  ids in `catalog.json` under the plot's `variants[]`).

You never write tile coordinates, paths, ponds, or decor. The server
picks a free cell, routes a path from home, refills the surrounding
forest. Re-deploy twice and the same edit lands in the same spot — it's
seeded.

</details>

<details>
<summary><strong>Add or edit an NPC</strong></summary>

Every building gets one NPC. NPCs live in `<slug>/npcs/<buildingId>.mdx`
— filename matches the `id` you used in `town.json#buildings`. To add a
new NPC, first add the building, then drop the matching MDX:

```mdx
---
buildingId: cafe
name: Cosma
description: Barista at the cafe. Knows what you're heads-down on.
---

You are the barista at the town cafe. Greet the player warmly when they
walk in and ask what they're heads-down on today. Reference recent CORE
activity when context is provided. Stay in character, never break the
fourth wall, and keep replies under three sentences.
```

The frontmatter is identity — `name` is the speaker line, `description`
is the flavor text that hovers as someone approaches. The body is the
system prompt the LLM sees on every turn.

**Prompt conventions that age well**

- Lead with role and place: *"You are the barista at the town cafe."*
- Anchor the voice in one sentence: tone, what they care about, how
  they greet.
- Tell the model what context it'll get. If you read CORE signals into
  the prompt at runtime, say so — *"reference recent CORE activity when
  context is provided"*.
- Cap length: *"keep replies under three sentences"*. Without this the
  model drifts long and the chat bubble runs off the screen.
- Lock the frame: *"stay in character, never break the fourth wall"*.

Re-running `town deploy` replaces the entire NPC roster atomically — no
half-deployed state, no orphan NPCs from deleted buildings.

</details>

### 4. Deploy

```bash
cd <slug>
town deploy
```

Uploads any new PNGs (see below), then POSTs `{ buildings, customPlots,
npcs }` to `/api/town`. The server diffs against your persisted plot and
runs incremental layout ops — no full regenerations, no churn on
untouched buildings.

---

## Bring your own building

If the catalog doesn't have what you want, define a `customPlot`. Mirror
the catalog's shape: an interior shell + props + one or more exterior
variants. Reference it from `town.json` as `"plotKey": "custom:<id>"`.

Every sprite field accepts one of three ref types — **independently per
field** — so you can pair an existing catalog exterior with a custom
interior, a custom exterior with the catalog's prop set, or any mix:

| Looks like | Means | Source |
| --- | --- | --- |
| `"exteriors/home/villa-1.png"` | Existing catalog asset | `/sprites/catalog/` |
| `"./exterior.png"` | Local PNG in your customPlot folder | `town deploy` uploads it |
| `"sprite:abc123…"` | Previously uploaded asset | `/api/sprites/<hash>.png` |

Open `catalog.json` in your folder — `exteriorSprites`, `interiorSprites`,
`propSprites` list every catalog path you can reuse.

<details>
<summary>Folder layout</summary>

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

</details>

<details>
<summary>Example <code>plot.json</code></summary>

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

</details>

<details>
<summary>What happens on deploy</summary>

The CLI walks every sprite ref, uploads each local PNG to `/api/sprites`
(PNG-only, 1 MiB cap, content-addressed in Postgres), and rewrites the
ref to `sprite:<hash>` before sending. Re-deploying is free — hashes that
already exist are no-ops.

</details>

---

## Hack on the repo

<details>
<summary>Stack</summary>

- **pnpm + Turbo** monorepo (`pnpm@10`, Node 20+)
- **Next.js 16** (App Router) — server routes, OAuth callback, webhooks
- **kaplay 3001** — game runtime
- **Prisma + Postgres** — sessions, plot state, sprite blobs, event log
- **BullMQ + Redis** — event worker for inbound CORE webhooks
- **AI SDK** (Anthropic / OpenAI) — plot naming + NPC dialog

</details>

<details>
<summary>Workspace layout</summary>

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

</details>

<details>
<summary>Getting started</summary>

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

</details>

<details>
<summary>Common commands</summary>

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

</details>

<details>
<summary>Auth &amp; CORE integration</summary>

CORE OAuth2 + PKCE. The browser only ever sees an opaque session cookie
(`core-town:sid`); access and refresh tokens live in the `Session` table.
The `town` CLI authenticates with a CORE PAT instead — every API route
that accepts cookies also accepts `Authorization: Bearer <pat>`.

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

</details>

### Where to read next

- [`AGENTS.md`](./AGENTS.md) — guardrails and quick map for AI agents
- [`packages/catalog/README.md`](./packages/catalog/README.md) — asset catalog model
- [`packages/plot/README.md`](./packages/plot/README.md) — per-user plot schema
- [`packages/plot-gen/README.md`](./packages/plot-gen/README.md) — deterministic generator + incremental ops
- [`docs/variant-catalog-draft.md`](./docs/variant-catalog-draft.md) — variant taxonomy + tone bible
