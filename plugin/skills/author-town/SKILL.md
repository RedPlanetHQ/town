---
name: author-town
description: Scaffold a new Town or edit an existing one — buildings, layout, structure, SETUP.md. Use when the user says "make me a town about X", "add a coffee shop", "swap the library for a warehouse", "edit my town", or wants to iterate on a `town.json` in the current folder. Delegates NPC writing to write-npc, custom-plot art to generate-plot, and shipping to manage-towns.
---

# Authoring a Town

Everything here is done through the `town` CLI (`@redplanethq/town`). Never write directly to the server API — the CLI holds auth state in `~/.town/config.json` and understands the file layout.

## Prerequisites (check these before any work)

1. `town login` has been run — verify by peeking at `~/.town/config.json`. If missing → tell the user to run `town login` and stop.
2. You're in a directory that either (a) already contains `town.json` (edit mode) or (b) is a clean directory intended to hold a new town (create mode).

If unclear which, run `ls` and check for `town.json`.

## Create mode — no `town.json` yet

Step 1. Ask the user for the town's **name** and its **theme in one sentence** ("startup incubator", "medieval market village", "cyberpunk noodle alley"). Don't invent one for them.

Step 2. Run:
```bash
town new "<the name>"
```
This creates `./<slug>/` with `town.json`, `npcs/`, and `SETUP.md`. `cd` into it.

Step 3. The default scaffold includes home + library + store. Look at `town.json` to confirm which day-zero buildings landed. Report to the user what they got.

Step 4. Ask the user which extra buildings they want. Use `browse the catalog` (below) to pick correct `plotKey` + `variantId` for each.

Step 5. Once the structural draft is agreed, invoke **write-npc** for each new building to compose personas, and **manage-towns** to deploy.

## Edit mode — `town.json` exists

Step 1. Read `town.json` and enumerate the current buildings for the user. Read `SETUP.md` for the town's stated purpose so your suggestions stay on-brand.

Step 2. Look at `npcs/` to see who's already staffed.

Step 3. Apply the requested edit. Common patterns:

- **Add building** → append to `buildings[]` in `town.json` with `{ id, plotKey, variantId, label }`. `id` must be unique within the town. Pick from the catalog (below).
- **Remove building** → delete from `buildings[]` AND delete `npcs/<building-id>.*.mdx` files bound to it.
- **Swap variant** → change `variantId` only. Keep `id` + `plotKey` + `label` unless the user asked to rename.
- **Rename** → update `label`. Don't change `id` (breaks NPC bindings).
- **Custom building** → invoke **generate-plot** — never write custom-plot art by hand.

Step 4. Invoke **manage-towns** to deploy when the user is ready.

## Browsing the catalog

Run:
```bash
town catalog
```

Prints every valid `plotKey` grouped by category. Categories are:

- **HOME** — houses, apartments, personal spaces
- **WORK** — offices, workshops, meeting rooms
- **READ** — libraries, archives, study rooms
- **MARKET** — stores, stalls, trading posts
- **MOVE** — gyms, dance halls, courts
- **CREATE** — studios, ateliers, labs
- **WORKSHOP** — engineering bays, garages, workbenches

`plotKey` is the category root (e.g. `office`, `library`). `variantId` is the specific look (e.g. `office.two-by-two-table`, `library.the-archive`). Both are required in `town.json`.

If no catalog entry fits the concept the user asked for (e.g. "ramen counter", "temple of neon"), stop and propose **generate-plot** instead — do NOT force a bad-fit catalog entry.

## `town.json` shape (edit reference)

```json
{
  "id": "<server-issued cuid>",
  "buildings": [
    {
      "id": "loft",
      "plotKey": "home",
      "variantId": "home.condo",
      "label": "The Founder's Loft"
    }
  ]
}
```

`id` at the top level is server-managed — never edit it. `id` inside `buildings[]` is your handle — pick short, lowercase, no spaces (used as the NPC `buildingId` foreign key).

## `SETUP.md` — the town's charter

Two paragraphs, first-person, written as if the owner is greeting a first-time visitor. Keep to <200 words. Mention the theme, the vibe, and 1–2 signature buildings. This surfaces as the welcome dialog on `/{slug}` so it must sound human, not templated.

Update it whenever the structural theme shifts. Don't rewrite it after every small edit.

## Recovery

- `town: not logged in` → tell the user to `town login`. Do not continue.
- `plotKey unknown` on deploy → you picked something not in `town catalog`; re-check spelling.
- `NPC references nonexistent building` on deploy → an NPC file's `buildingId` doesn't match any `id` in `town.json`. Fix the file (either rename to match or delete the orphan NPC).
- Deploy 402 aura-empty → the town's aura is exhausted; user must top up before you can generate any more custom plots. Structural edits (catalog buildings) don't cost aura.

## What you must NOT do

- Do not manually edit files inside `customPlots/<id>/` — generate-plot owns that surface.
- Do not write NPC persona prompts here — always invoke **write-npc**; those prompts have their own quality bar.
- Do not run `town deploy` from here — that's **manage-towns**' job so shared validation runs.
