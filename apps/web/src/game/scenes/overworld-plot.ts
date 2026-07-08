// Plot-driven overworld scene.
//
// Reads a Plot from /api/plot, renders it via Kaplay, and re-renders any
// time the stored plot version bumps. This is the scene that "if I change
// the JSON in the DB the UI changes" goes through.
//
// What it renders directly from the plot:
//   • world dimensions             — plot.world
//   • building exteriors + signs   — plot.buildings
//   • roads (autotiled)            — plot.paths
//   • ponds (autotiled)            — plot.ponds
//   • decor (trees / bushes / etc) — plot.decor
//   • doors                        — derived from plot.buildings (south-edge centre)
//
// What it skips for now (will fold in later):
//   • mailbox, day/night, HUD, TownState integration, guest dialogs

import type { GameObj, KAPLAYCtx } from "kaplay";

import { TILE, VIEW_W, VIEW_H, INK, PALETTE, hex } from "../config";
import { GRASS_HEX, autotile9Slice } from "../../lib/plot-render";
import { theme } from "../theme";
import { makePlayer, type Tile } from "../entities/player";
import { attachRemotePlayers } from "../entities/remotePlayer";
import { isSleeping as auraIsSleeping } from "../aura";
import { getSession, onSessionChange } from "../auth";
import { ui } from "../../ui/store";
import { isCinematicLocked, registerWorldBounds } from "../cinematic";
import { loadPlot, setCachedPlot, subscribePlot } from "../plotClient";
import {
  getActiveTownSlug,
  getRemotePlayersForScene,
  getSelfIdentity,
  publishLocalPosition,
  setLocalScene,
} from "../realtime";
import { registerTeleport } from "../teleport";
import {
  defaultPlot,
  resolveSpriteUrl,
  type Manifest,
  type Plot,
  type PlotBuilding,
  type PlotDecor,
  type PlotPath,
  type PlotPond,
} from "@town/plot";

// =============================================================================
// Sprite-id helpers
// =============================================================================
//
// Every PNG referenced from the plot or manifest needs to be loaded into
// kaplay BEFORE it can be drawn. We assign each one a stable sprite id
// (path with the leading "/sprites/..." stripped) and hand kaplay the
// public URL. Idempotent — repeat loads are no-ops at the kaplay layer.

