# Roast Town Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `roast-town` — a public showcase town where every building roasts the visitor a different way — using only the existing `town-cli`, with zero app code changes.

**Architecture:** Roast Town is **content + config**, not code. A dedicated CORE account owns the town. We author a town folder (`town.json` + `npcs/*.mdx`) and push it with `town deploy`. "Lean" build: every building is a stock catalog building (1 NPC slot) given a custom signpost `label` and one custom persona. No `customPlots`, no new sprites, no group chat — so there is no interior-geometry work and nothing can break the renderer.

**Tech Stack:** `@redplanethq/town` CLI (commander + clack), MDX frontmatter (gray-matter), the existing `/api/towns/me` + `/api/town` route handlers, Postgres/Prisma (`@town/db`), Next.js web app.

## Global Constraints

- **No app code changes.** Everything ships through the CLI + content files. If a task seems to need a code change, stop and re-scope.
- **Lean model — one NPC per building.** Every building uses a stock catalog `plotKey` (each has exactly one NPC slot). Differentiate with `label` (signpost) + the persona MDX. No `customPlots`, no `groupChatEnabled`.
- **No CORE tools on any NPC.** The town is owned by a system account; `memory_search`/`tasks` would read that empty account, not the visitor. Omit `permissions` entirely → server stores null → zero tools. Roasters react only to what the visitor types.
- **Keep replies short and in character.** Every persona prompt ends with "Stay in character. Keep replies under three sentences." — matching the existing `npc-templates/*.mdx` house style.
- **Canonical town folder lives in the repo** at `towns/roast-town/` so the showcase is reproducible and version-controlled.
- **Valid `plotKey` + `variantId` only** — every value below is confirmed present in `packages/catalog/src/catalog.json`.

## Source-of-truth references

- Spec: `docs/superpowers/specs/2026-06-27-roast-town-design.md`
- CLI commands: `packages/town-cli/src/commands/{login,init,deploy}.ts`
- File formats: `packages/town-cli/src/shared/town-io.ts` (`TownJson`, `TownBuilding`, `NpcDTO`)
- Town creation: `apps/web/src/lib/town.ts` (`pickTown`), served at `apps/web/src/app/[town]/page.tsx`
- Landing link pattern: `apps/web/src/ui/Landing.tsx` (`PUBLIC_TOWN_URL`)

## The roster (7 buildings, 7 NPCs)

| Building `id` | `plotKey` | `variantId` | `label` (sign) | NPC | Roast angle |
|---|---|---|---|---|---|
| `hq` | `home` | `home.cottage` | `Roast Town` | **Smoky** | Host — welcomes, then warns |
| `dojo` | `gym` | `gym.the-iron-room` | `Burn Dojo` | **Sensei Slim** | Coaches/roasts your burns (train) |
| `bar` | `store` | `store.first-pour` | `Clap-Back Bar` | **Vinny** | Roast battle; declares if you won (fight) |
| `pitch` | `office` | `office.pitch-wall` | `The Pitch Room` | **Chad Ventures** | Money — roasts your startup/site |
| `studio` | `studio` | `studio.atelier` | `The Design Studio` | **Margot** | Taste — design/UX |
| `culture` | `store` | `store.the-parlor` | `Culture Corner` | **Kai** | Vibes — is it cringe/dated |
| `den` | `workshop` | `workshop.the-server-closet` | `The Dev Den` | **Rex** | Tech — stack/repo |

(`bar` and `culture` both use `plotKey: store` with different `variantId` — allowed, since building `id` is unique.)

## File Structure

All under `towns/roast-town/` (created by `town init`, then edited):

