---
name: manage-towns
description: Full lifecycle for Towns — authenticate (login), list towns, clone an existing town locally, deploy a local folder to the server, and delete a town. Use when the user says "deploy my town", "list my towns", "clone the AI startup town", "log in", or "delete X". This is the ONLY skill that runs deploy — every other skill hands off here for shipping.
---

# Managing Towns

Every operation here goes through the `town` CLI (`@redplanethq/town`). Nothing here talks to the server directly.

## Login (once per machine)

Run:
```bash
town login
```

Interactive: prints a URL, waits for the user to paste their CORE PAT. Stores it at `~/.town/config.json` with 0600 perms.

Verify after: `~/.town/config.json` should exist and contain `auth.pat` + `auth.townUrl`. If the user re-runs `town login`, it overwrites cleanly.

## List towns

There is no dedicated CLI subcommand — use the API:

```bash
curl -s "$(node -e 'console.log(JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.town/config.json","utf8")).auth.townUrl)')/api/towns/mine" \
  -H "authorization: Bearer $(node -e 'console.log(JSON.parse(require("fs").readFileSync(require("os").homedir()+"/.town/config.json","utf8")).auth.pat)')"
```

Or more simply, if the user has a shell with `jq`:

```bash
CONF=~/.town/config.json
curl -s "$(jq -r .auth.townUrl "$CONF")/api/towns/mine" \
  -H "authorization: Bearer $(jq -r .auth.pat "$CONF")" | jq '.towns[] | {slug, name, id}'
```

If neither is available, ask the user to run either of those commands and paste the output.

## Clone an existing town locally

```bash
town clone <slug> [--dir <target>]
```

Pulls the server's canonical `town.json` + `npcs/` + `customPlots/` into a fresh folder. Use this when the user wants to iterate on a town they already deployed, or when someone shares a public town they want to fork.

If `--dir` is omitted, the CLI writes to `./<slug>/`. Refuse to overwrite if that folder is non-empty; ask the user for a `--dir` override.

## Deploy the current folder

```bash
town deploy
```

Runs from inside a town folder (has `town.json`). Uploads:
- `town.json` → server writes buildings + `plot.json` diff.
- `npcs/*.mdx` → server writes each NPC.
- `customPlots/*/plot.json` + PNGs → server uploads sprites (idempotent on content hash) and writes the plot definitions.

Before running deploy, run this preflight sanity check yourself (do NOT ask the CLI to — the CLI validates on POST, but early failure is cleaner):

1. `town.json` is valid JSON.
2. Every `buildings[].id` is unique.
3. Every `buildings[].plotKey` either matches a catalog entry (`town catalog`) or has the `custom:` prefix with a matching folder under `customPlots/`.
4. Every `npcs/<X>.mdx` has a `buildingId` matching some `buildings[].id`.
5. No orphaned NPC files pointing at deleted buildings.
6. Every custom plot has both `exterior.png` AND `interior.png` on disk, plus a `plot.json`.

If preflight fails, tell the user which check failed and stop. Do NOT deploy a partial state.

On success, the CLI prints the town URL (e.g. `https://<host>/<slug>`). Repeat it to the user.

On aura-empty during deploy: structural deploys don't cost aura — only image generation does. If you see 402, something is off; report to the user and stop.

## Delete a town — CONFIRM FIRST

```bash
town delete <slug>
```

**Always** confirm with the user before running. Show them the town's slug + name + number of buildings + number of NPCs. Ask for explicit "yes, delete <slug>" — a bare "yes" is not enough. Server hard-deletes the row; there is no undo.

If the user says "delete all my towns" — refuse. Delete one at a time, each with its own confirmation.

## Recovery

- `town: not logged in` → user needs `town login`. Do not continue.
- Deploy 4xx `plotKey unknown` → the town references a catalog `plotKey` that doesn't exist server-side. Compare to `town catalog` output and fix the town.json entry.
- Deploy 4xx `NPC references nonexistent building` → orphan NPC file. Either fix its `buildingId` frontmatter or delete the file.
- Deploy 4xx `sprite too large` → someone put a screenshot in a `customPlots/*/` folder. Only `exterior.png` (12×12 tiles × 16px = 192×192) and `interior.png` (18×16 × 16 = 288×256) belong there. Regenerate via `generate-plot` if unclear.
- Deploy 5xx → transient; retry once. If it repeats, capture the response body and surface it to the user.
- Clone into non-empty dir → CLI refuses; tell the user to pick a fresh `--dir` or empty the current one.

## What this skill does NOT do

- Edit buildings, swap variants, write NPCs — that's **author-town** / **write-npc**.
- Generate custom art — that's **generate-plot**.
- Update `SETUP.md` — that's **author-town**.

If the user asks you to "deploy and add a courthouse" — do the courthouse edit via **author-town** first, THEN come back here for deploy. Don't mix mutations into the deploy call.
