import type { KAPLAYCtx } from "kaplay";
import { TILE, VIEW_W, VIEW_H, INK, CREAM, PALETTE, hex } from "../config";
import { theme, type BuildingKey } from "../theme";
import { makePlayer } from "../entities/player";
import { attachRemotePlayers } from "../entities/remotePlayer";
import { getSession, logout, startLogin } from "../auth";
import { GUEST_CTA_KEY, openGuestCta } from "../guestCta";
import { getNpcByBuildingAndSlot } from "../npcs";
import {
  getActiveTownSlug,
  publishLocalPosition,
  setLocalScene,
} from "../realtime";
import { ui } from "../../ui/store";
import {
  getCachedPlot,
  getViewerTownSlug,
  isViewerOwner,
} from "../plotClient";
import {
  isGroupChatOverlayOpen,
  mountGroupChatForScene,
} from "../../features/group-chat";
import { customPlotId, resolveSpriteUrl } from "@town/plot";

// Sprites referenced by CustomPlot interiors aren't pre-loaded at boot
// (they aren't known until the user's plot lands). We register each
// unique ref the first time we see it and remember the kaplay key so
// repeat entries don't double-load.
const customSpriteKeyByRef = new Map<string, string>();
function ensureCustomSpriteLoaded(k: KAPLAYCtx, ref: string): string {
  const cached = customSpriteKeyByRef.get(ref);
  if (cached) return cached;
  // Kaplay sprite keys are bare strings; sanitise the ref so colons /
  // slashes don't trip any lookup.
  const safe = ref.replace(/[^a-z0-9]/gi, "_");
  const key = `custom-${safe}`;
  k.loadSprite(key, resolveSpriteUrl(ref));
  customSpriteKeyByRef.set(ref, key);
  return key;
}

// ===========================================================================
// Interior scene — one generic scene used for all four buildings.
//
// Spec contents:
//   draw       — sprite key (single-PNG room) OR a render function (for
//                code-composed rooms like LIBRARY).
//   roomW/H    — room dimensions in pixels (used to center the camera).
//   walkable   — rectangle of walkable floor in TILE coords.
//   spawn      — tile where the player appears on entry.
//   exit       — tile that returns the player to the overworld.
//   interacts  — list of in-room objects the player can press SPACE on
//                when standing adjacent. Each opens a Panel.
//   npcs       — optional decorative characters drawn in the room.
// ===========================================================================

type RoomDraw = string | ((k: KAPLAYCtx, w: number, h: number) => void);

type Interactable = {
  // Tile the OBJECT occupies. Player triggers by standing on an adjacent
  // tile (4-neighborhood) and pressing SPACE.
  tx: number;
  ty: number;
  // Shown in floating prompt e.g. "[SPACE] Scratchpad". Function form is
  // resolved every frame so dynamic labels (NPC name pulled from CORE
  // workspace) stay live as the underlying data loads.
  label: string | (() => string);
  // Stable identifier for the React panel so re-publishing the same
  // interactable's panel doesn't unmount/remount.
  key: string;
  // When true, the interactable is only mounted for the town's owner
  // (visitors viewing someone else's town won't see / trigger it).
  // Used for system-owned NPCs like the Founder.
  ownerOnly?: boolean;
  // When true, the interactable is only mounted on the FIRST building
  // in its category. Lets the STORE interior keep the system Founder
  // as a singleton even if the user adds extra store-category
  // buildings (`{ id: "cake", plotKey: "store" }`).
  primaryInstanceOnly?: boolean;
  // Accent color used for the floating prompt strip. Required when this
  // interactable uses `onTrigger` (no Panel to read the accent from);
  // optional when a `panel` is provided (we'll fall back to panel.accent).
  accent?: string;
  // Panel rendered on interact. Function form receives `republish` so the
  // action button can re-resolve the panel (used by Profile to flip its
  // signed-in / guest content after login or logout). Omit `panel` if you
  // want SPACE to fire `onTrigger` directly without opening a Panel.
  panel?: Panel | ((republish: () => void) => Panel);
  // Direct trigger — bypasses the Panel system. Useful when SPACE should
  // open a larger overlay (e.g. the memory Explorer, or an NPC greeting
  // dialogue) without making the user press SPACE twice.
  onTrigger?: () => void;
  // Walk-away cleanup. Fires when the player leaves the adjacency that
  // last triggered `onTrigger`, or on scene leave. Used by NPC
  // interactables to close their ambient dialogue when the player
  // wanders off, since dialogues don't pause the world.
  onLeave?: () => void;
};

type PanelAction = {
  label: string;        // e.g. "Sign in" / "Sign out"
  onPress: () => void;  // React fires this when the user clicks the button
};

type Panel = {
  title: string;
  lines: string[];      // body content — one line per array entry
  accent?: string;      // hex
  action?: PanelAction; // optional action button in the panel
};

type Npc = {
  tx: number;
  ty: number;
  sprite: string;
  // Same semantics as Interactable.ownerOnly — hide the sprite (and
  // its tile collision) when a visitor is touring.
  ownerOnly?: boolean;
  // Same semantics as Interactable.primaryInstanceOnly — hide on every
  // building of this category except the first.
  primaryInstanceOnly?: boolean;
};

// CustomPlot interior props — single-tile, top-left anchored sprites.
// Drawn at (tx*TILE, ty*TILE) with no per-prop height offset. The
// catalog-side `Prop` type (with `spritePxH` / multi-tile footprint)
// is used by the code-composed STORE / OFFICE / LIBRARY interiors.
type CustomProp = { tx: number; ty: number; sprite: string };

// Multi-tile static prop (e.g. ATM, kiosk). `tx,ty` is the bottom-left tile
// the prop occupies; `w,h` is its tile footprint. The sprite is drawn anchored
// so its feet sit on row `ty`. All footprint tiles block movement.
type Prop = {
  tx: number;
  ty: number;
  w: number;
  h: number;
  sprite: string;
  spritePxH: number;
};

type Rect = { tx: number; ty: number; w: number; h: number };

type InteriorSpec = {
  draw: RoomDraw;
  roomW: number;
  roomH: number;
  // Main walkable rectangle (typically the room's body). The player can
  // also step onto any rect listed in `extraWalkable` (used for porches
  // / doormats that jut out below the main body).
  walkable: Rect;
  extraWalkable?: Rect[];
  // Furniture / wall tiles inside `walkable` that the player cannot step
  // on. Used for single-sprite rooms (HOME, OFFICE) where collision can't
  // be derived from individual prop entities.
  blocked?: Rect[];
  spawn: { tx: number; ty: number };
  exit: { tx: number; ty: number };
  title: string;
  interacts?: Interactable[];
  npcs?: Npc[];
  props?: Prop[];
  // CustomPlot interior props — separate from `props` because they're
  // 1×1 top-left anchored rather than multi-tile bottom-anchored.
  customProps?: CustomProp[];
};

