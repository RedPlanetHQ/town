// Orientation README written into every scaffolded / cloned town folder.
// Targets coding agents (Claude Code, Codex, …) that may end up editing
// town.json + customPlots / npcs without having read the CLI source.

export function agentsMarkdown(): string {
  return `# Town — local edit folder

This folder is your town's source of truth while you're editing offline.
\`town deploy\` pushes the local state back to the server, which owns the
underlying tile-level layout (paths, ponds, decor).

## Files

- \`town.json\` — high-level shape of your town. Two fields:
  - \`buildings\` — every building's id, plotKey, and (optional) variantId.
    \`plotKey\` is either a catalog entry (e.g. "home", "cafe", "office-2")
    or "custom:<id>" — a reference to one of your customPlots below.
  - \`customPlots\` — leave empty here and add full definitions under
    \`customPlots/<id>/plot.json\` instead. The deploy step inlines them.
- \`customPlots/<id>/plot.json\` — one user-defined plot per directory.
  Mirrors the catalog \`Plot\` shape: interior + variants. Sprite refs can
  point at existing catalog paths (e.g. "exteriors/home/villa-1.png") OR
  at sibling PNGs ("./exterior.png", "./props/lamp.png"). The CLI uploads
  the PNGs and rewrites refs to "sprite:<hash>" on deploy.
- \`npcs/<buildingId>.mdx\` — one NPC per building. Frontmatter holds the
  identity (name, description, buildingId); body is the system prompt.
- \`catalog.json\` — slim, read-only reference of what's available.
  Four fields:
  - \`plots\` — every catalog plot with its plotKey, label, category,
    list of \`variants[].id\`, and shared \`interior\` shape. Use the
    \`plotKey\` in \`town.json#buildings\` and any \`variantId\` from the
    matching variants list.
  - \`exteriorSprites\` — every catalog exterior PNG path. Usable in
    \`customPlot.variants[].exteriorSpriteCandidates\`.
  - \`interiorSprites\` — every catalog interior shell path. Usable in
    \`customPlot.interior.spriteCandidates\`.
  - \`propSprites\` — every catalog interior prop path. Usable in
    \`customPlot.interior.props[].sprite\`.
- \`manifest.json\` — every available decor sprite (trees / bushes /
  flowers / …). Read-only; the renderer scatters decor, but the manifest
  is here for reference.

## What edits the server cares about

- Add a building → append \`{ id, plotKey }\` to \`town.json#buildings\`.
- Remove a building → delete its entry.
- Swap a variant → set \`variantId\` on the entry.
- Add a brand-new plot type → drop a folder under \`customPlots/\` and
  reference it from \`town.json\` as \`plotKey: "custom:<id>"\`.

You do NOT touch tile coordinates, paths, ponds, or decor. The server
recomputes those on every deploy.

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
