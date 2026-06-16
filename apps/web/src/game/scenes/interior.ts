import type { KAPLAYCtx } from "kaplay";
import { TILE, VIEW_W, VIEW_H, INK, CREAM, PALETTE, hex } from "../config";
import { theme, type BuildingKey } from "../theme";
import { makePlayer } from "../entities/player";
import { attachRemotePlayers } from "../entities/remotePlayer";
import { getSession, logout, startLogin } from "../auth";
import { GUEST_CTA_KEY, openGuestCta } from "../guestCta";
import { getWorkspace } from "../workspace";
import { publishLocalPosition, setLocalScene } from "../realtime";
import { ui } from "../../ui/store";
import { getViewerTownSlug, isViewerOwner } from "../plotClient";

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
  label: string;        // shown in floating prompt e.g. "[SPACE] Scratchpad"
  // Stable identifier for the React panel so re-publishing the same
  // interactable's panel doesn't unmount/remount.
  key: string;
  // When true, the interactable is only mounted for the town's owner
  // (visitors viewing someone else's town won't see / trigger it).
  // Used for system-owned NPCs like the Founder.
  ownerOnly?: boolean;
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
  // open a larger overlay (e.g. the memory Explorer) without making the
  // user press SPACE twice (once for the Panel, once for its action).
  onTrigger?: () => void;
  // Proximity-dwell auto-trigger. Player stands adjacent for `dwellMs`
  // (default 800ms); `onEnter` fires once. Walking away (or scene leave)
  // fires `onLeave`. Used for ambient NPC interactions where the player
  // shouldn't have to press SPACE. We suppress the floating prompt for
  // these — the overlay itself is the cue. SPACE still works as a
  // shortcut: pressing it skips the dwell and fires `onEnter` immediately.
  autoTrigger?: {
    dwellMs?: number;
    onEnter: () => void;
    onLeave?: () => void;
  };
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
};

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

// HOME world runner — branches on auth + unread inbox count, opens a typewriter
// dialogue with the appropriate greeting, and routes the action button to
// sign-in / inbox catchup / chat. Stays a single interactable on the NPC's
// tile so the prompt is "Talk to {name}" wherever the player approaches from.
//
// Name + accent come from the user's CORE workspace (workspace.name and
// workspace.accentColor). Before the workspace cache is hydrated — or for
// guests who aren't signed in yet — we fall back to a generic "World runner"
// label and the HOME palette accent.
const HOME_NPC_FALLBACK_NAME = "World runner";
const HOME_NPC_FALLBACK_ACCENT = theme.buildings.HOME.accent;

function homeNpcName(): string {
  return getWorkspace()?.name?.trim() || HOME_NPC_FALLBACK_NAME;
}

function homeNpcAccent(): string {
  return getWorkspace()?.accentColor || HOME_NPC_FALLBACK_ACCENT;
}