// ---------------------------------------------------------------------------
// STORE — code-composed shop interior with Modern Exteriors props.
//
// The room is an enclosed cream-tiled shop: cocoa-brown walls on three sides
// (top + left + right), a doorway at the bottom-center, the "Mall" signboard
// and two SALE window decals on the back wall, an ATM kiosk (the "price
// machine"), a red phone booth (the "character changer"), and the creator
// NPC standing in the middle of the floor.
// ---------------------------------------------------------------------------
const STORE_WALL  = "#3a2632"; // dark cocoa-rose, slightly darker than backdrop
const STORE_TRIM  = "#6a4458"; // wainscot trim — accent at wall/floor seam
const STORE_TILE1 = "#e8d9b6"; // warm cream, primary floor
const STORE_TILE2 = "#d9c7a0"; // slightly darker cream, checker accent
const STORE_GROUT = "#a8916a"; // grout line between tiles

function drawStore(k: KAPLAYCtx, w: number, h: number) {
  // ---- Floor: cream-tile checker so the shop reads as indoors. ----
  // Each tile gets the lighter or darker shade based on parity, with a 1px
  // grout shadow on the south + east edges so the tiles read as discrete
  // squares instead of a flat field.
  const tilesX = Math.ceil(w / TILE);
  const tilesY = Math.ceil(h / TILE);
  for (let y = 0; y < tilesY; y++) {
    for (let x = 0; x < tilesX; x++) {
      const color = ((x + y) & 1) === 0 ? STORE_TILE1 : STORE_TILE2;
      k.add([
        k.rect(TILE, TILE),
        k.pos(x * TILE, y * TILE),
        k.color(hex(k, color)),
        k.z(0),
      ]);
      // Grout — bottom + right edges.
      k.add([
        k.rect(TILE, 1),
        k.pos(x * TILE, y * TILE + TILE - 1),
        k.color(hex(k, STORE_GROUT)),
        k.opacity(0.35),
        k.z(0.05),
      ]);
      k.add([
        k.rect(1, TILE),
        k.pos(x * TILE + TILE - 1, y * TILE),
        k.color(hex(k, STORE_GROUT)),
        k.opacity(0.35),
        k.z(0.05),
      ]);
    }
  }

  // ---- Walls: top (2 tiles), left/right (1 tile each), bottom band. ----
  const wallTopH = TILE * 2;     // top wall is taller so signage has room
  const wallSideW = TILE * 1;
  const wallBotH = TILE * 1;
  const doorTx = Math.floor(w / TILE / 2);   // center column for exit doorway
  const doorPxL = doorTx * TILE;
  const doorPxR = (doorTx + 1) * TILE;

  // Top wall slab.
  k.add([
    k.rect(w, wallTopH),
    k.pos(0, 0),
    k.color(hex(k, STORE_WALL)),
    k.z(0.5),
  ]);
  // Trim stripe at the base of the top wall — reads as crown molding.
  k.add([
    k.rect(w, 2),
    k.pos(0, wallTopH - 2),
    k.color(hex(k, STORE_TRIM)),
    k.z(0.55),
  ]);
  // Hard ink line where wall meets floor.
  k.add([
    k.rect(w, 1),
    k.pos(0, wallTopH),
    k.color(hex(k, INK)),
    k.opacity(0.7),
    k.z(0.56),
  ]);

  // Left + right side walls (full height to the bottom band).
  const sideWallY = wallTopH;
  const sideWallH = h - wallTopH - wallBotH;
  k.add([
    k.rect(wallSideW, sideWallH),
    k.pos(0, sideWallY),
    k.color(hex(k, STORE_WALL)),
    k.z(0.5),
  ]);
  k.add([
    k.rect(wallSideW, sideWallH),
    k.pos(w - wallSideW, sideWallY),
    k.color(hex(k, STORE_WALL)),
    k.z(0.5),
  ]);
  // Vertical trim lines along the inside edge of each side wall.
  k.add([
    k.rect(1, sideWallH),
    k.pos(wallSideW, sideWallY),
    k.color(hex(k, INK)),
    k.opacity(0.5),
    k.z(0.56),
  ]);
  k.add([
    k.rect(1, sideWallH),
    k.pos(w - wallSideW - 1, sideWallY),
    k.color(hex(k, INK)),
    k.opacity(0.5),
    k.z(0.56),
  ]);

  // Bottom wall band with a 1-tile doorway cut out for the exit.
  const botY = h - wallBotH;
  k.add([
    k.rect(doorPxL, wallBotH),
    k.pos(0, botY),
    k.color(hex(k, STORE_WALL)),
    k.z(0.5),
  ]);
  k.add([
    k.rect(w - doorPxR, wallBotH),
    k.pos(doorPxR, botY),
    k.color(hex(k, STORE_WALL)),
    k.z(0.5),
  ]);
  // Cream doormat stripe across the doorway gap so the exit reads as an
  // intentional threshold and not a hole in the wall.
  k.add([
    k.rect(TILE, 4),
    k.pos(doorPxL, botY),
    k.color(hex(k, PALETTE.h330)),
    k.z(0.5),
  ]);

  // ---- Signage on the back wall. ----
  // Mall signboard centered on the top wall (sprite is 64x32 = 4x2 tiles).
  const signW = 64;
  const signX = Math.floor((w - signW) / 2);
  k.add([
    k.sprite("store_sign"),
    k.pos(signX, 0),
    k.z(1.5),
  ]);
  // SALE window decals flanking the sign (sprite is 32x32 = 2x2 tiles).
  k.add([
    k.sprite("store_window"),
    k.pos(TILE * 2, 0),
    k.z(1.5),
  ]);
  k.add([
    k.sprite("store_window"),
    k.pos(w - TILE * 4, 0),
    k.z(1.5),
  ]);
}

// ---------------------------------------------------------------------------
// OFFICE — code-composed room (same pattern as STORE).
//
// The room is an open-plan office: a single LimeZu Room Builder floor tile
// is repeated across the floor (clean grey checker, no dot stipple), walls
// are flat dark navy with a brighter trim line, doorway cuts the bottom
// wall at center. Furniture is dropped in as individual sprite props
// (workstation w/ dual monitor = Tasks board, plants, printer, cabinet).
// ---------------------------------------------------------------------------
const OFFICE_WALL = "#2c3848"; // dark slate-blue, modern office back wall
const OFFICE_TRIM = "#5a6b7e"; // lighter slate for crown trim
const OFFICE_DOORMAT = "#cbd2dc"; // pale grey threshold reading

