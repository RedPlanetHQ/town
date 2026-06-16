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

import type { KAPLAYCtx } from "kaplay";

import { TILE, VIEW_W, VIEW_H, INK, PALETTE, hex } from "../config";
import { GRASS_HEX, autotile9Slice } from "../../lib/plot-render";
import { theme } from "../theme";
import { makePlayer, type Tile } from "../entities/player";
import { attachRemotePlayers } from "../entities/remotePlayer";
import { getSession, onSessionChange } from "../auth";
import { openGuestCta } from "../guestCta";
import { ui } from "../../ui/store";
import { loadPlot, subscribePlot } from "../plotClient";
import {
  getActiveTownSlug,
  getRemotePlayersForScene,
  getSelfIdentity,
  publishLocalPosition,
  setLocalScene,
} from "../realtime";
import {
  defaultPlot,
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
  // e.g. "exteriors/home/villa-1.png" -> "ext:home/villa-1"
  return (
    "ext:" +
    b.exteriorSprite.replace(/^exteriors\//, "").replace(/\.(png|gif)$/, "")
  );
}

function decorSpriteId(group: string, spriteId: string): string {
  return `decor:${group}:${spriteId}`;
}

async function loadManifest(): Promise<Manifest | null> {
  try {
    const res = await fetch("/sprites/extras/MANIFEST.json", {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as Manifest;
  } catch {
    return null;
  }
}

/** Register every kaplay sprite the plot will draw. Idempotent — calling
 *  again with new sprite ids is fine; kaplay just adds the new ones. */
async function loadPlotSprites(
  k: KAPLAYCtx,
  plot: Plot,
  manifest: Manifest,
): Promise<void> {
  const loads: Promise<unknown>[] = [];

  // Buildings.
  for (const b of plot.buildings) {
    const id = exteriorSpriteId(b);
    loads.push(
      Promise.resolve(k.loadSprite(id, `/sprites/catalog/${b.exteriorSprite}`)),
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

function drawPaths(k: KAPLAYCtx, paths: PlotPath[]): Set<string> {
  const set = new Set<string>();
  for (const p of paths) {
    for (const [x, y] of p.tiles) set.add(x + "," + y);
  }
  for (const key of set) {
    const [xs, ys] = key.split(",");
    const x = parseInt(xs!, 10);
    const y = parseInt(ys!, 10);
    const sprite = autotile9Slice(set, x, y, "path");
    k.add([k.sprite(sprite), k.pos(x * TILE, y * TILE), k.z(0.2)]);
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
  for (const key of set) {
    const [xs, ys] = key.split(",");
    const x = parseInt(xs!, 10);
    const y = parseInt(ys!, 10);
    const sprite = autotile9Slice(set, x, y, "pond");
    k.add([k.sprite(sprite), k.pos(x * TILE, y * TILE), k.z(0.15)]);
  }
  return set;
}

function drawDecor(k: KAPLAYCtx, decor: PlotDecor[]) {
  for (const d of decor) {
    const id = decorSpriteId(d.group, d.spriteId);
    k.add([
      k.sprite(id),
      k.pos(d.tx * TILE, d.ty * TILE),
      k.z(d.group === "trees" ? 8 : 5),
    ]);
  }
}

function drawBuilding(k: KAPLAYCtx, b: PlotBuilding) {
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
  // The plot doesn't expose accent/label yet — pull from variant when
  // we wire interiors in. For now use a sensible default.
  const signTx = b.tx + Math.floor(b.w / 2) - 2;
  const signTy = b.ty + b.h;
  const signPx = signTx * TILE;
  const signPy = signTy * TILE;
  const accent = hex(k, theme.buildings.HOME.accent);
  const ink = hex(k, INK);
  const cream = hex(k, theme.signCream);
  k.add([
    k.rect(3, 18),
    k.pos(signPx + TILE * 1.5 - 1.5, signPy + 14),
    k.color(ink),
    k.z(20),
  ]);
  const boardW = TILE * 3;
  const boardH = 14;
  const boardX = signPx + TILE * 1.5 - boardW / 2;
  k.add([
    k.rect(boardW, boardH, { radius: 2 }),
    k.pos(boardX, signPy),
    k.color(cream),
    k.outline(1, ink),
    k.z(20.1),
  ]);
  k.add([
    k.rect(boardW, 3),
    k.pos(boardX, signPy + boardH - 3),
    k.color(accent),
    k.z(20.2),
  ]);
  k.add([
    k.text(b.plotKey.toUpperCase(), { size: 8 }),
    k.anchor("center"),
    k.pos(boardX + boardW / 2, signPy + boardH / 2 - 1),
    k.color(ink),
    k.z(20.3),
  ]);
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

    async function boot(initialPlot?: Plot, initialVersion?: number) {
      const initialPayload = initialPlot
        ? { plot: initialPlot, version: initialVersion ?? 0 }
        : await loadPlot();

      // Manifest is needed both to render the plot AND, on the guest path,
      // to seed the generator (it scatters decor from the extras pack).
      // Load it before we decide what to render.
      const manifest = await loadManifest();
      if (!manifest) {
        console.error("[overworld] missing extras manifest");
        return;
      }

      // Guest path — no session → fall back to the pre-baked default plot
      // shipped by @town/plot (built from seed="core", activeCount=6 via
      // `pnpm --filter @town/plot-gen build-default`). Same blob every
      // visitor sees, no client-side generation cost.
      const isGuest = initialPayload === null;
      const payload = initialPayload ?? { plot: defaultPlot, version: 0 };

      const { plot, version } = payload;
      await loadPlotSprites(k, plot, manifest);

      // Tell realtime we're in the overworld so heartbeats + sleep/wake
      // publishes carry the correct scene tag. Without this, a visitor
      // who just exited an interior would keep broadcasting the old
      // interior scene id until their next move.
      setLocalScene("overworld");

      const worldW = plot.world.w;
      const worldH = plot.world.h;
      const worldPxW = worldW * TILE;
      const worldPxH = worldH * TILE;

      // --- Render order: ground → ponds → paths → decor → buildings.
      drawGround(k, worldW, worldH);
      const pondSet = drawPonds(k, plot.ponds);
      const pathSet = drawPaths(k, plot.paths);
      drawDecor(k, plot.decor);
      for (const b of plot.buildings) drawBuilding(k, b);

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
      const spawnBuilding =
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
        const owner = doorOwner.get(tile.tx + "," + tile.ty);
        if (!owner) return;
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
        k.go("interior", { building: legacyKey });
      };

      const player = makePlayer(k, spawn, isBlocked, onArrive);

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
      k.setCamScale(1);
      const halfW = VIEW_W / 2;
      const halfH = VIEW_H / 2;
      k.onUpdate(() => {
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
        // The sign-in CTA is the one always-on UI a visitor sees and
        // stays open across scene transitions (overworld → interior →
        // overworld). openGuestCta short-circuits when the dialogue is
        // already this one, so no typewriter restart.
        openGuestCta();
      } else {
        // Signed-in path — poll the DB row and re-enter the scene whenever
        // the stored plot version bumps.
        unsubscribe = subscribePlot(version, (next) => {
          k.go("overworld-plot", { plot: next.plot, version: next.version });
        });
      }
    }

    void boot(opts.plot, opts.version);

    k.onSceneLeave(() => {
      if (unsubscribe) unsubscribe();
      if (unsubSession) unsubSession();
      if (detachRemotes) detachRemotes();
      ui.setHud(null);
      ui.setProximity(null);
    });
  });
}