function openHomeNpcDialogue() {
  const session = getSession();
  // Guest path: no session but a validated visit cookie (we know
  // because the viewer has a town slug). The home NPC greets them as a
  // guest and routes straight into chat — memory_search is scoped to
  // the resident's memory server-side, so they can actually learn
  // about whoever lives here through the NPC.
  if (!session && getViewerTownSlug()) {
    ui.openDialogue({
      key: "home-npc-guest",
      speaker: homeNpcName(),
      accent: homeNpcAccent(),
      lines: [
        `Hi, I'm ${homeNpcName()}.`,
        "I run things around here for the resident. Want to chat?",
      ],
      action: {
        label: "Let's talk",
        onPress: () => openHomeChat(),
      },
      secondary: {
        label: "Not now",
        onPress: () => ui.closeDialogue(),
      },
    });
    return;
  }
  if (!session) {
    ui.openDialogue({
      key: "home-npc-unsigned",
      speaker: homeNpcName(),
      accent: homeNpcAccent(),
      lines: [
        "Hold on, traveler — I don't recognize you.",
        "This world only remembers folks who've signed the ledger.",
        "Want to sign in with CORE?",
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

  const inbox = ui.getState().inbox;
  const name = session.user.name;
  const accent = homeNpcAccent();

  if (inbox.count > 0) {
    const noun = inbox.count === 1 ? "update" : "updates";
    ui.openDialogue({
      key: `home-npc-unread-${inbox.count}`,
      speaker: homeNpcName(),
      accent,
      lines: [
        `Welcome back, ${name}.`,
        `I've got ${inbox.count} ${noun} for you. Want to catch up?`,
      ],
      action: {
        label: "Catch me up",
        onPress: () => catchUpHomeNpc(name),
      },
      secondary: {
        label: "Later",
        onPress: () => ui.closeDialogue(),
      },
    });
    return;
  }

  ui.openDialogue({
    key: "home-npc-signed-empty",
    speaker: homeNpcName(),
    accent,
    lines: [`Welcome back, ${name}. Anything on your mind?`],
    action: {
      label: "Let's talk",
      onPress: () => openHomeChat(),
    },
    secondary: {
      label: "Not now",
      onPress: () => ui.closeDialogue(),
    },
  });
}

async function catchUpHomeNpc(name: string) {
  // Swap the dialogue to a loading state so SPACE/click can't double-fire
  // while the summariser runs. The summarise route stamps the rows checked
  // server-side, so the next poll lands on count=0 and the badge clears.
  ui.openDialogue({
    key: "home-npc-summarising",
    speaker: homeNpcName(),
    accent: homeNpcAccent(),
    lines: ["Hold on — let me pull those up for you…"],
  });
  try {
    const res = await fetch("/api/core/inbox/summarise", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "voice" }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { summary?: string };
    const summary = (body.summary ?? "").trim();
    // Manually clear the badge — the 20s poller will confirm shortly.
    ui.setInbox({ count: 0, fetchedAt: new Date().toISOString() });
    ui.openDialogue({
      key: "home-npc-summary",
      speaker: homeNpcName(),
      accent: homeNpcAccent(),
      lines: summary
        ? ["Here's the catchup:", summary, "Anything you want to dig into?"]
        : ["Nothing urgent in there. Want to chat about something else?"],
      action: {
        label: "Let's talk",
        onPress: () => openHomeChat(),
      },
      secondary: {
        label: "Done",
        onPress: () => ui.closeDialogue(),
      },
    });
  } catch (_e) {
    ui.openDialogue({
      key: "home-npc-summary-err",
      speaker: homeNpcName(),
      accent: homeNpcAccent(),
      lines: [
        "Hmm — couldn't reach the office for the catchup.",
        `Try again in a moment, ${name}.`,
      ],
      action: {
        label: "OK",
        onPress: () => ui.closeDialogue(),
      },
    });
  }
}

function openHomeChat() {
  // npcId="home" → /api/npc-chat falls through to a buildingId lookup so
  // we don't need to round-trip /api/npcs first. The speaker label uses
  // the workspace name (or fallback), so the chat header reads as the
  // user's own world runner.
  ui.openChat({
    npcId: "home",
    speaker: homeNpcName(),
    description:
      "Your butler and world runner. Knows what's on your mind.",
    accent: homeNpcAccent(),
    mode: "direct",
  });
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
    npcs: [
      // House occupant — stands on open parquet south-east of the dining
      // table. Off the rug and clear of the motorcycle so the player can
      // walk freely.
      { tx: 8, ty: 5, sprite: "home_npc" },
    ],
    interacts: [
      {
        // World runner — same tile as the home NPC sprite. Auto-triggers
        // after a 1s dwell so the player just walks up and the dialogue
        // starts; walking away closes it. SPACE also works as an impatient
        // shortcut. Name + accent come from CORE's workspace at dialogue
        // time (see openHomeNpcDialogue), so no static label is needed.
        tx: 8, ty: 5,
        key: "home-npc",
        label: "",
        accent: theme.buildings.HOME.accent,
        autoTrigger: {
          dwellMs: 200,
          onEnter: () => openHomeNpcDialogue(),
          onLeave: () => ui.closeDialogue(),
        },
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
        label: "Sign in",
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
    //   • Dual-monitor workstation (cols 7-8, feet row 5) — Tasks board.
    //     Player approaches from (7, 6) below and presses SPACE.
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
    // Middle workstation uses the dual-monitor variant — it's the most
    // prominent of the three so it reads as the Tasks board. Two plants
    // fill the gaps between workstations.
    npcs: [
      // Office worker NPC drawn over the leftmost workstation's chair
      // tile so they appear seated (entities render at z=45, above props).
      { tx: 3, ty: 5, sprite: "office_npc" },
    ],
    props: [
      // ---- Workstations (composed sprite, chair feet on row 5) ----
      { tx: 2,  ty: 5, w: 2, h: 4, sprite: "office_workstation",      spritePxH: 64 },
      { tx: 7,  ty: 5, w: 2, h: 4, sprite: "office_workstation_dual", spritePxH: 64 },
      { tx: 12, ty: 5, w: 2, h: 4, sprite: "office_workstation",      spritePxH: 64 },
      // ---- Plants on the back wall between workstations ----
      { tx: 5,  ty: 4, w: 2, h: 3, sprite: "office_plant_tall",       spritePxH: 48 },
      { tx: 10, ty: 4, w: 2, h: 3, sprite: "office_plant_snake",      spritePxH: 48 },
    ],
    interacts: [
      {
        // Tasks board on the middle (dual-monitor) workstation. Player
        // approaches from south at (7, 6) and presses SPACE. The
        // workstation footprint covers cols 7-8 rows 2-5, but the
        // chair tile itself (7, 5) is what we tag for interaction.
        // Direct trigger — opens the tasks overlay immediately.
        tx: 7, ty: 5,
        key: "office-tasks",
        label: "Tasks",
        accent: PALETTE.h240,
        onTrigger: () => ui.openTasks(),
      },
    ],
  },
  LIBRARY: {
    draw: drawLibrary,
    roomW: TILE * 16, roomH: TILE * 12,
    walkable: { tx: 1, ty: 3, w: 14, h: 8 },
    spawn: { tx: 7, ty: 10 },
    exit:  { tx: 7, ty: 11 },
    title: "LIBRARY",
    npcs: [
      // Reader at an open floor tile between the bookshelves on the west and
      // the rightmost reading table — out of the way of the table interacts.
      { tx: 2, ty: 5, sprite: "library_npc" },
    ],
    interacts: [
      // Library keeper — same tile as the library_npc sprite. Auto-fires
      // on approach: greets the player and offers a streaming chat.
      {
        tx: 2, ty: 5,
        key: "library-npc",
        label: "",
        accent: theme.buildings.LIBRARY.accent,
        autoTrigger: {
          dwellMs: 200,
          onEnter: () =>
            openNpcGreeting({
              npcId: "library",
              name: "Library keeper",
              description: "Caretaker of the library. Knows what's worth reading next.",
              accent: theme.buildings.LIBRARY.accent,
            }),
          onLeave: () => ui.closeDialogue(),
        },
      },
    ],
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
    npcs: [
      // Creator stands centered on the floor — close enough to greet but
      // not blocking either prop. System NPC, owner-only: visitors
      // touring someone else's town don't see the Founder.
      { tx: 7, ty: 5, sprite: "founder", ownerOnly: true },
      // Shopkeeper stands by the back wall, north-west of the founder, so
      // the floor still feels populated when the player enters.
      { tx: 5, ty: 3, sprite: "store_shopkeeper" },
    ],
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
        tx: 7, ty: 5,
        key: "store-founder",
        label: "",
        accent: theme.buildings.STORE.accent,
        ownerOnly: true,
        autoTrigger: {
          dwellMs: 200,
          onEnter: () =>
            openNpcGreeting({
              npcId: "core-founder",
              name: "Founder",
              description:
                "Hangs out at the store. Tracks the CORE roadmap — knows what's coming.",
              accent: theme.buildings.STORE.accent,
              chatApi: "/api/founder-chat",
            }),
          onLeave: () => ui.closeDialogue(),
        },
      },
      // Shopkeeper — user-owned NPC at the back wall. Sprite placement
      // already in spec.npcs above (tx: 5, ty: 3).
      {
        tx: 5, ty: 3,
        key: "store-shopkeeper",
        label: "",
        accent: theme.buildings.STORE.accent,
        autoTrigger: {
          dwellMs: 200,
          onEnter: () =>
            openNpcGreeting({
              npcId: "store",
              name: "Shopkeeper",
              description: "Runs the store. Knows the market and the small talk.",
              accent: theme.buildings.STORE.accent,
            }),
          onLeave: () => ui.closeDialogue(),
        },
      },
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

export type InteriorOpts = {
  building: BuildingKey;
};

export function registerInteriorScene(k: KAPLAYCtx) {
  k.scene("interior", (opts: InteriorOpts) => {
    const baseSpec = INTERIORS[opts.building];
    // Drop owner-only sprites + interacts when a visitor is touring
    // another user's town. System NPCs (Founder) currently use this.
    const ownerView = isViewerOwner();
    const spec = ownerView
      ? baseSpec
      : {
          ...baseSpec,
          npcs: (baseSpec.npcs ?? []).filter((n) => !n.ownerOnly),
          interacts: (baseSpec.interacts ?? []).filter((it) => !it.ownerOnly),
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
    const sceneId = `interior:${opts.building}`;
    setLocalScene(sceneId);

    const onArrive = (tile: { tx: number; ty: number }) => {
      if (tile.tx === spec.exit.tx && tile.ty === spec.exit.ty) {
        // Route back to the plot-driven overworld (the new default). The
        // legacy "overworld" scene would render its own procedurally
        // generated layout, which makes the town visibly change on exit.
        k.go("overworld-plot", { spawnFrom: opts.building });
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

    const nearestInteract = (): Interactable | null => {
      const pt = player.tile;
      // Pass 1 — strict cardinal adjacency. Wins for any interactable
      // (prompt-style SPACE interacts AND autoTriggers) so standing
      // directly beside an NPC always counts.
      for (const it of spec.interacts ?? []) {
        const dx = Math.abs(pt.tx - it.tx);
        const dy = Math.abs(pt.ty - it.ty);
        if (dx + dy === 1) return it;
      }
      // Pass 2 — wider proximity (dx+dy ≤ 2), autoTriggers only. Lets the
      // "Hi, I'm …" greeting fire as the player walks NEAR the NPC instead
      // of requiring them to land exactly one tile away. Prompt-style
      // interacts keep the tighter rule so we don't pop SPACE labels from
      // across the room.
      for (const it of spec.interacts ?? []) {
        if (!it.autoTrigger) continue;
        const dx = Math.abs(pt.tx - it.tx);
        const dy = Math.abs(pt.ty - it.ty);
        if (dx + dy <= 2) return it;
      }
      return null;
    };

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

    // Proximity-dwell tracker for autoTrigger interactables. We retain the
    // *key* of the interactable we're currently adjacent to, the moment the
    // player first arrived next to it, and whether the trigger has fired.
    // When the player walks away (or the scene ends) we run the matching
    // `onLeave` so the overlay can clean up.
    let autoState: {
      key: string;
      arrivedAt: number;
      fired: boolean;
    } | null = null;

    const findInteractByKey = (key: string): Interactable | undefined =>
      (spec.interacts ?? []).find((x) => x.key === key);

    const fireAutoLeave = () => {
      if (!autoState?.fired) return;
      const prev = findInteractByKey(autoState.key);
      prev?.autoTrigger?.onLeave?.();
    };

    k.onUpdate(() => {
      // Modal-style surfaces (panel, explorer, tasks, chat) freeze the
      // world entirely — skip prompt + dwell logic while one is open.
      // We intentionally do NOT clear `autoState` here so the dwell timer
      // state survives e.g. a chat that opens from the dialogue's action.
      if (ui.isPaused()) {
        ui.setPrompt(null);
        return;
      }
      const it = nearestInteract();

      // Departure detection: we were adjacent to an autoTrigger but aren't
      // anymore (or we're next to a *different* interactable). Run the
      // outgoing onLeave and clear state.
      if (autoState && (!it || it.key !== autoState.key)) {
        fireAutoLeave();
        autoState = null;
      }

      if (!it) {
        ui.setPrompt(null);
        return;
      }

      if (it.autoTrigger) {
        // No prompt — the dialogue overlay itself is the cue.
        ui.setPrompt(null);
        if (!autoState || autoState.key !== it.key) {
          // First frame adjacent — start dwell timer.
          autoState = {
            key: it.key,
            arrivedAt: performance.now(),
            fired: false,
          };
          return;
        }
        if (
          !autoState.fired &&
          performance.now() - autoState.arrivedAt >=
            (it.autoTrigger.dwellMs ?? 800)
        ) {
          autoState.fired = true;
          it.autoTrigger.onEnter();
        }
        return;
      }

      ui.setPrompt({ label: it.label, accent: accentFor(it) });
    });

    k.onKeyPress("space", () => {
      // React owns SPACE while a modal is open (it fires the action button).
      // The ambient dialogue is *not* modal — it listens to SPACE itself at
      // window level so the player can advance / fast-forward / fire the
      // action even while standing next to the NPC.
      if (ui.isPaused()) return;
      const it = nearestInteract();
      if (!it) return;

      // For autoTrigger items, SPACE is an impatient shortcut — skip the
      // dwell and fire immediately. If the trigger has already fired the
      // window-level dialogue listener owns SPACE from here.
      if (it.autoTrigger) {
        if (!autoState || autoState.key !== it.key) {
          autoState = { key: it.key, arrivedAt: 0, fired: true };
        } else if (!autoState.fired) {
          autoState.fired = true;
        } else {
          return;
        }
        it.autoTrigger.onEnter();
        return;
      }

      if (it.onTrigger) {
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
      // Fire onLeave for an in-flight autoTrigger before we clear UI so
      // the NPC's owner can run any teardown (analytics, conversation
      // cleanup) before the dialogue is yanked.
      fireAutoLeave();
      autoState = null;
      detachRemotes();
      ui.setPrompt(null);
      ui.closePanel();
      ui.closeExplorer();
      ui.closeTasks();
      // Preserve the guest CTA across scene transitions — it's the one
      // persistent surface guests see and is reopened on every entry.
      if (ui.getState().dialogue?.key !== GUEST_CTA_KEY) {
        ui.closeDialogue();
      }
      ui.closeChat();
    });
  });
}