function drawOffice(k: KAPLAYCtx, w: number, h: number) {
  // ---- Floor: tile the office_floor sprite across the room. ----
  const tilesX = Math.ceil(w / TILE);
  const tilesY = Math.ceil(h / TILE);
  for (let y = 0; y < tilesY; y++) {
    for (let x = 0; x < tilesX; x++) {
      k.add([
        k.sprite("office_floor"),
        k.pos(x * TILE, y * TILE),
        k.z(0),
      ]);
    }
  }

  // ---- Walls: top (2 tiles), left/right (1 tile each), bottom band. ----
  const wallTopH = TILE * 2;
  const wallSideW = TILE * 1;
  const wallBotH = TILE * 1;
  const doorTx = Math.floor(w / TILE / 2);
  const doorPxL = doorTx * TILE;
  const doorPxR = (doorTx + 1) * TILE;

  // Top wall + crown trim + ink seam to the floor.
  k.add([k.rect(w, wallTopH), k.pos(0, 0), k.color(hex(k, OFFICE_WALL)), k.z(0.5)]);
  k.add([k.rect(w, 2), k.pos(0, wallTopH - 2), k.color(hex(k, OFFICE_TRIM)), k.z(0.55)]);
  k.add([k.rect(w, 1), k.pos(0, wallTopH), k.color(hex(k, INK)), k.opacity(0.6), k.z(0.56)]);

  // Side walls.
  const sideY = wallTopH;
  const sideH = h - wallTopH - wallBotH;
  k.add([k.rect(wallSideW, sideH), k.pos(0, sideY), k.color(hex(k, OFFICE_WALL)), k.z(0.5)]);
  k.add([k.rect(wallSideW, sideH), k.pos(w - wallSideW, sideY), k.color(hex(k, OFFICE_WALL)), k.z(0.5)]);
  k.add([k.rect(1, sideH), k.pos(wallSideW, sideY), k.color(hex(k, INK)), k.opacity(0.45), k.z(0.56)]);
  k.add([k.rect(1, sideH), k.pos(w - wallSideW - 1, sideY), k.color(hex(k, INK)), k.opacity(0.45), k.z(0.56)]);

  // Bottom wall with doorway gap.
  const botY = h - wallBotH;
  k.add([k.rect(doorPxL, wallBotH), k.pos(0, botY), k.color(hex(k, OFFICE_WALL)), k.z(0.5)]);
  k.add([k.rect(w - doorPxR, wallBotH), k.pos(doorPxR, botY), k.color(hex(k, OFFICE_WALL)), k.z(0.5)]);
  // Doormat threshold across the doorway gap.
  k.add([k.rect(TILE, 4), k.pos(doorPxL, botY), k.color(hex(k, OFFICE_DOORMAT)), k.z(0.5)]);
}

// ---------------------------------------------------------------------------
// LIBRARY — code-composed room.
// ---------------------------------------------------------------------------
function drawLibrary(k: KAPLAYCtx, w: number, h: number) {
  k.add([
    k.rect(w, h),
    k.pos(0, 0),
    k.color(hex(k, "#d8b67a")),
    k.z(0),
  ]);
  for (let x = 0; x < w; x += TILE * 2) {
    k.add([
      k.rect(1, h),
      k.pos(x, 0),
      k.color(hex(k, INK)),
      k.opacity(0.07),
      k.z(0.1),
    ]);
  }
  const wallH = TILE * 3;
  k.add([k.rect(w, wallH), k.pos(0, 0), k.color(hex(k, "#5a3a25")), k.z(0.5)]);
  k.add([k.rect(w, 2), k.pos(0, wallH), k.color(hex(k, INK)), k.opacity(0.55), k.z(0.51)]);
  k.add([k.rect(TILE, h), k.pos(0, 0), k.color(hex(k, "#5a3a25")), k.z(0.5)]);
  k.add([k.rect(TILE, h), k.pos(w - TILE, 0), k.color(hex(k, "#5a3a25")), k.z(0.5)]);
  const doorTx = Math.floor(w / TILE / 2) - 1;
  const doorPxL = doorTx * TILE;
  const doorPxR = (doorTx + 2) * TILE;
  k.add([k.rect(doorPxL, TILE), k.pos(0, h - TILE), k.color(hex(k, "#5a3a25")), k.z(0.5)]);
  k.add([k.rect(w - doorPxR, TILE), k.pos(doorPxR, h - TILE), k.color(hex(k, "#5a3a25")), k.z(0.5)]);
  k.add([k.rect(doorPxR - doorPxL, 4), k.pos(doorPxL, h - 4), k.color(hex(k, CREAM)), k.z(0.6)]);
  const shelfY = wallH;
  const shelvesAcross = Math.floor((w - TILE * 2) / (TILE * 2));
  for (let i = 0; i < shelvesAcross; i++) {
    const sx = TILE + i * TILE * 2;
    k.add([
      k.sprite(i % 3 === 1 ? "lib_bookshelf_tall" : "lib_bookshelf_wide"),
      k.pos(sx, shelfY),
      k.z(2),
    ]);
  }
  for (const ty of [h - TILE * 5, h - TILE * 3]) {
    for (let i = 1; i < 4; i++) {
      const tx = i * TILE * 3 + TILE;
      k.add([
        k.rect(TILE * 2, TILE - 2, { radius: 1 }),
        k.pos(tx, ty),
        k.color(hex(k, "#9a5e2e")),
        k.outline(1, hex(k, INK)),
        k.z(1.5),
      ]);
      k.add([
        k.rect(TILE - 6, TILE - 6, { radius: 1 }),
        k.pos(tx + TILE / 2 - (TILE - 6) / 2, ty + TILE),
        k.color(hex(k, PALETTE.h240)),
        k.outline(1, hex(k, INK)),
        k.z(1.4),
      ]);
    }
  }
}

// Generic "say hi → offer to talk → stream chat" flow for every NPC that
// doesn't have a special path. The dialogue surface shows
// "Hi, I'm {name}. {description}" with a [Talk to {name}] action that
// hands off to <Chat /> via ui.openChat().
function openNpcGreeting(opts: {
  /** npcId for the chat endpoint — Npc.id, system NPC id, or a buildingId. */
  npcId: string;
  name: string;
  description: string;
  accent: string;
  /** Override the chat API URL. Defaults to /api/npc-chat. The Founder
   *  uses /api/founder-chat for its own prompt + tools. */
  chatApi?: string;
}): void {
  // Guests (validated visit cookie) can talk to NPCs without a CORE
  // session — the server scopes memory_search to the town owner's
  // memory, and the owner's authored NPC prompt is what controls how
  // much is disclosed. Only truly anonymous viewers (no session AND
  // not touring anyone's town) hit the sign-in CTA.
  if (!getSession() && !getViewerTownSlug()) {
    ui.openDialogue({
      key: `npc-${opts.npcId}-unsigned`,
      speaker: opts.name,
      accent: opts.accent,
      lines: [
        `Hi, I'm ${opts.name}.`,
        opts.description,
        "But the world only remembers folks who've signed the ledger.",
      ],
      action: {
        label: "Sign in with CORE",
        onPress: () => {
          ui.closeDialogue();
          startLogin("/");
        },
      },
      secondary: {
        label: "Not now",
        onPress: () => ui.closeDialogue(),
      },
    });
    return;
  }
  ui.openDialogue({
    key: `npc-${opts.npcId}-greet`,
    speaker: opts.name,
    accent: opts.accent,
    lines: [`Hi, I'm ${opts.name}.`, opts.description],
    action: {
      label: `Talk to ${opts.name}`,
      onPress: () =>
        ui.openChat({
          npcId: opts.npcId,
          speaker: opts.name,
          description: opts.description,
          accent: opts.accent,
          mode: "direct",
          ...(opts.chatApi ? { chatApi: opts.chatApi } : {}),
        }),
    },
    secondary: {
      label: "Not now",
      onPress: () => ui.closeDialogue(),
    },
  });
}

