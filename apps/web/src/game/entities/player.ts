import type { KAPLAYCtx, GameObj } from "kaplay";
import { TILE, MOVE_TIME, INK, type Facing, hex } from "../config";
import { getPlayerCharacter } from "../character";
import { ui } from "../../ui/store";
import { publishLocalPosition } from "../realtime";

// How long the player can stand still (and have no modal open) before
// their avatar drops into the sleeping pose — Zzz tag above the head,
// faded sprite, half-speed breath bob. Anything that pauses the world
// (chat, dm, dialogue, panels) counts as activity, so they don't fall
// asleep mid-conversation.
const IDLE_THRESHOLD_MS = 60_000;

export type Tile = { tx: number; ty: number };

// The player is a parent transform anchored at its current tile's top-left.
// The sprite is taller than the tile (head extends above), so we draw it
// shifted up by (spriteH - TILE) px to plant the feet on the tile bottom.
export type Player = GameObj & {
  tile: Tile;
  facing: Facing;
};

// Postman crop height — the cropped frame is 16w x 25h, with the head
// occupying the top 9px above the tile floor.
const PLAYER_SPRITE_H = 25;

const DIRS: Record<string, { dx: number; dy: number; facing: Facing }> = {
  left:  { dx: -1, dy: 0,  facing: "left" },
  right: { dx: 1,  dy: 0,  facing: "right" },
  up:    { dx: 0,  dy: -1, facing: "up" },
  down:  { dx: 0,  dy: 1,  facing: "down" },
};

