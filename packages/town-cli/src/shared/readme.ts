// Orientation README written into every scaffolded / cloned town folder.
// Targets both humans and coding agents (Claude Code, Codex, …) that may
// end up editing town.json + customPlots / npcs without having read the
// CLI source.
//
// Catalog + decor reference live in the public repo so the local folder
// stays small and the snapshots never go stale — readers fetch the
// current shape straight from main.

const CATALOG_URL =
  "https://github.com/RedPlanetHQ/town/blob/main/apps/web/public/sprites/catalog/variants.json";
const CATALOG_RAW =
  "https://raw.githubusercontent.com/RedPlanetHQ/town/main/apps/web/public/sprites/catalog/variants.json";
const MANIFEST_URL =
  "https://github.com/RedPlanetHQ/town/blob/main/apps/web/public/sprites/extras/MANIFEST.json";
const MANIFEST_RAW =
  "https://raw.githubusercontent.com/RedPlanetHQ/town/main/apps/web/public/sprites/extras/MANIFEST.json";

export function townFolderReadme(): string {
  return `# Town — local edit folder

This folder is your town's source of truth while you're editing offline.
\`town deploy\` pushes the local state back to the server, which owns the
underlying tile-level layout (paths, ponds, decor).

## Files

- \`town.json\` — high-level shape of your town. Two fields:
  - \`buildings\` — every building's id, plotKey, (optional) variantId,
    (optional) label, and (optional) groupChatEnabled. The \`id\` is your
    internal handle (referenced by NPC MDX files and customPlots).
    \`plotKey\` is either a catalog entry (e.g. "home", "cafe",
    "office-2") or "custom:<id>" — a reference to one of your customPlots
    below.
    The overworld sign reads \`label\` when present, otherwise
    \`id.toUpperCase()\` — so \`{ id: "cake", plotKey: "store" }\` shows
    "CAKE", and \`{ id: "cafe", plotKey: "cafe", label: "Sunny's Café" }\`
    shows "SUNNY'S CAFÉ".
    Set \`"groupChatEnabled": true\` on a building to give its interior a
    multi-party room chat: anyone inside the house (humans + NPCs) shares
    a Twitch-style overlay opened with the \`G\` key. Absent / false →
    no group chat for that house.
  - \`customPlots\` — leave empty here and add full definitions under
    \`customPlots/<id>/plot.json\` instead. The deploy step inlines them.
- \`customPlots/<id>/plot.json\` — one user-defined plot per directory.
  Mirrors the catalog \`Plot\` shape: interior + variants. Sprite refs can
  point at existing catalog paths (e.g. "exteriors/home/villa-1.png") OR
  at sibling PNGs ("./exterior.png", "./props/lamp.png"). The CLI uploads
  the PNGs and rewrites refs to "sprite:<hash>" on deploy.
- \`npcs/<buildingId>.mdx\` — one NPC per slot in the building. Frontmatter
  holds identity (name, description, buildingId); body is the system prompt.
  For buildings whose variant declares multiple slots, use
  \`npcs/<buildingId>__<slotId>.mdx\` and add \`slotId\` to the
  frontmatter so the renderer matches each MDX to the right position
  inside the interior.

## What edits the server cares about

- Add a building → append \`{ id, plotKey }\` to \`town.json#buildings\`.
- Remove a building → delete its entry.
- Swap a variant → set \`variantId\` on the entry.
- Turn on the in-house group chat → add \`"groupChatEnabled": true\` to
  the building.
- Add a brand-new plot type → drop a folder under \`customPlots/\` and
  reference it from \`town.json\` as \`plotKey: "custom:<id>"\`.

You do NOT touch tile coordinates, paths, ponds, or decor. The server
recomputes those on every deploy.

## Catalog + decor reference

The set of plotKeys, variant ids, and sprite paths you can use lives in
the town-next repo. Skim or fetch as needed:

- Catalog (plots, variants, interiors, NPC slot positions):
  - View: ${CATALOG_URL}
  - Fetch: ${CATALOG_RAW}
- Decor manifest (trees, bushes, flowers, …):
  - View: ${MANIFEST_URL}
  - Fetch: ${MANIFEST_RAW}

Each catalog plot has \`id\` (use as \`plotKey\`), \`category\`,
\`interior\`, and one or more \`variants\`. Each variant has an
\`exteriorSpriteCandidates\` list and one or more \`npcPositions\` (slot
ids you can target from MDX). Use these as templates when authoring a
customPlot.

## CustomPlot sprite mix-and-match

Every sprite ref accepts:
- a catalog-relative path (\`"exteriors/home/villa-1.png"\`)
- a local file (\`"./exterior.png"\`) — \`town deploy\` uploads it
- a server-side ref (\`"sprite:<contentHash>"\`) — returned by a previous
  upload, can be reused freely

So a customPlot can pair an EXISTING exterior with a NEW interior, or a
NEW exterior with an existing prop set, or any mix — independently per
field.

## Commands

- \`town init\` — create your town (or re-clone an existing one) into a
  folder named after the slug, under wherever you ran the command.
- \`town deploy\` — upload local PNGs and POST \`{ buildings, customPlots,
  npcs }\` to /api/town. The server diffs vs the persisted plot and runs
  incremental ops.
`;
}
