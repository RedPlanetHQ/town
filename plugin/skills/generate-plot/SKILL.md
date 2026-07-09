---
name: generate-plot
description: Generate a custom building's pixel-art exterior + interior PNGs when no catalog plotKey fits — e.g. ramen counter, neon shrine, mycelium lab. Uses `town generate exterior|interior`, then READS the generated PNG back, evaluates it against the visual spec, and regenerates with an adjusted concept if it's off. Wires the PNGs into a valid `plot.json` and reports total aura consumed. Invoke when author-town flagged "no catalog match" or the user asked for a custom-look building.
---

# Custom Plot Generation

A custom plot is a building whose art the user commissioned instead of pulling from the catalog. It costs real aura (25 per image + 10 for the plot.json stage = **~60 aura per building**), and every generation makes a live call to gpt-image-1. Be careful, and check your work.

## Prerequisites — do not skip

1. `town login` state exists.
2. Current directory has a `town.json` (you're inside a town folder). `generate-plot` refuses to work outside a town folder.
3. The user has explicitly named the building concept AND confirmed they want to spend aura on it. If either is missing → ask, don't guess. Confirm cost in one line: *"Custom plot ≈ 60 aura. Ok to proceed?"*
4. Pick a `customPlotId`: lowercase letters/digits/hyphens, 1–40 chars. Names like `ramen-counter`, `neon-shrine`, `mycelium-lab` — NOT `plot1`. This id passes through every step.

## The generation loop

For each of exterior and interior, iterate this loop up to **3 times**:

### Step 1 — Generate

Exterior:
```bash
mkdir -p customPlots/<customPlotId>
town generate exterior "<concept>" \
  --out customPlots/<customPlotId>/exterior.png \
  --tiles 12x12 \
  --category <HOME|WORK|READ|MARKET|MOVE|CREATE|WORKSHOP>
```

Interior:
```bash
town generate interior "<concept>" \
  --out customPlots/<customPlotId>/interior.png \
  --category <same category>
```

The CLI prints:
- `✓ <path>` + tile dimensions + KB size + sha
- `aura: -25  remaining: <n>` — **record this**; you'll report the sum at the end.

If the CLI exits non-zero:
- `Not logged in` → tell the user to `town login`; stop.
- `Aura empty` → tell the user they need to top up; stop the whole build. Do NOT retry.
- `Image generation failed` → retry once with the same concept (transient OpenAI error). If it fails a second time, report the error and stop.

### Step 2 — Read the PNG

Use the **Read** tool on the file path you just wrote. Read tool renders PNGs visually — you see what was actually produced.

### Step 3 — Judge it against the spec

Exterior checklist:
- [ ] Building faces the viewer head-on with a slight ¾ elevation — NOT top-down, NOT pure side-elevation.
- [ ] Door is roughly centered on the south face, ground level.
- [ ] Signage panel above the door, blank (no readable letters).
- [ ] Roof visibly darker than the walls, with clear pitch or banded shingles.
- [ ] Windows show warm interior glow — not black holes, not gradients.
- [ ] Foundation strip along the ground line.
- [ ] 1–2 ground-level props flanking the door (lantern, plant, sign, etc.).
- [ ] Palette ≤ 16 colors, hard pixel edges, no anti-aliasing halo.
- [ ] Everything outside the silhouette + props is transparent (no grass, no backdrop).
- [ ] Concept is legible at a glance — a ramen counter should read as a ramen counter, not a generic hut.

Interior checklist:
- [ ] Pure top-down view (looking straight down).
- [ ] 1-tile perimeter wall on all four sides; north wall has a slightly taller shading strip.
- [ ] Door opening in the center of the south wall, reaching the bottom edge.
- [ ] Wood-plank floor with visible seam lines and 2 alternating plank tones.
- [ ] Central floor accent (rug, medallion, tile inset) in a jewel tone.
- [ ] Furniture hugs the walls; the center column (x=8..10) is walkable.
- [ ] 2–4 terracotta potted plants.
- [ ] 2–4 north-wall decorations (framed art, clock, notice board).
- [ ] Hard 1-pixel drop shadows on furniture (south + east edges).
- [ ] Concept legibility — same test as the exterior.
- [ ] Everything outside the room perimeter is transparent.

### Step 4 — Decide

**If ≥ 90% of the checklist passes**: accept the image. Move on.

**If 1–2 items fail**: describe the specific defect back to the user in one sentence and ask if you should regenerate with an adjusted concept, or accept as-is. Include the aura cost of retrying (25).

**If ≥ 3 items fail**: regenerate automatically (this counts against the 3-iteration budget). Amend the `concept` string to explicitly address the failure — do not just rerun the same prompt. Examples:

- Camera drifted top-down → prepend `"front-facing pixel art, ¾ elevation, roof visible above facade — "` to the concept.
- Windows are black → prepend `"warm yellow lit windows, no dark voids — "`.
- Interior clutter in center → prepend `"center column clear from north wall to south door, furniture only along walls — "`.
- Off-brand palette → prepend `"strict 16-bit palette, red brick and slate roof — "` or whichever colors fit.
- Wrong concept (asked for library, got kitchen) → make the concept more specific: not "reading room" but "wall of tall wooden bookshelves, reading desk with green lamp, ladder against the shelves".

Iterate. Record aura spent on each attempt.

### Step 5 — Budget exhausted

If after 3 iterations the exterior or interior still fails ≥ 3 checklist items, stop. Report to the user:
- The last file path so they can inspect.
- Total aura spent on this build so far.
- Which checklist items keep failing.
- Ask whether to (a) accept the current output anyway, (b) try one more with a rewritten concept, or (c) abandon and pick a catalog plot instead.

Do not silently keep spending aura.

## Wiring the PNGs into `plot.json`

Once BOTH images are accepted, create `customPlots/<customPlotId>/plot.json` with this shape:

```json
{
  "id": "<customPlotId>",
  "label": "<Human label, 1-60 chars>",
  "category": "<HOME|WORK|READ|MARKET|MOVE|CREATE|WORKSHOP>",
  "interior": {
    "sprite": "./interior.png",
    "widthTiles": 18,
    "heightTiles": 16,
    "walkable": { "tx": 1, "ty": 3, "w": 16, "h": 11 },
    "extraWalkable": [
      { "tx": 9, "ty": 14, "w": 1, "h": 1 },
      { "tx": 9, "ty": 15, "w": 1, "h": 1 }
    ],
    "spawn": { "tx": 9, "ty": 13 },
    "exit": { "tx": 9, "ty": 14 },
    "props": []
  },
  "variants": [
    {
      "id": "<customPlotId>.default",
      "exteriorSprite": "./exterior.png",
      "spriteW": 12,
      "spriteH": 12,
      "npcPositions": [
        { "id": "", "label": "<slot label>", "tx": 9, "ty": 8 }
      ]
    }
  ]
}
```

Rules:
- `spriteW` / `spriteH` MUST match the `--tiles` you passed to `town generate exterior` (default 12×12).
- `interior.widthTiles` / `heightTiles` are always 18 / 16.
- Every `npcPositions[*]` slot must fall inside `walkable` (tx 1..16, ty 3..13). Empty slot `id: ""` is fine for a single-slot building.
- Include at least one slot — a building with no NPCs is dead space.

## Register the building in `town.json`

Append to `buildings[]`:

```json
{
  "id": "<customPlotId>",
  "plotKey": "custom:<customPlotId>",
  "variantId": "<customPlotId>.default",
  "label": "<same label>"
}
```

Note the `custom:` prefix on `plotKey` — that's how the server distinguishes catalog vs. custom.

## Hand off

After the plot.json + `town.json` are updated:

1. Invoke **write-npc** to populate the slot(s). NPCs are what make the building feel alive.
2. Summarize to the user: files written, total aura consumed (sum of every `-25` line + 10 for the plot), and prompt them for the deploy step via **manage-towns**.

## Common failure recovery

- `sharp: Input buffer contains unsupported image format` (server-side) — retry once; if it repeats it's an OpenAI response issue.
- `PNG dimensions cannot be zero` — the model returned an empty transparent frame; retry with a beefier concept.
- `too-many-pixels` — should not happen since we downscale; if it does, this is a bug — report to the user, don't retry.
- User says "make it more X" mid-build — this is a legitimate iteration; amend the concept and call `town generate <kind>` again. Same aura cost applies.