// One Interactable per LIBRARY reading-table tile. Tables sit at
// (col 4/7/10, row 7) and (col 4/7/10, row 9) — see drawLibrary. We tag
// the table tiles themselves; the player triggers SPACE from the chair
// directly south of each table (4-neighborhood adjacency).
// ===========================================================================
// Interior specs per building.
// ===========================================================================

const INTERIORS: Record<BuildingKey, InteriorSpec> = {
  HOME: {
    // Pre-built LimeZu Modern Interiors home (Generic Home 1, 16x16).
    // Credit: limezu.itch.io — license allows commercial + non-commercial use
    // with attribution.
    //
    // Layout (14 cols × ~13.4 rows = 224 × 214 px). Two connected rooms:
    //   row 0-1   : top wall + chimney + fireplace (outside walkable)
    //   row 2-7   : PARQUET LIVING ROOM (cols 3-11) — main walkable
    //   row 8-10  : BATHROOM — only col 7 is a passage between the rooms
    //   row 11-12 : PATIO / front entryway (cols 3-11) — walkable
    //   row 13    : bottom wall, front-door doormat at col 7 (exit tile)
    //
    // Player enters from the overworld's south-facing home door, spawns on
    // the patio just inside, and walks north through the bathroom passage
    // to reach the living room.
    draw: "interior_home_room",
    roomW: 224, roomH: 214,
    walkable: { tx: 3, ty: 2, w: 9, h: 6 }, // parquet living room
    extraWalkable: [
      { tx: 7, ty: 8, w: 1, h: 3 },  // bathroom passage (col 7, rows 8-10)
      { tx: 3, ty: 11, w: 9, h: 2 }, // patio / front entryway
      { tx: 7, ty: 13, w: 1, h: 1 }, // front-door doormat — exit tile
    ],
    blocked: [
      // Parquet — furniture intruding into the living-room walkable rect.
      { tx: 4, ty: 2, w: 2, h: 1 },  // dining table base against back wall
      { tx: 8, ty: 2, w: 1, h: 1 },  // kitchen counter
      { tx: 9, ty: 2, w: 3, h: 1 },  // bunk bed footboard
      { tx: 3, ty: 5, w: 2, h: 2 },  // parked motorcycle
      { tx: 10, ty: 7, w: 2, h: 1 }, // side table with vase + book
      // Patio — potted plants in the two corners.
      { tx: 3, ty: 12, w: 1, h: 1 },
      { tx: 11, ty: 12, w: 1, h: 1 },
    ],
    spawn: { tx: 7, ty: 12 }, // patio, just north of the front doormat
    exit:  { tx: 7, ty: 13 }, // doormat — stepping here returns to overworld
    title: "HOME",
    // CORE founder — system NPC, singleton across the owner's town.
    // Lives at HOME on the canonical home building (id === "home"; we
    // enforce exactly one of those server-side). Visitors don't see him
    // (ownerOnly). The user-owned butler sprite renders at its plot
    // slot via the merge in registerInteriorScene below.
    npcs: [
      {
        tx: 4, ty: 4,
        sprite: "founder",
        ownerOnly: true,
        primaryInstanceOnly: true,
      },
    ],
    // NPC sprite + interactable are merged in at scene mount from
    // plot.npcs (slot) + the Npc DB row (chat data). The interior spec
    // only keeps static fixtures like the scratchpad and the bed, plus
    // the system Founder above.
    interacts: [
      {
        tx: 4, ty: 4,
        key: "home-founder",
        label: "Talk to Founder",
        accent: theme.buildings.HOME.accent,
        ownerOnly: true,
        primaryInstanceOnly: true,
        onTrigger: () =>
          openNpcGreeting({
            npcId: "core-founder",
            name: "Founder",
            description:
              "Hangs out at home. Tracks the CORE roadmap — knows what's coming.",
            accent: theme.buildings.HOME.accent,
            chatApi: "/api/founder-chat",
          }),
        onLeave: () => ui.closeDialogue(),
      },
      {
        // Scratchpad at the dining table on the back wall (cols 4-5, row 1).
        // The interactable lives on the table base at (5, 2); the player
        // stands on the brown rug at (5, 3) below to "sit and write".
        tx: 5, ty: 2,
        key: "home-scratchpad",
        label: "Sit and work on today's checklist",
        panel: {
          title: "SCRATCHPAD",
          accent: theme.buildings.HOME.accent,
          lines: [
            "Today's page:",
            "",
            "( ) write tasks here",
            "",
            "CORE picks up checkboxes",
            "within ~3 minutes.",
            "",
            "(text input — coming next pass)",
          ],
        },
      },
      {
        // Profile + login/logout on the bunk bed in the back-right corner
        // (cols 9-11, row 1-2). The interactable lives on the bed at (10, 2);
        // the player approaches from the green rug at (10, 3) below. The
        // panel rebuilds itself each press from getSession() so the auth
        // state (Guest vs signed-in name) stays live. Sign-in is a top-level
        // navigation into CORE's OAuth flow (see src/game/auth.ts); after
        // CORE redirects back the page reloads and the panel reads the
        // refreshed session on next interact.
        tx: 10, ty: 2,
        key: "home-profile",
        label: () => (getSession() ? "Profile" : "Sign in"),
        panel: (republish) => {
          const s = getSession();
          if (s) {
            return {
              title: "PROFILE",
              accent: theme.buildings.HOME.accent,
              lines: [
                `Signed in as ${s.user.name}`,
                s.user.email,
                "",
                "Points + leaderboard rank",
                "will appear here once",
                "CORE events start flowing.",
              ],
              action: {
                label: "Sign out",
                onPress: () => {
                  void logout().then(() => republish());
                },
              },
            };
          }
          return {
            title: "PROFILE",
            accent: theme.buildings.HOME.accent,
            lines: [
              "Not signed in — Guest mode.",
              "",
              "Sign in to start earning",
              "points from CORE: tasks",
              "handed off, integrations",
              "connected, memory grown.",
            ],
            action: {
              label: "Sign in with CORE",
              onPress: () => startLogin("/"),
            },
          };
        },
      },
    ],
  },
  OFFICE: {
    // Code-composed office (same pattern as STORE). Built from clean
    // LimeZu Room Builder Office floor tiles + Modern Office Revamped
    // furniture singles. Credit: limezu.itch.io.
    //
    // Layout (16 cols × 10 rows = 256 × 160 px):
    //   row 0-1  : top wall slab + crown trim
    //   col 0/15 : side walls (1 tile wide)
    //   row 2-8  : open work floor (cols 1-14) — walkable
    //   row 9    : bottom wall with doorway gap at col 7
    //   row 10   : doormat threshold (extraWalkable, exit tile)
    //
    // Furniture (all props are 32×48 = 2 tiles wide × 3 tall, drawn with
    // feet on the named row):
    //   • Dual-monitor workstation (cols 7-8, feet row 5).
    //   • Tall plant (col 2, feet row 4) on the back wall.
    //   • Snake plant (col 13, feet row 4) on the back wall.
    //   • Filing cabinet (col 4, feet row 4) on the back wall.
    //   • Printer station (col 11, feet row 4) on the back wall.
    //   • Coworker NPC at (11, 6) — east of the workstation.
    draw: drawOffice,
    roomW: 16 * TILE, roomH: 10 * TILE,
    walkable:      { tx: 1, ty: 2, w: 14, h: 7 },
    extraWalkable: [{ tx: 7, ty: 9, w: 1, h: 1 }],
    spawn: { tx: 7, ty: 8 },
    exit:  { tx: 7, ty: 9 },
    title: "OFFICE",
    // Three workstations along the back wall. Each workstation is a
    // single 32×64 sprite composed in PIL: monitor on top, cream desk
    // surface in the middle, orange office chair (south-facing back) on
    // the bottom — so the cluster reads cleanly as "person sits here to
    // use the computer". Anchored at the CHAIR row (ty=5), the sprite
    // visually occupies rows 2-5:
    //   row 2 : (transparent — above the monitor)
    //   row 3 : monitor / dual-monitor stand
    //   row 4 : cream desk surface
    //   row 5 : orange chair (where the NPC visually sits)
    //
    // Middle workstation uses the dual-monitor variant so it reads as
    // the centerpiece of the room. Two plants fill the gaps between
    // workstations.
    //
    // The office worker NPC sprite + interactable land here via the plot
    // slot merge in registerInteriorScene — no static entry here.
    props: [
      // ---- Workstations (composed sprite, chair feet on row 5) ----
      { tx: 2,  ty: 5, w: 2, h: 4, sprite: "office_workstation",      spritePxH: 64 },
      { tx: 7,  ty: 5, w: 2, h: 4, sprite: "office_workstation_dual", spritePxH: 64 },
      { tx: 12, ty: 5, w: 2, h: 4, sprite: "office_workstation",      spritePxH: 64 },
      // ---- Plants on the back wall between workstations ----
      { tx: 5,  ty: 4, w: 2, h: 3, sprite: "office_plant_tall",       spritePxH: 48 },
      { tx: 10, ty: 4, w: 2, h: 3, sprite: "office_plant_snake",      spritePxH: 48 },
    ],
    interacts: [],
  },
  LIBRARY: {
    draw: drawLibrary,
    roomW: TILE * 16, roomH: TILE * 12,
    walkable: { tx: 1, ty: 3, w: 14, h: 8 },
    spawn: { tx: 7, ty: 10 },
    exit:  { tx: 7, ty: 11 },
    title: "LIBRARY",
    // Library keeper sprite + interactable land here via the plot slot
    // merge in registerInteriorScene — no static entries.
    interacts: [],
  },
  STORE: {
    // Cream-tiled shop interior, walled on three sides, with a doorway at
    // the bottom-center. Layout is 16x10 tiles (256x160 px):
    //   rows 0-1   top wall (Mall signboard + two SALE window decals)
    //   col 0/15   side walls
    //   rows 2-8   walkable floor
    //   row 9      bottom wall band with a 1-tile doorway gap at col 7
    // The room is intentionally roomy so more "stations" can be added later
    // (cosmetic shop, achievements, etc.) without re-architecting.
    draw: drawStore,
    roomW: 256, roomH: 160,
    walkable:      { tx: 1, ty: 2, w: 14, h: 7 },
    extraWalkable: [{ tx: 7, ty: 9, w: 1, h: 1 }], // exit doormat in doorway
    spawn: { tx: 7, ty: 8 },
    exit:  { tx: 7, ty: 9 },
    title: "STORE",
    // No system NPCs at the store any more — the CORE founder lives at
    // HOME (see the HOME interior). The user-owned shopkeeper sprite
    // lands here via the plot slot merge in registerInteriorScene.
    npcs: [],
    props: [
      // ATM "price machine" on the left. Sprite is 32x48 (2w x 3h); bottom
      // row sits on (3, 8), so the unit occupies cols 3-4, rows 6-8.
      { tx: 3, ty: 8, w: 2, h: 3, sprite: "store_atm",   spritePxH: 48 },
      // Red phone booth as the "character changer" on the right. Sprite is
      // 48x80 (3w x 5h); bottom-left tile is (11, 8), occupies cols 11-13,
      // rows 4-8.
      { tx: 11, ty: 8, w: 3, h: 5, sprite: "store_booth", spritePxH: 80 },
    ],
    interacts: [
      // CORE founder — system NPC. Always at the store for the OWNER
      // (visitors viewing another town don't see him: ownerOnly skips
      // both the sprite above and this interactable). System prompt
      // + name come from apps/web/src/data/system-npcs/core-founder.mdx.
      // Chat routes through /api/founder-chat — separate prompt + tools
      // from the regular NPC chat.
      {
        // Price machine — bottom-left tile of the ATM (player approaches
        // from the south or east).
        tx: 3, ty: 8,
        key: "store-price",
        label: "Check CORE price",
        panel: {
          title: "CORE PRICING",
          accent: PALETTE.h330,
          lines: [
            "Free      — self-host",
            "Pro  $20  — hosted, 1 gateway",
            "Team $50  — multi-user",
            "",
            "Sign up at town.getcore.me",
          ],
        },
      },
      {
        // Phone-booth character changer — bottom-left tile of the booth.
        tx: 11, ty: 8,
        key: "store-character",
        label: "Change character",
        panel: {
          title: "CHANGE CHARACTER",
          accent: PALETTE.h330,
          lines: [
            "20 LimeZu civilians available.",
            "",
            "(character picker —",
            " coming next pass)",
            "",
            "More stations coming soon.",
          ],
        },
      },
    ],
  },
};