export function makePlayer(
  k: KAPLAYCtx,
  startTile: Tile,
  isBlocked: (tx: number, ty: number) => boolean,
  onArrive?: (tile: Tile) => void,
): Player {
  // The parent's pos is the tile's top-left in world pixels. Player z is
  // chosen so they render above ground and below building roofs but above
  // building bases (handled per-building in the scene).
  const parent = k.add([
    k.pos(startTile.tx * TILE, startTile.ty * TILE),
    k.z(50),
  ]) as unknown as Player;

  parent.tile = { ...startTile };
  parent.facing = "down";

  // Sprite child — offset up so feet sit on the tile bottom. We hold a
  // reference so the idle + walk animations can nudge its local position.
  // Sprite key comes from game/character.ts so visitors render as a
  // different avatar than the owner.
  const spriteBaselineY = TILE - PLAYER_SPRITE_H;
  const sprite = parent.add([
    k.sprite(getPlayerCharacter()),
    k.pos(0, spriteBaselineY),
    // Opacity component so the sleep state can fade the sprite.
    k.opacity(1),
    k.z(50),
  ]);

  let moving = false;

  // Step counter — flips sign on every move so successive footsteps
  // alternate the sway direction (left foot vs right foot lean).
  let stepParity = 1;

  // Activity timer driving the sleeping state. Updated by every move
  // and by every frame any modal is open; falling below threshold
  // marks the player as awake again. performance.now() so the deltas
  // line up with realtime.ts's lastSeen.
  let lastActivityAt = performance.now();
  let sleeping = false;

  // Zzz badge over the sprite — sits above the head, hidden until the
  // player has been still long enough to trigger the sleep state.
  const zzz = parent.add([
    k.text("z z z", { size: 6 }),
    k.anchor("center"),
    // 6 px above the sprite's top edge.
    k.pos(TILE / 2, spriteBaselineY - 6),
    k.color(hex(k, INK)),
    k.opacity(0),
    k.z(52),
  ]);

  // Idle "breath" — visible vertical sine bob + a subtle horizontal sway
  // so the character reads as breathing, not frozen pixel art. Bob
  // slows and the sprite fades when the sleep timer trips.
  k.onUpdate(() => {
    // Any open modal counts as the player "doing something" — pin the
    // activity timer to now so they don't fall asleep mid-conversation.
    if (ui.isPaused()) lastActivityAt = performance.now();

    if (!moving) {
      const t = k.time();
      const idleFor = performance.now() - lastActivityAt;
      const nowSleeping = idleFor > IDLE_THRESHOLD_MS;
      if (nowSleeping !== sleeping) {
        sleeping = nowSleeping;
        sprite.opacity = sleeping ? 0.55 : 1;
        zzz.opacity = sleeping ? 0.9 : 0;
        // Broadcast the new state so visitors see the same animation.
        publishLocalPosition({
          tx: parent.tile.tx,
          ty: parent.tile.ty,
          facing: parent.facing,
          idle: sleeping,
        });
      }
      const bobHz = sleeping ? 1.2 : 3.2;
      const bobAmp = sleeping ? 0.6 : 1.2;
      sprite.pos.y = spriteBaselineY + Math.sin(t * bobHz) * bobAmp;
      sprite.pos.x = Math.sin(t * 1.6) * (sleeping ? 0.2 : 0.4);
      // Tiny bobbing on the Zzz so it doesn't feel pasted on.
      if (sleeping) zzz.pos.y = spriteBaselineY - 6 + Math.sin(t * 1.2) * 0.6;
    }
  });

  const tryMove = (dirKey: keyof typeof DIRS) => {
    if (moving) return;
    // Freeze the world while any React modal is open so input destined for
    // the form/panel doesn't also walk the player.
    if (ui.isPaused()) return;
    const { dx, dy, facing } = DIRS[dirKey];
    parent.facing = facing;

    const nx = parent.tile.tx + dx;
    const ny = parent.tile.ty + dy;
    if (isBlocked(nx, ny)) return;

    // Any successful move wakes the player. The bob-Hz flip on next
    // frame undoes the sleeping pose; broadcast straight away so
    // visitors don't see a stale Zzz on a walking sprite.
    lastActivityAt = performance.now();
    if (sleeping) {
      sleeping = false;
      sprite.opacity = 1;
      zzz.opacity = 0;
      publishLocalPosition({
        tx: parent.tile.tx,
        ty: parent.tile.ty,
        facing,
        idle: false,
      });
    }

    moving = true;
    const fromX = parent.pos.x;
    const fromY = parent.pos.y;
    const toX = nx * TILE;
    const toY = ny * TILE;

    // Flip the step parity so this footstep leans opposite the last one.
    const parity = stepParity;
    stepParity = -stepParity;

    k.tween(
      0, 1, MOVE_TIME,
      (t) => {
        // Snap to integer pixels every frame so the rendered position
        // doesn't toggle between fractional floors and stutter.
        parent.pos = k.vec2(
          Math.round(fromX + (toX - fromX) * t),
          Math.round(fromY + (toY - fromY) * t),
        );
        // No per-step bob — at MOVE_TIME=120ms any vertical oscillation
        // on a horizontal slide reads as a glitch rather than a stride.
        // The parent's smooth slide alone carries the motion cue.
        sprite.pos.y = spriteBaselineY;
        sprite.pos.x = 0;
        void parity; // kept for future per-step variation
      },
      k.easings.linear,
    ).onEnd(() => {
      parent.tile = { tx: nx, ty: ny };
      moving = false;
      // Land back on the baseline so the idle-bob picks up cleanly from 0.
      sprite.pos.y = spriteBaselineY;
      sprite.pos.x = 0;
      onArrive?.(parent.tile);
    });
  };

  k.onKeyPress("left",  () => tryMove("left"));
  k.onKeyPress("right", () => tryMove("right"));
  k.onKeyPress("up",    () => tryMove("up"));
  k.onKeyPress("down",  () => tryMove("down"));

  k.onKeyDown("left",  () => tryMove("left"));
  k.onKeyDown("right", () => tryMove("right"));
  k.onKeyDown("up",    () => tryMove("up"));
  k.onKeyDown("down",  () => tryMove("down"));

  return parent;
}