function exteriorSpriteId(b: PlotBuilding): string {
  // Catalog refs: "exteriors/home/villa-1.png" → "ext:home/villa-1".
  // Uploaded refs: "sprite:<hash>" → "ext:sprite:<hash>" (kept as-is so the
  // ref round-trips into a kaplay sprite key without colliding).
  return (
    "ext:" +
    b.exteriorSprite.replace(/^exteriors\//, "").replace(/\.(png|gif)$/, "")
  );
}

function decorSpriteId(group: string, spriteId: string): string {
  return `decor:${group}:${spriteId}`;
}

// Module-scoped cache. The manifest is a build-time artifact (immutable
// at runtime) — refetching on every interior→overworld transition burns
// a round-trip and, if the network hiccups, would leave the whole
// transition stuck (see boot() early return below). One fetch per page
// load is plenty.
let manifestCache: Manifest | null = null;
let manifestInflight: Promise<Manifest | null> | null = null;

async function loadManifest(): Promise<Manifest | null> {
  if (manifestCache) return manifestCache;
  if (manifestInflight) return manifestInflight;
  manifestInflight = (async () => {
    try {
      const res = await fetch("/sprites/extras/MANIFEST.json");
      if (!res.ok) return null;
      const parsed = (await res.json()) as Manifest;
      manifestCache = parsed;
      return parsed;
    } catch {
      return null;
    } finally {
      manifestInflight = null;
    }
  })();
  return manifestInflight;
}

/** Register every kaplay sprite the plot will draw. Idempotent — calling
 *  again with new sprite ids is fine; kaplay just adds the new ones. */
async function loadPlotSprites(
  k: KAPLAYCtx,
  plot: Plot,
  manifest: Manifest,
): Promise<void> {
  const loads: Promise<unknown>[] = [];

  // Buildings. resolveSpriteUrl handles both catalog-relative paths and
  // uploaded "sprite:<hash>" refs (the latter route through /api/sprites).
  for (const b of plot.buildings) {
    const id = exteriorSpriteId(b);
    loads.push(
      Promise.resolve(k.loadSprite(id, resolveSpriteUrl(b.exteriorSprite))),
    );
  }

  // Decor — every (group, spriteId) referenced by the plot.
  const decorSeen = new Set<string>();
  for (const d of plot.decor) {
    const key = d.group + ":" + d.spriteId;
    if (decorSeen.has(key)) continue;
    decorSeen.add(key);
    const groupEntries = (
      manifest as unknown as Record<string, { id: string; file: string }[]>
    )[d.group];
    if (!groupEntries) continue;
    const entry = groupEntries.find((e) => e.id === d.spriteId);
    if (!entry) continue;
    loads.push(
      Promise.resolve(
        k.loadSprite(
          decorSpriteId(d.group, d.spriteId),
          "/sprites/extras/" + entry.file,
        ),
      ),
    );
  }

  await Promise.all(loads);
}

// =============================================================================
// Rendering
// =============================================================================

function drawGround(k: KAPLAYCtx, worldW: number, worldH: number) {
  // Solid green base — matches the catalog playground. The grass-XX
  // variants in the extras pack are terrain edge tiles with hard brown
  // borders, so tiling them per cell reads as a grid of brown cookies.
  // Variety comes from the tree/bush/flower scatter instead.
  k.add([
    k.rect(worldW * TILE, worldH * TILE),
    k.pos(0, 0),
    k.color(k.Color.fromHex(GRASS_HEX)),
    k.z(0),
  ]);
}

// Paths + ponds are drawn via a single onDraw container per surface —
// not one game object per tile. Kaplay's optimization guide is explicit
// that static visuals should be drawn (drawSprite / drawRect) instead
// of `k.add`'d, because every added object costs a per-frame update
// slot. A dense plot has hundreds of path/pond tiles; folding them into
// one onDraw callback trims that off the game-object list entirely.
// Positions are pre-baked into a Vec2 so the draw callback allocates
// nothing per frame.

interface TileDraw {
  sprite: string;
  pos: ReturnType<KAPLAYCtx["vec2"]>;
}

function drawPaths(k: KAPLAYCtx, paths: PlotPath[]): Set<string> {
  const set = new Set<string>();
  for (const p of paths) {
    for (const [x, y] of p.tiles) set.add(x + "," + y);
  }
  const tiles: TileDraw[] = [];
  for (const key of set) {
    const [xs, ys] = key.split(",");
    const x = parseInt(xs!, 10);
    const y = parseInt(ys!, 10);
    tiles.push({
      sprite: autotile9Slice(set, x, y, "path"),
      pos: k.vec2(x * TILE, y * TILE),
    });
  }
  if (tiles.length > 0) {
    const container = k.add([k.z(0.2)]);
    container.onDraw(() => {
      for (const t of tiles) {
        k.drawSprite({ sprite: t.sprite, pos: t.pos });
      }
    });
  }
  return set;
}

function drawPonds(k: KAPLAYCtx, ponds: PlotPond[]): Set<string> {
  const set = new Set<string>();
  for (const p of ponds) {
    for (let dy = 0; dy < p.h; dy++) {
      for (let dx = 0; dx < p.w; dx++) {
        set.add(p.tx + dx + "," + (p.ty + dy));
      }
    }
  }
  const tiles: TileDraw[] = [];
  for (const key of set) {
    const [xs, ys] = key.split(",");
    const x = parseInt(xs!, 10);
    const y = parseInt(ys!, 10);
    tiles.push({
      sprite: autotile9Slice(set, x, y, "pond"),
      pos: k.vec2(x * TILE, y * TILE),
    });
  }
  if (tiles.length > 0) {
    const container = k.add([k.z(0.15)]);
    container.onDraw(() => {
      for (const t of tiles) {
        k.drawSprite({ sprite: t.sprite, pos: t.pos });
      }
    });
  }
  return set;
}

// Chunk-based decor streaming. `plot.decor` can hit 15-20k entries on the
// full 180×150 world, and every one of those becomes a kaplay game object
// that iterates every frame. Rendering all of them at once made walking
// feel choppy on lower-end machines.
//
// Instead: bucket decor into DECOR_CHUNK-tile squares at boot; keep only
// the chunks within (RADIUS_CX × RADIUS_CY) of the player's chunk alive.
// The player only sees roughly one viewport of decor at a time, so
// bringing "alive" chunks down to ~5-7× the visible area is enough
// buffer to hide streaming pop-in behind the screen edge while keeping
// per-frame object count bounded (~2-4k instead of 15-20k).
//
// Collision is intentionally NOT streamed — the `blocked` set is built
// once from the full decor list so stump collision doesn't depend on
// which chunks are currently rendered.
const DECOR_CHUNK = 8;      // tiles per chunk edge
const DECOR_RADIUS_CX = 6;  // horizontal chunks of buffer around the player
const DECOR_RADIUS_CY = 5;  // vertical chunks of buffer around the player

function chunkKey(cx: number, cy: number): string {
  return cx + "," + cy;
}

function chunkOf(tx: number, ty: number): { cx: number; cy: number } {
  return {
    cx: Math.floor(tx / DECOR_CHUNK),
    cy: Math.floor(ty / DECOR_CHUNK),
  };
}

interface DecorStream {
  update: (playerTx: number, playerTy: number) => void;
  destroy: () => void;
}

function createDecorStream(
  k: KAPLAYCtx,
  decor: PlotDecor[],
): DecorStream {
  // Bucket by chunk. Trees / other decor share the same z rule as the
  // old draw pass — trees on z=8 (in front of buildings' bottom third),
  // ground scatter on z=5.
  const byChunk = new Map<string, PlotDecor[]>();
  for (const d of decor) {
    const { cx, cy } = chunkOf(d.tx, d.ty);
    const key = chunkKey(cx, cy);
    let arr = byChunk.get(key);
    if (!arr) {
      arr = [];
      byChunk.set(key, arr);
    }
    arr.push(d);
  }

  const live = new Map<string, GameObj[]>();

  function spawnChunk(key: string): GameObj[] {
    const entries = byChunk.get(key);
    if (!entries) return [];
    const objs: GameObj[] = [];
    for (const d of entries) {
      const id = decorSpriteId(d.group, d.spriteId);
      objs.push(
        k.add([
          k.sprite(id),
          k.pos(d.tx * TILE, d.ty * TILE),
          k.z(d.group === "trees" ? 8 : 5),
        ]),
      );
    }
    return objs;
  }

  function despawnChunk(objs: GameObj[]) {
    for (const o of objs) {
      try {
        o.destroy();
      } catch {
        // Already destroyed by scene teardown — swallow.
      }
    }
  }

  return {
    update(playerTx: number, playerTy: number) {
      const { cx, cy } = chunkOf(playerTx, playerTy);
      const wanted = new Set<string>();
      for (let dy = -DECOR_RADIUS_CY; dy <= DECOR_RADIUS_CY; dy++) {
        for (let dx = -DECOR_RADIUS_CX; dx <= DECOR_RADIUS_CX; dx++) {
          wanted.add(chunkKey(cx + dx, cy + dy));
        }
      }
      // Spawn chunks newly in range.
      for (const key of wanted) {
        if (live.has(key)) continue;
        live.set(key, spawnChunk(key));
      }
      // Despawn chunks that left the buffer.
      for (const [key, objs] of live.entries()) {
        if (wanted.has(key)) continue;
        despawnChunk(objs);
        live.delete(key);
      }
    },
    destroy() {
      for (const objs of live.values()) despawnChunk(objs);
      live.clear();
    },
  };
}

interface SignDraw {
  postPos: ReturnType<KAPLAYCtx["vec2"]>;
  boardPos: ReturnType<KAPLAYCtx["vec2"]>;
  boardW: number;
  boardH: number;
  stripePos: ReturnType<KAPLAYCtx["vec2"]>;
  labelPos: ReturnType<KAPLAYCtx["vec2"]>;
  label: string;
}

/** Draw the building sprite (still a game object — it needs its z
 *  independently sortable relative to trees/decor) plus register the
 *  sign spec into `signAcc` for batched drawing at scene init. */
function drawBuilding(
  k: KAPLAYCtx,
  b: PlotBuilding,
  signAcc: SignDraw[],
): void {
  // Bottom-center the sprite on the south edge of the plot rect so the
  // building's front door sits at a predictable row (matches what the
  // catalog playground does for extras). Tall sprites like villa-1.png
  // (9×13 tiles) on a 10×7 rect now extend UP instead of overflowing
  // south into the next building's clearing.
  k.add([
    k.sprite(exteriorSpriteId(b)),
    k.anchor("bot"),
    k.pos((b.tx + b.w / 2) * TILE, (b.ty + b.h) * TILE),
    k.z(10),
  ]);

  // Sign in front of the building, two tiles south of the south door.
  // Anchored on the building's door column so longer labels grow
  // symmetrically left/right instead of overflowing the board.
  const signTy = b.ty + b.h;
  const signPy = signTy * TILE;
  const anchorX = (b.tx + b.w / 2) * TILE;

  // Board width scales with label length. Kaplay's default bitmap font
  // measures ~6px per glyph at size 8, plus 6px breathing room each side.
  // Floor of 3 tiles keeps short labels (HOME, YC) at the original size.
  const label = (b.label ?? b.id).toUpperCase();
  const boardH = 14;
  const minBoardW = TILE * 3;
  const boardW = Math.max(minBoardW, label.length * 6 + 12);
  const boardX = anchorX - boardW / 2;

  signAcc.push({
    postPos: k.vec2(anchorX - 1.5, signPy + 14),
    boardPos: k.vec2(boardX, signPy),
    boardW,
    boardH,
    stripePos: k.vec2(boardX, signPy + boardH - 3),
    labelPos: k.vec2(boardX + boardW / 2, signPy + boardH / 2 - 1),
    label,
  });
}

/** After every drawBuilding has populated `signs`, register a single
 *  onDraw container that renders all sign layers for every building in
 *  one pass. Replaces 4 × N game objects (post, board, accent stripe,
 *  label) with 1 game object + N iterations per frame. */
function mountSigns(k: KAPLAYCtx, signs: SignDraw[]): void {
  if (signs.length === 0) return;
  const ink = hex(k, INK);
  const cream = hex(k, theme.signCream);
  const accent = hex(k, theme.buildings.HOME.accent);
  const container = k.add([k.z(20)]);
  container.onDraw(() => {
    for (const s of signs) {
      // Post — narrow ink rect under the board.
      k.drawRect({ pos: s.postPos, width: 3, height: 18, color: ink });
      // Board — cream rounded rect with an ink outline.
      k.drawRect({
        pos: s.boardPos,
        width: s.boardW,
        height: s.boardH,
        color: cream,
        radius: 2,
        outline: { color: ink, width: 1 },
      });
      // Accent stripe — a thin colored bar along the board's bottom.
      k.drawRect({
        pos: s.stripePos,
        width: s.boardW,
        height: 3,
        color: accent,
      });
      // Label — centered inside the board.
      k.drawText({
        text: s.label,
        size: 8,
        pos: s.labelPos,
        anchor: "center",
        color: ink,
      });
    }
  });
}

// =============================================================================
// Scene
// =============================================================================

export type OverworldPlotOpts = {
  /** Pre-loaded plot. If absent, the scene fetches one. */
  plot?: Plot;
  version?: number;
  /** Legacy interior category — "HOME" / "OFFICE" / "LIBRARY" / "STORE".
   *  Spawns the player south of that building's door so coming out of an
   *  interior puts them back where they entered. */
  spawnFrom?: string;
  /** Specific PlotBuilding.id the player just exited. Preferred over
   *  `spawnFrom` when multiple buildings share the same category — e.g.
   *  coming out of a second STORE-category building should spawn next
   *  to that building, not the canonical store. */
  spawnBuildingId?: string;
};

export function registerOverworldPlotScene(k: KAPLAYCtx) {
  k.scene("overworld-plot", (opts: OverworldPlotOpts = {}) => {
    k.setBackground(hex(k, GRASS_HEX));

    // React's <BootScreen> sits over the canvas with z-100 until the
    // ui store's worldReady flag flips, so no in-canvas loading text
    // is needed any more. We reset the flag on every scene entry so a
    // refresh / interior round-trip re-arms the overlay.
    ui.setWorldReady(false);

    let unsubscribe: (() => void) | null = null;
    let unsubSession: (() => void) | null = null;
    let detachRemotes: (() => void) | null = null;
    let decorStreamRef: DecorStream | null = null;
    // Cancellation guard for the async boot pipeline. Flipped by
    // onSceneLeave. Every await point checks this before proceeding, and
    // in particular no `k.onUpdate`, `k.onKeyPress`, `k.add`, or
    // `attachRemotePlayers` runs after cancellation — otherwise a
    // previous scene's boot() that landed mid-transition would register
    // its handlers on the *new* scene, doubling (then tripling, then
    // …) the per-frame work every interior→overworld round-trip and
    // making character movement progressively laggier until reload.
    let cancelled = false;

    async function boot(initialPlot?: Plot, initialVersion?: number) {
      const initialPayload = initialPlot
        ? { plot: initialPlot, version: initialVersion ?? 0 }
        : await loadPlot();
      if (cancelled) return;

      // Manifest is needed both to render the plot AND, on the guest path,
      // to seed the generator (it scatters decor from the extras pack).
      // Load it before we decide what to render.
      const manifest = await loadManifest();
      if (cancelled) return;
      if (!manifest) {
        console.error("[overworld] missing extras manifest");
        // Flip worldReady=true so the TransitionLoading overlay dismisses
        // even in this degraded state. Prior behaviour left it stuck
        // forever and forced the player to reload the whole page to
        // recover from a single failed static-asset fetch.
        ui.setWorldReady(true);
        return;
      }

      // Guest path — no session → fall back to the pre-baked default plot
      // shipped by @town/plot (built from seed="core", activeCount=6 via
      // `pnpm --filter @town/plot-gen build-default`). Same blob every
      // visitor sees, no client-side generation cost.
      const isGuest = initialPayload === null;
      const payload = initialPayload ?? { plot: defaultPlot, version: 0 };

      const { plot, version } = payload;
      // Make the active plot readable by sibling scenes (the interior
      // reads `plot.npcs` to render NPC slots per-building).
      setCachedPlot(plot);
      await loadPlotSprites(k, plot, manifest);
      if (cancelled) return;

      // Tell realtime we're in the overworld so heartbeats + sleep/wake
      // publishes carry the correct scene tag. Without this, a visitor
      // who just exited an interior would keep broadcasting the old
      // interior scene id until their next move.
      setLocalScene("overworld");

      const worldW = plot.world.w;
      const worldH = plot.world.h;
      const worldPxW = worldW * TILE;
      const worldPxH = worldH * TILE;
      registerWorldBounds({ worldPxW, worldPxH });

      // --- Render order: ground → ponds → paths → decor → buildings.
      // Decor is streamed in chunks around the player instead of being
      // added all at once — see `createDecorStream`. Initial spawn +
      // updates happen after the player exists so we can seed the
      // stream from the spawn tile.
      drawGround(k, worldW, worldH);
      const pondSet = drawPonds(k, plot.ponds);
      const pathSet = drawPaths(k, plot.paths);
      const decorStream = createDecorStream(k, plot.decor);
      decorStreamRef = decorStream;
      const signs: SignDraw[] = [];
      for (const b of plot.buildings) drawBuilding(k, b, signs);
      mountSigns(k, signs);

      // Tell React the world is rendered — BootScreen can dismiss
      // itself (after its sweep finishes) and the overworld becomes
      // visible without an extra in-canvas loading text.
      ui.setWorldReady(true);

      // --- Collision + door routing.
      const blocked = new Set<string>();
      const doorOwner = new Map<string, PlotBuilding>();
      for (const b of plot.buildings) {
        // Every tile in the footprint blocks…
        for (let dy = 0; dy < b.h; dy++) {
          for (let dx = 0; dx < b.w; dx++) {
            blocked.add(b.tx + dx + "," + (b.ty + dy));
          }
        }
        // …except the south-edge centre, which is the door.
        const doorTx = b.tx + Math.floor(b.w / 2);
        const doorTy = b.ty + b.h - 1;
        blocked.delete(doorTx + "," + doorTy);
        doorOwner.set(doorTx + "," + doorTy, b);
      }
      // Pond tiles block.
      for (const key of pondSet) blocked.add(key);

      // Stump collision. Stumps are physical objects sitting on the
      // forest floor so they block the player. Trees are walkable —
      // even trunk-only blocking walled off transit between plots when
      // canopies overhung clearing edges, and the playground happily
      // lets the player wander through the forest visually. Bushes /
      // flowers / mushrooms / loose rocks stay walkable as ground
      // litter.
      const stumpDims = new Map<string, { tileW: number; tileH: number }>();
      for (const e of manifest.stumps ?? []) {
        stumpDims.set(e.id, { tileW: e.tileW, tileH: e.tileH });
      }
      for (const d of plot.decor) {
        if (d.group !== "stumps") continue;
        const dims = stumpDims.get(d.spriteId);
        if (!dims) continue;
        const baseX = Math.floor(d.tx);
        const baseY = Math.floor(d.ty);
        for (let dy = 0; dy < dims.tileH; dy++) {
          for (let dx = 0; dx < dims.tileW; dx++) {
            blocked.add(baseX + dx + "," + (baseY + dy));
          }
        }
      }
      // Paths always win — if a stump landed on a road tile the road
      // still has to be usable.
      for (const key of pathSet) blocked.delete(key);

      const isBlocked = (tx: number, ty: number) => {
        if (tx < 0 || ty < 0 || tx >= worldW || ty >= worldH) return true;
        return blocked.has(tx + "," + ty);
      };

      // Spawn the player just south of a building's door. If we just came
      // out of an interior, prefer the matching building so the transition
      // is seamless; otherwise default to HOME (cold-start spawn).
      const CATEGORY_BY_LEGACY: Record<string, PlotBuilding["category"]> = {
        HOME: "HOME",
        OFFICE: "WORK",
        LIBRARY: "READ",
        STORE: "MARKET",
      };
      const targetCategory = opts.spawnFrom
        ? CATEGORY_BY_LEGACY[opts.spawnFrom]
        : undefined;
      // Prefer the exact building id when one was passed (multiple
      // buildings in the same category disambiguate this way), then the
      // first building of the legacy category, then HOME, then any.
      const spawnBuilding =
        (opts.spawnBuildingId &&
          plot.buildings.find((b) => b.id === opts.spawnBuildingId)) ||
        (targetCategory &&
          plot.buildings.find((b) => b.category === targetCategory)) ||
        plot.buildings.find((b) => b.plotKey === "home") ||
        plot.buildings[0];
      // Spawn one tile south of the building's door tile. The door is at
      // (b.tx + floor(b.w/2), b.ty + b.h - 1) — the south-edge centre.
      // Putting the player at door.ty + 1 lines up entry + exit on the
      // same tile, so coming out of an interior drops you exactly where
      // you'd be after stepping back off the door.
      const spawn: Tile = spawnBuilding
        ? {
            tx: spawnBuilding.tx + Math.floor(spawnBuilding.w / 2),
            ty: Math.min(worldH - 1, spawnBuilding.ty + spawnBuilding.h),
          }
        : { tx: Math.floor(worldW / 2), ty: Math.floor(worldH / 2) };

      const onArrive = (tile: Tile) => {
        // Realtime: every tile change is one publish. Quantized by design —
        // no per-tween-frame spam.
        publishLocalPosition({
          tx: tile.tx,
          ty: tile.ty,
          facing: player.facing,
        });
        // Stream decor chunks in/out of range on every tile arrival. Cheap
        // per-move: chunk math + a Set diff over ~130 chunks total.
        decorStream.update(tile.tx, tile.ty);
        const owner = doorOwner.get(tile.tx + "," + tile.ty);
        if (!owner) return;
        // Sleeping gate — when the town's aura is under the threshold,
        // the residents are "asleep". We refuse building entry with a
        // bouncer-style dialogue instead of transitioning into an
        // interior whose NPCs can't respond anyway (server-side chat
        // routes 423 on aura < threshold).
        if (auraIsSleeping()) {
          ui.openDialogue({
            key: "town-sleeping",
            speaker: "Bouncer",
            accent: PALETTE.h240,
            // One line on purpose — the dialogue types out chars fast
            // but pauses ~250ms between lines, so a three-line quip
            // felt slow. Same copy, snappier delivery.
            lines: [
              "Kicked out. Everyone's asleep — come back when the vibes recover.",
            ],
            action: {
              label: "OK",
              onPress: () => ui.closeDialogue(),
            },
          });
          return;
        }
        // Route into the legacy interior scene by category. Future: read
        // owner.variantId, look up MDX-driven interior.
        const key = owner.category as
          | "HOME"
          | "OFFICE"
          | "READ"
          | "MARKET"
          | "WORK";
        const legacyKey =
          key === "HOME"
            ? "HOME"
            : key === "READ"
              ? "LIBRARY"
              : key === "MARKET"
                ? "STORE"
                : "OFFICE";
        k.go("interior", { building: legacyKey, buildingId: owner.id });
      };

      const player = makePlayer(k, spawn, isBlocked, onArrive);

      // Seed the streaming buffer around the spawn tile before the first
      // frame renders so the player never sees an empty forest that
      // fills in a frame later.
      decorStream.update(player.tile.tx, player.tile.ty);

      // First publish so anyone already in the room sees where we spawned.
      publishLocalPosition({
        tx: player.tile.tx,
        ty: player.tile.ty,
        facing: player.facing,
      });

      // Spawn / move / despawn remote players as the realtime channel
      // pushes updates. Filtered to "overworld" so visitors who have
      // walked into a house don't render as ghosts at the door tile.
      // Returns a teardown for scene-leave.
      detachRemotes = attachRemotePlayers(k, { scene: "overworld" });

      // Camera — follow the player at 1:1 scale, clamped so the view
      // never reaches past the world edge. The kaplay canvas's own
      // stretch+letterbox handles fitting VIEW_W × VIEW_H to the
      // browser viewport.
      //
      // Scale is re-pinned every frame (not just on scene boot) as
      // defense-in-depth against a Flyover cinematic finishing in a
      // bad state and leaving the cinematic's wide scale stuck on the
      // camera. Re-pin to 1.0 the moment the cinematic releases its
      // lock; the brief tween-end frame the user sees is at the
      // already-wide cinematic scale, but the next player-follow tick
      // snaps it back.
      k.setCamScale(1);
      const halfW = VIEW_W / 2;
      const halfH = VIEW_H / 2;
      k.onUpdate(() => {
        // Cinematic overlays (Flyover) own the camera while active —
        // bail before re-anchoring so the scripted pan isn't yanked
        // back to the player every frame.
        if (isCinematicLocked()) return;
        // Cheap idempotent write — kaplay no-ops when the value is
        // already 1, so this is a single number compare per frame.
        k.setCamScale(1);
        const tx = player.pos.x + TILE / 2;
        const ty = player.pos.y + TILE / 2;
        const cx = Math.max(halfW, Math.min(worldPxW - halfW, tx));
        const cy = Math.max(halfH, Math.min(worldPxH - halfH, ty));
        // Snap to integer pixels — kaplay's pixel-art rendering floors
        // sub-pixel camera positions, and any fractional drift makes
        // tilemap edges alias as the camera pans.
        k.setCamPos(Math.round(cx), Math.round(cy));
      });

      // Proximity tick — runs every frame but only mutates the UI store
      // when the closest target actually changes. PROX_RANGE is Chebyshev
      // tiles (5x5 area around the player).
      const PROX_RANGE = 2;
      const PROX_LEAVE_RANGE = 4; // wider than enter so we don't flicker
      let proxKey: string | null = null;
      k.onUpdate(() => {
        const me = getSelfIdentity();
        if (!me) {
          if (proxKey !== null) {
            proxKey = null;
            ui.setProximity(null);
          }
          return;
        }
        let bestKey: string | null = null;
        let bestName = "";
        let bestCharacter = "";
        let bestDist = Infinity;
        for (const r of getRemotePlayersForScene("overworld")) {
          const d = Math.max(
            Math.abs(r.tx - player.tile.tx),
            Math.abs(r.ty - player.tile.ty),
          );
          // Hysteresis: keep an existing target until it drifts outside
          // PROX_LEAVE_RANGE; only newcomers must be within PROX_RANGE.
          const ceiling =
            r.participantKey === proxKey ? PROX_LEAVE_RANGE : PROX_RANGE;
          if (d <= ceiling && d < bestDist) {
            bestKey = r.participantKey;
            bestName = r.name;
            bestCharacter = r.character;
            bestDist = d;
          }
        }
        if (bestKey !== proxKey) {
          proxKey = bestKey;
          ui.setProximity(
            bestKey
              ? {
                  participantKey: bestKey,
                  name: bestName,
                  character: bestCharacter,
                }
              : null,
          );
        }
      });

      // Cmd+K teleport handler. The CommandBar picks a building id, this
      // parks the player one tile south of that building's door — same
      // tile they'd stand on after exiting the interior. Publishes the
      // new position so remotes see the jump instead of a rubber-band
      // walk on next arrow key. No-op if the id doesn't match a
      // building or the door tile falls off the world.
      registerTeleport((buildingId: string) => {
        const b = plot.buildings.find((x) => x.id === buildingId);
        if (!b) return;
        const tx = b.tx + Math.floor(b.w / 2);
        const ty = Math.min(worldH - 1, b.ty + b.h);
        // Same guard as the arrow-key path: refuse if the destination
        // is somehow blocked (e.g. a pond crept into a door footprint).
        if (isBlocked(tx, ty)) return;
        player.tile = { tx, ty };
        player.pos = k.vec2(tx * TILE, ty * TILE);
        publishLocalPosition({
          tx,
          ty,
          facing: player.facing,
        });
        // Kick decor + proximity to recompute against the new tile.
        decorStream.update(tx, ty);
      });

      // SPACE opens the DM panel with the current proximity target. We
      // listen here instead of inside <InteractionPrompt> because the
      // canvas always has keyboard focus when no overlay is open.
      k.onKeyPress("space", () => {
        if (ui.isPaused()) return;
        const target = ui.getState().proximity;
        if (!target) return;
        const slug = getActiveTownSlug();
        if (!slug) return;
        ui.openDm({
          townSlug: slug,
          otherKey: target.participantKey,
          otherName: target.name,
        });
      });

      // Publish the real session to the HUD, then keep it in sync as the
      // user signs in / out so the identity badge stops reading "Guest"
      // after a successful login.
      ui.setHud({ kind: "overworld", session: getSession() });
      unsubSession = onSessionChange((s) => {
        ui.setHud({ kind: "overworld", session: s });
      });

      if (isGuest) {
        // Seeded preview plot — no DB row, so no polling subscription.
        // The interior scene still fires openGuestCta when the guest
        // enters a building; the overworld itself stays quiet so the
        // <Landing> welcome modal is the only sign-up prompt up here.
      } else {
        // Signed-in path — poll the DB row and re-enter the scene whenever
        // the stored plot version bumps.
        unsubscribe = subscribePlot(version, (next) => {
          k.go("overworld-plot", { plot: next.plot, version: next.version });
        });
      }
    }

    // Any thrown error inside boot() (a sprite 404, a network blip during
    // loadPlot, a subscribePlot init failure) would otherwise leave the
    // TransitionLoading overlay pinned — the only recovery was a full
    // page reload. Catch here so the overlay always dismisses.
    void boot(opts.plot, opts.version).catch((err) => {
      console.error("[overworld] boot failed", err);
      ui.setWorldReady(true);
    });

    k.onSceneLeave(() => {
      // Cancel any in-flight boot() so its post-await registrations
      // (k.onUpdate handlers, k.add game objects, subscribePlot) don't
      // land on the next scene — see `cancelled` declaration above for
      // the perf-lag repro this prevents.
      cancelled = true;
      if (unsubscribe) unsubscribe();
      if (unsubSession) unsubSession();
      if (detachRemotes) detachRemotes();
      // Drop every streamed decor game object so kaplay's scene teardown
      // doesn't leak them into the next scene.
      if (decorStreamRef) decorStreamRef.destroy();
      // Clear the teleport bridge so the CommandBar doesn't fire into a
      // dead player reference during interior scenes.
      registerTeleport(null);
      ui.setHud(null);
      ui.setProximity(null);
    });
  });
}