// ===========================================================================
// Scene
// ===========================================================================

// Default sprite for the plot-driven NPC slot, picked by the building
// category. plot.npcs[] tells us where the NPC stands; the catalog
// doesn't (yet) ship a sprite per variant, so we route through this map.
const DEFAULT_NPC_SPRITE: Record<BuildingKey, string> = {
  HOME: "home_npc",
  OFFICE: "office_npc",
  LIBRARY: "library_npc",
  STORE: "store_shopkeeper",
};

// Per-category greeting fallback for the unauthenticated demo at `/`. No
// session + no town slug → /api/npcs is 401, so the Npc DB roster is
// empty. We still want the demo to feel populated; openNpcGreeting will
// gate the chat itself behind a "Sign in with CORE" CTA, so these
// fallback strings only appear in the greeting dialogue header — never
// in a real chat round-trip.
const DEMO_NPC_FALLBACK: Record<BuildingKey, { name: string; description: string }> = {
  HOME: {
    name: "World runner",
    description: "Butler of the world. Knows what's on the resident's mind.",
  },
  OFFICE: {
    name: "Coworker",
    description: "Keeps the office humming.",
  },
  LIBRARY: {
    name: "Library keeper",
    description: "Caretaker of the library. Knows what's worth reading next.",
  },
  STORE: {
    name: "Shopkeeper",
    description: "Runs the store. Knows the market and the small talk.",
  },
};