- `town.json` — the 7 buildings with labels. **Responsibility:** map + signage.
- `npcs/hq.mdx`, `npcs/dojo.mdx`, `npcs/bar.mdx`, `npcs/pitch.mdx`, `npcs/studio.mdx`, `npcs/culture.mdx`, `npcs/den.mdx` — one persona each. **Responsibility:** voice + roast behavior. Filename = building `id` (binds to that building's default slot).
- `customPlots/` — present but **empty** (lean build).
- `README.md` — CLI-generated, left as-is.

---

### Task 1: Provision the owner account and scaffold the town folder

**Prerequisite (manual, one-time):** A dedicated CORE account to own the town (e.g. a "Roast Town" account on `https://app.getcore.me`). This account's town is public; it should not be a personal account.

**Files:**
- Create: `towns/roast-town/` (via CLI)

- [ ] **Step 1: Build/verify the CLI runs**

Run: `pnpm --filter @redplanethq/town dev-cli -- --help`
Expected: prints the `town` command help listing `login`, `init`, `deploy`.

- [ ] **Step 2: Decide the target server**

For a first end-to-end test, target local dev. In a second terminal: `pnpm dev` (serves `http://localhost:3000`). For the real showcase, target `https://town.getcore.me`. Pick one and use it consistently in Step 3.

- [ ] **Step 3: Log in as the Roast Town owner account**

Run: `pnpm --filter @redplanethq/town dev-cli -- login`
- CORE host: `https://app.getcore.me`
- Town server: `http://localhost:3000` (or `https://town.getcore.me`)
- Complete the browser verification **as the dedicated Roast Town account** (not a personal one).

Expected: "Logged in" — a PAT is saved to `~/.town/config.json`.

- [ ] **Step 4: Create the town + scaffold the folder**

Run from repo root:
```bash
mkdir -p towns && cd towns && pnpm --filter @redplanethq/town dev-cli -- init
```
- Confirm "Create one?" → yes
- Town name: `Roast Town`

Expected: server creates the town (slug `roast-town`); CLI scaffolds `towns/roast-town/` with a default `town.json` (home/library/store) + default `npcs/`. The slug must be exactly `roast-town`.

- [ ] **Step 5: Confirm the scaffold**

Run: `ls towns/roast-town towns/roast-town/npcs`
Expected: `town.json`, `customPlots/`, `npcs/`, `README.md`; `npcs/` has the default trio. (We overwrite these next.)

- [ ] **Step 6: Commit the scaffold**

```bash
git add towns/roast-town
git commit -m "chore(roast-town): scaffold town folder via town init"
```

---

### Task 2: Author `town.json` (buildings + signage)

**Files:**
- Modify: `towns/roast-town/town.json`

**Interfaces:**
- Produces: building `id`s (`hq`, `dojo`, `bar`, `pitch`, `studio`, `culture`, `den`) that Task 3's NPC files bind to via filename + `buildingId` frontmatter.

- [ ] **Step 1: Replace `town.json` with the roster**

```json
{
  "buildings": [
    { "id": "hq",      "plotKey": "home",     "variantId": "home.cottage",                "label": "Roast Town" },
    { "id": "dojo",    "plotKey": "gym",      "variantId": "gym.the-iron-room",           "label": "Burn Dojo" },
    { "id": "bar",     "plotKey": "store",    "variantId": "store.first-pour",            "label": "Clap-Back Bar" },
    { "id": "pitch",   "plotKey": "office",   "variantId": "office.pitch-wall",           "label": "The Pitch Room" },
    { "id": "studio",  "plotKey": "studio",   "variantId": "studio.atelier",              "label": "The Design Studio" },
    { "id": "culture", "plotKey": "store",    "variantId": "store.the-parlor",            "label": "Culture Corner" },
    { "id": "den",     "plotKey": "workshop", "variantId": "workshop.the-server-closet",  "label": "The Dev Den" }
  ]
}
```

- [ ] **Step 2: Sanity-check it parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('towns/roast-town/town.json','utf8')); console.log('ok')"`
Expected: `ok`

---

### Task 3: Author the seven personas

**Files:**
- Delete: the default `towns/roast-town/npcs/*.mdx` scaffolded files
- Create: `towns/roast-town/npcs/{hq,dojo,bar,pitch,studio,culture,den}.mdx`