export type InteriorOpts = {
  building: BuildingKey;
  /** PlotBuilding.id of the specific building the player just entered.
   *  Used to look up the plot.npcs slot + Npc DB row for this instance
   *  so two buildings of the same category can host different NPCs. */
  buildingId: string;
};

export function registerInteriorScene(k: KAPLAYCtx) {
  k.scene("interior", (opts: InteriorOpts) => {
    // Custom-plot interior takes over when the building's plotKey starts
    // with "custom:" AND a matching customPlot is in the cached plot.
    // Otherwise fall back to the per-category INTERIORS[] spec.
    const cachedPlot = getCachedPlot();
    const targetBuilding = cachedPlot?.buildings.find(
      (b) => b.id === opts.buildingId,
    );
    const customId = targetBuilding ? customPlotId(targetBuilding.plotKey) : null;
    const customPlot = customId
      ? (cachedPlot?.customPlots ?? []).find((cp) => cp.id === customId) ?? null
      : null;

    const baseSpec: InteriorSpec = customPlot
      ? (() => {
          const ci = customPlot.interior;
          const drawKey = ensureCustomSpriteLoaded(k, ci.sprite);
          const customProps: CustomProp[] = ci.props.map((p) => ({
            tx: p.tx,
            ty: p.ty,
            sprite: ensureCustomSpriteLoaded(k, p.sprite),
          }));
          return {
            draw: drawKey,
            roomW: ci.widthTiles * TILE,
            roomH: ci.heightTiles * TILE,
            walkable: ci.walkable,
            ...(ci.extraWalkable ? { extraWalkable: ci.extraWalkable } : {}),
            ...(ci.blocked ? { blocked: ci.blocked } : {}),
            spawn: ci.spawn,
            exit: ci.exit,
            title: customPlot.label || opts.building,
            customProps,
          };
        })()
      : INTERIORS[opts.building];

    // Plot-driven NPCs for THIS building. plot.npcs[] now ships one
    // entry per variant slot (see @town/catalog `Variant.npcPositions`),
    // so a building can host multiple NPCs at distinct tiles. Each plot
    // entry is matched to a row in the Npc DB table by (buildingId,
    // slotId); chat data lives there.
    //
    // Render rules:
    //   • Owner / visitor — render iff BOTH the plot slot AND a matching
    //     Npc DB row exist. So `town deploy` of an MDX without an entry
    //     for this (buildingId, slotId) removes the sprite + interactable
    //     cleanly, and a chat round-trip can never 404.
    //   • Unauthenticated demo (no session AND no town slug) — the API
    //     is 401 so the DB roster is always empty. To keep the marketing
    //     demo populated, render every plot slot from a per-category
    //     fallback name. openNpcGreeting gates the actual chat behind a
    //     "Sign in with CORE" CTA on this branch, so the fallback id
    //     never reaches /api/npc-chat.
    const plot = cachedPlot;
    const plotNpcs = (plot?.npcs ?? []).filter(
      (n) => n.buildingId === opts.buildingId,
    );
    const isDemoGuest = !getSession() && !getViewerTownSlug();
    const fallback = DEMO_NPC_FALLBACK[opts.building];

    interface Resolved {
      plotNpc: (typeof plotNpcs)[number];
      info: { id: string; name: string; description: string };
    }
    const resolved: Resolved[] = [];
    for (const plotNpc of plotNpcs) {
      const slotId = plotNpc.slotId ?? "";
      const row = getNpcByBuildingAndSlot(opts.buildingId, slotId);
      const isDefaultSlot = slotId === "";
      if (row) {
        resolved.push({
          plotNpc,
          info: {
            id: row.id,
            name: row.name,
            description: row.description,
          },
        });
        continue;
      }
      if (isDemoGuest && isDefaultSlot) {
        resolved.push({
          plotNpc,
          info: {
            id: opts.buildingId,
            name: fallback.name,
            description: fallback.description,
          },
        });
      }
    }

    const dynamicNpcs: Npc[] = resolved.map(({ plotNpc }) => ({
      tx: plotNpc.tx,
      ty: plotNpc.ty,
      sprite: DEFAULT_NPC_SPRITE[opts.building],
    }));
    const dynamicInteracts: Interactable[] = resolved.map(({ plotNpc, info }) => {
      const slotId = plotNpc.slotId ?? "";
      const interactKey = slotId
        ? `npc-${opts.buildingId}-${slotId}`
        : `npc-${opts.buildingId}`;
      return {
        tx: plotNpc.tx,
        ty: plotNpc.ty,
        key: interactKey,
        label: `Talk to ${info.name}`,
        accent: theme.buildings[opts.building].accent,
        onTrigger: () =>
          openNpcGreeting({
            npcId: info.id,
            name: info.name,
            description: info.description,
            accent: theme.buildings[opts.building].accent,
          }),
        onLeave: () => ui.closeDialogue(),
      };
    });

    // Drop owner-only sprites + interacts when a visitor is touring
    // another user's town. System NPCs (Founder) currently use this.
    const ownerView = isViewerOwner();
    // The first building in this interior's category. `primaryInstanceOnly`
    // sprites/interactables (e.g. the system Founder) render only there;
    // every additional building of the same category gets the user's
    // own plot NPCs but skips the singleton system slot.
    const myBuilding = plot?.buildings.find((b) => b.id === opts.buildingId);
    const firstOfCategory = myBuilding
      ? plot?.buildings.find((b) => b.category === myBuilding.category)
      : undefined;
    const isPrimaryInstance =
      !!myBuilding && firstOfCategory?.id === opts.buildingId;
    const ownerNpcs = baseSpec.npcs ?? [];
    const ownerInteracts = baseSpec.interacts ?? [];
    const visibleNpcs = (ownerView
      ? ownerNpcs
      : ownerNpcs.filter((n) => !n.ownerOnly)
    ).filter((n) => isPrimaryInstance || !n.primaryInstanceOnly);
    const visibleInteracts = (ownerView
      ? ownerInteracts
      : ownerInteracts.filter((it) => !it.ownerOnly)
    ).filter((it) => isPrimaryInstance || !it.primaryInstanceOnly);

    const spec = {
      ...baseSpec,
      npcs: [...visibleNpcs, ...dynamicNpcs],
      interacts: [...visibleInteracts, ...dynamicInteracts],
    };

    // Backdrop — single uniform dark color for every interior. We push the
    // same color into kaplay's letterbox so the bars around the view also
    // read as one continuous dark surface, not a pale wallpaper frame.
    k.setBackground(hex(k, theme.interiorBackdrop));
    k.add([
      k.rect(VIEW_W, VIEW_H),
      k.pos(0, 0),
      k.color(hex(k, theme.interiorBackdrop)),
      k.fixed(),
      k.z(-1),
    ]);

    // Interior sprite (or code-composed room).
    if (typeof spec.draw === "string") {
      k.add([
        k.sprite(spec.draw),
        k.pos(0, 0),
        k.z(0),
      ]);
    } else {
      spec.draw(k, spec.roomW, spec.roomH);
    }

    // Props (multi-tile static decor like ATMs / kiosks). Drawn before the
    // player so player z=50 renders over them — same z budget as NPCs.
    for (const prop of spec.props ?? []) {
      k.add([
        k.sprite(prop.sprite),
        // Bottom row of the sprite plants on row `ty`; offset upward by
        // (spritePxH - TILE) so the feet sit on the tile floor.
        k.pos(prop.tx * TILE, (prop.ty + 1) * TILE - prop.spritePxH),
        k.z(45),
      ]);
    }
    // CustomPlot props — top-left anchored single-tile sprites.
    for (const prop of spec.customProps ?? []) {
      k.add([
        k.sprite(prop.sprite),
        k.pos(prop.tx * TILE, prop.ty * TILE),
        k.z(45),
      ]);
    }

    // NPCs (drawn before player so player z=50 renders over them).
    for (const npc of spec.npcs ?? []) {
      const NPC_SPRITE_H = 25;
      k.add([
        k.sprite(npc.sprite),
        k.pos(npc.tx * TILE, npc.ty * TILE + TILE - NPC_SPRITE_H),
        k.z(45),
      ]);
    }

    // Walkability + exit detection. A tile is walkable if it sits inside
    // the main rect OR any of the extra rects (e.g. a jutting porch).
    const rects: Rect[] = [spec.walkable, ...(spec.extraWalkable ?? [])];
    const inAnyRect = (tx: number, ty: number) => {
      for (const r of rects) {
        if (
          tx >= r.tx && ty >= r.ty &&
          tx <= r.tx + r.w - 1 && ty <= r.ty + r.h - 1
        ) {
          return true;
        }
      }
      return false;
    };

    // Block tiles occupied by NPCs and prop footprints so the player can't
    // walk through them.
    const occupied = new Set<string>();
    for (const npc of spec.npcs ?? []) {
      occupied.add(`${npc.tx},${npc.ty}`);
    }
    for (const prop of spec.props ?? []) {
      // tx,ty is the bottom-left tile; footprint extends up by (h-1) rows.
      for (let dx = 0; dx < prop.w; dx++) {
        for (let dy = 0; dy < prop.h; dy++) {
          occupied.add(`${prop.tx + dx},${prop.ty - dy}`);
        }
      }
    }
    // CustomPlot props are 1×1 at their declared tile.
    for (const prop of spec.customProps ?? []) {
      occupied.add(`${prop.tx},${prop.ty}`);
    }
    // Tiles explicitly marked as furniture / interior walls.
    for (const r of spec.blocked ?? []) {
      for (let dx = 0; dx < r.w; dx++) {
        for (let dy = 0; dy < r.h; dy++) {
          occupied.add(`${r.tx + dx},${r.ty + dy}`);
        }
      }
    }

    const isBlocked = (tx: number, ty: number) => {
      if (tx === spec.exit.tx && ty === spec.exit.ty) return false;
      if (!inAnyRect(tx, ty)) return true;
      if (occupied.has(`${tx},${ty}`)) return true;
      return false;
    };

    // Tell realtime we're inside this building. Co-occupants share the
    // same scene id; the overworld filters us out so the owner doesn't
    // see a ghost at the front door from the stale last-overworld tile
    // the heartbeat would otherwise keep re-publishing.
    //
    // Scene id is keyed on the PlotBuilding.id (unique per instance), NOT
    // the category — otherwise two buildings of the same category (e.g.
    // two STOREs) would pool their occupants into one virtual room even
    // though each has its own physical interior on screen.
    const sceneId = `interior:${opts.buildingId}`;
    setLocalScene(sceneId);

    // Per-house group chat. Opt-in via `groupChatEnabled: true` on the
    // building in plot.json — matches the server-side gate in
    // features/group-chat/server/access.ts. Registers the [G]
    // keystroke, publishes "we're in a group-chat-ready house" for the
    // floating prompt, and tears itself down on scene leave so walking
    // back to the overworld auto-closes the overlay.
    const groupChatSlug =
      getViewerTownSlug() ?? getActiveTownSlug() ?? null;
    if (groupChatSlug && myBuilding) {
      mountGroupChatForScene({
        k,
        slug: groupChatSlug,
        buildingId: myBuilding.id,
        buildingLabel: myBuilding.label || spec.title,
        enabled: myBuilding.groupChatEnabled === true,
        sceneId,
      });
    }

    const onArrive = (tile: { tx: number; ty: number }) => {
      if (tile.tx === spec.exit.tx && tile.ty === spec.exit.ty) {
        // Route back to the plot-driven overworld (the new default). The
        // legacy "overworld" scene would render its own procedurally
        // generated layout, which makes the town visibly change on exit.
        // Pass both the category (legacy) and the specific buildingId
        // so the overworld can drop the player at THIS building's door
        // even when multiple buildings share the same category (e.g.
        // two STORE-category buildings).
        k.go("overworld-plot", {
          spawnFrom: opts.building,
          spawnBuildingId: opts.buildingId,
        });
        return;
      }
      // Broadcast the new interior-local tile so any co-occupant sees us
      // move. Without this the heartbeat would only carry the spawn tile.
      publishLocalPosition({ tx: tile.tx, ty: tile.ty, facing: player.facing });
    };

    const player = makePlayer(k, spec.spawn, isBlocked, onArrive);

    // First publish on entry so anyone already inside the same room sees
    // where we spawned. Mirrors the overworld scene's behaviour.
    publishLocalPosition({
      tx: player.tile.tx,
      ty: player.tile.ty,
      facing: player.facing,
    });

    // Spawn / move / despawn co-occupants of THIS interior. Other
    // visitors who are still in the overworld (or in a different
    // building) are filtered out by the scene id.
    const detachRemotes = attachRemotePlayers(k, { scene: sceneId });

    // Camera.
    const halfW = VIEW_W / 2;
    const halfH = VIEW_H / 2;
    if (spec.roomW <= VIEW_W && spec.roomH <= VIEW_H) {
      k.setCamPos(spec.roomW / 2, spec.roomH / 2);
    } else {
      k.onUpdate(() => {
        const tx = player.pos.x + TILE / 2;
        const ty = player.pos.y + TILE / 2;
        const cx = Math.max(halfW, Math.min(spec.roomW - halfW, tx));
        const cy = Math.max(halfH, Math.min(spec.roomH - halfH, ty));
        k.setCamPos(cx, cy);
      });
    }

    // --------- Interaction prompt + SPACE handler ---------
    // All UI surfaces (prompt, panel, HUD, login modal) live in React. Kaplay
    // publishes intent to `ui` (the bridge store) and React subscribes via
    // useSyncExternalStore in the components.
    const accentFor = (it: Interactable): string => {
      if (it.accent) return it.accent;
      if (it.panel) {
        const panel = typeof it.panel === "function" ? it.panel(() => {}) : it.panel;
        return panel.accent ?? PALETTE.h240;
      }
      return PALETTE.h240;
    };

    // The proximity check runs 60Hz inside the onUpdate below, but its
    // result is purely a function of the player's current tile — same
    // tile => same interactable. Memoize by "tx,ty" so the linear scan
    // only fires when the player actually walks onto a new tile.
    let cachedTileKey: string | null = null;
    let cachedResult: Interactable | null = null;

    const nearestInteract = (): Interactable | null => {
      const pt = player.tile;
      const tileKey = pt.tx + "," + pt.ty;
      if (tileKey === cachedTileKey) return cachedResult;

      // Panel interactables (scratchpad, phone booth, price machine, …)
      // keep strict cardinal adjacency — the prompt should only appear
      // when the player is literally standing next to the furniture.
      //
      // NPC interactables (marked by `onLeave`) accept up to Manhattan 2
      // so a plot NPC that sits behind a prop (e.g. the office worker in
      // the workstation chair at cols 7-8, rows 2-5) still triggers even
      // when the workstation footprint pushes the player one tile south
      // of the strict-adjacent tile. Multiple NPCs in range → the
      // closest one wins.
      let npcCandidate: Interactable | null = null;
      let npcBestDist = Infinity;
      let result: Interactable | null = null;
      for (const it of spec.interacts ?? []) {
        const dx = Math.abs(pt.tx - it.tx);
        const dy = Math.abs(pt.ty - it.ty);
        const dist = dx + dy;
        if (it.onLeave) {
          if (dist >= 1 && dist <= 2 && dist < npcBestDist) {
            npcCandidate = it;
            npcBestDist = dist;
          }
          continue;
        }
        if (dist === 1) {
          result = it;
          break;
        }
      }
      cachedTileKey = tileKey;
      cachedResult = result ?? npcCandidate;
      return cachedResult;
    };

    const resolveLabel = (it: Interactable): string =>
      typeof it.label === "function" ? it.label() : it.label;

    // Publish a panel (resolving the factory if needed). Captures `it` so the
    // action's `republish` callback re-runs the factory and pushes the new
    // state — used by HOME Profile to flip guest <-> signed-in content.
    const publishPanel = (it: Interactable) => {
      if (!it.panel) return;
      const republish = () => publishPanel(it);
      const panel = typeof it.panel === "function" ? it.panel(republish) : it.panel;
      ui.openPanel({
        key: it.key,
        title: panel.title,
        lines: panel.lines,
        accent: panel.accent ?? PALETTE.h240,
        action: panel.action,
      });
    };

    // Tracks the key of the interactable whose `onTrigger` fired most
    // recently while the player is still adjacent. When the player walks
    // away (or the scene ends) we run the matching `onLeave` so ambient
    // dialogues opened by NPCs close themselves.
    let activeLeaveKey: string | null = null;

    const findInteractByKey = (key: string): Interactable | undefined =>
      (spec.interacts ?? []).find((x) => x.key === key);

    const fireLeave = () => {
      if (!activeLeaveKey) return;
      const prev = findInteractByKey(activeLeaveKey);
      prev?.onLeave?.();
      activeLeaveKey = null;
    };

    k.onUpdate(() => {
      // Modal-style surfaces (panel, explorer, chat) freeze the
      // world entirely — skip prompt logic while one is open. We
      // intentionally do NOT clear `activeLeaveKey` here so a chat that
      // opens from the NPC dialogue's action button keeps the walk-away
      // cleanup wired up.
      if (ui.isPaused()) {
        ui.setPrompt(null);
        return;
      }
      const it = nearestInteract();

      // Departure detection: we previously fired an interactable's
      // `onTrigger` but the player isn't standing next to it anymore
      // (or is next to a *different* one). Run the outgoing onLeave.
      if (activeLeaveKey && (!it || it.key !== activeLeaveKey)) {
        fireLeave();
      }

      if (!it) {
        ui.setPrompt(null);
        return;
      }

      // NPC interactables (marked by having `onLeave`) auto-open their
      // dialogue on proximity — walking up IS the trigger, no SPACE
      // press required for the greeting. SPACE inside the dialogue
      // still fires the primary action (opens the chat). The floating
      // SPACE pill is suppressed entirely: the dialogue is a better
      // affordance and doubling both looked noisy.
      if (it.onLeave) {
        ui.setPrompt(null);
        // Group-chat overlay wins — don't stack a 1-1 dialogue on top
        // of an open room. Same gate the SPACE handler uses so UX is
        // symmetric: no auto-open, no manual trigger either.
        if (isGroupChatOverlayOpen()) return;
        // Already open for this NPC. Nothing to do.
        if (activeLeaveKey === it.key) return;
        if (it.onTrigger) {
          activeLeaveKey = it.key;
          it.onTrigger();
        }
        return;
      }

      ui.setPrompt({ label: resolveLabel(it), accent: accentFor(it) });
    });

    k.onKeyPress("space", () => {
      // React owns SPACE while a modal is open (it fires the action button).
      // The ambient NPC dialogue is *not* modal — it listens to SPACE itself
      // at window level so the player can advance / fast-forward / fire the
      // action even while standing next to the NPC.
      if (ui.isPaused()) return;
      const it = nearestInteract();
      if (!it) return;

      // If a dialogue is already on screen (the NPC greeting we opened
      // last press, or the guest CTA), let its window-level listener
      // advance it. Don't re-open the greeting on top of itself.
      if (it.onLeave && ui.getState().dialogue) return;

      // Block NPC interactions while the group-chat overlay is open —
      // the player has to close the room first (ESC or G). Same gate
      // as the prompt suppression above so the UX is symmetric: no
      // prompt, no trigger. Non-NPC interactables (panels) still fire.
      if (it.onLeave && isGroupChatOverlayOpen()) return;

      if (it.onTrigger) {
        if (it.onLeave) activeLeaveKey = it.key;
        it.onTrigger();
        return;
      }
      publishPanel(it);
    });

    // Publish the room HUD; React renders the card.
    ui.setHud({
      kind: "interior",
      title: spec.title,
      accent: theme.buildings[opts.building].accent,
    });

    // The "shared preview" sign-in CTA is for truly anonymous viewers on
    // the public demo town. Guests touring a real town (have a townSlug
    // from a validated visit cookie) skip it — they're already in
    // someone's world and the CTA's "shared preview" copy doesn't apply.
    if (!getSession() && !getViewerTownSlug()) {
      openGuestCta();
    }

    // Clean up published UI state when leaving the scene so the overworld
    // doesn't inherit a stale interior prompt or HUD.
    k.onSceneLeave(() => {
      // Fire onLeave for any active NPC interactable before we clear UI
      // so the NPC's owner can run any teardown (analytics, conversation
      // cleanup) before the dialogue is yanked.
      fireLeave();
      detachRemotes();
      ui.setPrompt(null);
      ui.closePanel();
      ui.closeExplorer();
      // Preserve the guest CTA across scene transitions — it's the one
      // persistent surface guests see and is reopened on every entry.
      if (ui.getState().dialogue?.key !== GUEST_CTA_KEY) {
        ui.closeDialogue();
      }
      ui.closeChat();
    });
  });
}