**Interfaces:**
- Consumes: building `id`s from Task 2 (each file's `buildingId` must match a building).
- Each file: frontmatter `buildingId` + `name` + `description`, body = system prompt. No `slotId` (binds to the building's single default slot). No `permissions`.

- [ ] **Step 1: Remove the default NPCs**

```bash
rm -f towns/roast-town/npcs/*.mdx
```

- [ ] **Step 2: Create `npcs/hq.mdx`**

```mdx
---
buildingId: hq
name: Smoky
description: Host of Roast Town. Welcomes you, then warns you.
---

You are Smoky, the host of Roast Town — a town that exists to roast its
visitors. You greet new arrivals with mock warmth, explain that everyone here
is going to insult them and they signed up for it, and point them around: the
Burn Dojo to train your burns, the Clap-Back Bar to battle, and the critics —
the Pitch Room, the Design Studio, Culture Corner, and the Dev Den — who tear
apart whatever they bring. You are the friendliest rude person here, which
isn't saying much. Stay in character. Keep replies under three sentences.
```

- [ ] **Step 3: Create `npcs/dojo.mdx`**

```mdx
---
buildingId: dojo
name: Sensei Slim
description: Roast coach at the Burn Dojo. Sharpen your burns.
---

You are Sensei Slim, master of the Burn Dojo, where visitors train their
roasting. When the player tries a burn on you, critique it like a coach: rate
it, say why it's weak ("too soft — go for the ego, not the haircut"), and push
them to try again, harder. You are tough but secretly want them to get good.
Stay in character. Keep replies under three sentences.
```

- [ ] **Step 4: Create `npcs/bar.mdx`**

```mdx
---
buildingId: bar
name: Vinny
description: Emcee of the Clap-Back Bar. Battle him; find out if you won.
---

You are Vinny, the deadpan emcee of the Clap-Back Bar. Challenge the player to
a roast battle: throw a burn at them, let them fire one back, and judge it out
loud ("weak"... "ok, that one landed"). After a few exchanges, declare whether
they won or got cooked. You've heckled better. Stay in character. Keep replies
under three sentences.
```

- [ ] **Step 5: Create `npcs/pitch.mdx`**

```mdx
---
buildingId: pitch
name: Chad Ventures
description: Jaded VC. Paste your startup or site and watch it die.
---

You are Chad Ventures, a jaded VC who roasts startups and websites for sport.
Invite the player to paste their startup, pitch, or a link to their site, then
tear apart the business — market, moat, why it dies. You wear sunglasses
indoors and check your phone mid-sentence. Brutal, but occasionally and
accidentally useful. Stay in character. Keep replies under three sentences.
```

- [ ] **Step 6: Create `npcs/studio.mdx`**

```mdx
---
buildingId: studio
name: Margot
description: Design critic. She is never impressed.
---

You are Margot, a design critic with art-school disdain. The player shows you
their site, app, or any creative work, and you roast the taste — the fonts, the
colors, the spacing — in withering understatement ("Five fonts. Were they all
on sale?"). You are never impressed. Stay in character. Keep replies under
three sentences.
```

- [ ] **Step 7: Create `npcs/culture.mdx`**

```mdx
---
buildingId: culture
name: Kai
description: Gen-Z intern. Everything is mid.
---

You are Kai, a Gen-Z intern who roasts how cringe and dated something is. The
player shows you their thing and you roast its vibes in current slang ("this is
giving 2017 LinkedIn hustle, it's so over"). You find almost everything mid.
Stay in character. Keep replies under three sentences.
```

- [ ] **Step 8: Create `npcs/den.mdx`**

```mdx
---
buildingId: den
name: Rex
description: 10x dev. Roasts your stack without mercy.
---

You are Rex, a grizzled 10x developer who roasts code, stacks, and repos. The
player shows you their GitHub or describes their tech, and you roast the choices
("jQuery. In 2026. I need a moment."). You've seen things. Brutal about
engineering, grudgingly respectful of anything actually clever. Stay in
character. Keep replies under three sentences.
```

- [ ] **Step 9: Verify all seven parse and bind**

Run:
```bash
node -e '
const fs=require("fs"),path="towns/roast-town/npcs";
const ids=new Set(JSON.parse(fs.readFileSync("towns/roast-town/town.json","utf8")).buildings.map(b=>b.id));
let ok=true;
for(const f of fs.readdirSync(path).filter(f=>f.endsWith(".mdx"))){
  const s=fs.readFileSync(path+"/"+f,"utf8");
  const m=s.match(/buildingId:\s*(\S+)/), n=/name:\s*\S/.test(s);
  if(!m||!ids.has(m[1])){console.log("BAD buildingId in",f);ok=false;}
  if(!n){console.log("missing name in",f);ok=false;}
}
console.log(ok?"all npcs ok":"FAIL");
'
```
Expected: `all npcs ok`

- [ ] **Step 10: Commit the content**

```bash
git add towns/roast-town/town.json towns/roast-town/npcs
git commit -m "feat(roast-town): author 7 buildings + roast personas"
```

---

### Task 4: Deploy and verify in-browser

**Files:** none (uses the authored folder)

- [ ] **Step 1: Deploy**

Run from inside the folder:
```bash
cd towns/roast-town && pnpm --filter @redplanethq/town dev-cli -- deploy
```
Expected: "Town updated (vN, 7 NPC row(s) replaced)". If validation fails, the CLI prints the offending `plotKey`/`variantId`/building — fix and re-run.

- [ ] **Step 2: Get the invite (share) code**

The deploy response doesn't include it. Log into the web app **as the Roast Town owner account**, open the Share modal, and copy the 6-char invite code. (Alternatively read it: `Town.shareCode` for slug `roast-town` via `pnpm db:studio`.)

- [ ] **Step 3: Open the town as a visitor**

Open `http://localhost:3000/roast-town?invite_code=<CODE>` (or the prod host) in a fresh/incognito window. Pass the visitor gate.
Expected: overworld with 7 buildings; signs read "Roast Town", "Burn Dojo", "Clap-Back Bar", "The Pitch Room", "The Design Studio", "Culture Corner", "The Dev Den".

- [ ] **Step 4: Talk to every NPC**

Walk to each building, press SPACE, send one message. Verify each NPC is in voice:
- Smoky welcomes + points you around.
- Sensei Slim coaches a burn you try.
- Vinny starts a roast battle and eventually calls a winner.
- Chad roasts a pasted startup/site link.
- Margot roasts described design.
- Kai roasts vibes in slang.
- Rex roasts a described stack/repo.

Expected: replies are short, in-character, and roast-flavored. If any NPC is generic, re-check that `npcs/<id>.mdx` deployed (re-run Task 4 Step 1).

- [ ] **Step 5: Confirm no CORE-tool leakage**

Ask an NPC "what's on my calendar?" / "search my memory."
Expected: it deflects in character — it has no tools and no access to the visitor's account.

---

### Task 5: Surface the town (invite link + landing)

**Files:**
- Modify: `apps/web/src/ui/Landing.tsx` (optional, follows `PUBLIC_TOWN_URL` pattern)
- Modify: `docs/superpowers/specs/2026-06-27-roast-town-design.md` (record the live URL + code)

- [ ] **Step 1: Record the live URL**

Append the live link + invite code to the spec doc's header so the showcase URL is captured:
`Live: /roast-town?invite_code=<CODE>`

- [ ] **Step 2 (optional): Link it from the landing page**

If the showcase should be linked publicly, add a Roast Town entry next to `PUBLIC_TOWN_URL` in `apps/web/src/ui/Landing.tsx` (a `/roast-town?invite_code=<CODE>` link). This is the one optional app-code touch; skip if the showcase is shared by URL only.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-06-27-roast-town-design.md apps/web/src/ui/Landing.tsx
git commit -m "docs(roast-town): record live showcase URL"
```

---

## Self-Review

**1. Spec coverage:**
- "Each building is a different flavor of the roast verb" → Task 2/3 roster (7 distinct roasters). ✓
- Burn Dojo (train) / Clap-Back Bar (fight) → `dojo`/`bar` personas. ✓
- Roast Pit "drop your real stuff" → split, lean, into Chad (`pitch`), Margot (`studio`), Kai (`culture`), Rex (`den`), each roasting what you paste/describe. ✓ (True 4-in-one panel + URL fetch are deferred per the spec's "Deferred" section and the lean build decision.)
- "Chat-engine only, no new game code" → Global Constraints + Task scope. ✓
- "Public slug + invite code, no signup" → Task 4 Step 3. ✓
- All open from start (no gating) → no gating logic exists; nothing added. ✓

**2. Placeholder scan:** `<CODE>` is a runtime value the owner copies in Task 4 Step 2, not a plan gap. The owner CORE account is a stated manual prerequisite. No "TBD"/"handle edge cases"/unshown content. ✓

**3. Type consistency:** Building `id`s in `town.json` (Task 2) exactly match `buildingId` frontmatter + filenames in Task 3 (`hq`/`dojo`/`bar`/`pitch`/`studio`/`culture`/`den`). All `plotKey`/`variantId` values match the catalog dump. NPC files carry no `slotId` → bind to the single default slot each stock variant exposes. ✓

## Execution Handoff

This plan is mostly content authoring + CLI ops (not TDD code), so the steps are author-file / run-command / verify-in-browser rather than red-green test cycles.
