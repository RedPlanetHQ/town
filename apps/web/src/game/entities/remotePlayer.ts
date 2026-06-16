// Renders a non-local player inside the overworld scene.
//
// Labels (name + "reply" pill) are NOT drawn here — they're React-rendered
// in <RemoteCards/> on top of the canvas so we can use the design-system
// colours and crisp HTML text. This module is responsible only for the
// kaplay sprite + tile tween.

import type { GameObj, KAPLAYCtx, TweenController } from "kaplay";

import { TILE, MOVE_TIME, INK, hex } from "../config";
import {
  getRemotePlayersForScene,
  onRemotesChange,
  type RemotePlayer,
} from "../realtime";

const REMOTE_SPRITE_H = 25; // every avatar sprite is 16x25
// Match the local player's MOVE_TIME so a remote that's walking at the
// same cadence as us looks smooth. With a longer tween, back-to-back
// tile updates from the realtime channel started overlapping and the
// sprite jittered as each in-flight tween fought to set parent.pos.
const TWEEN_S = MOVE_TIME;

type RemoteGameObj = GameObj & {
  rTile: { tx: number; ty: number };
  // Tagged onto the parent so React-side surfaces (RemoteCards) can
  // enumerate via kaplay's get("remote-player") and read identity off
  // each object without a separate lookup.
  participantKey: string;
  displayName: string;
};

type ActiveRemote = {
  parent: RemoteGameObj;
  sprite: GameObj;
  // Hidden by default. Faded in (opacity 0.9) when the remote sends
  // idle=true so visitors can see who's stepped away from the keyboard.
  zzz: GameObj;
  currentCharacter: string;
  // Currently running position tween; cancelled before starting a new
  // one so two tweens never simultaneously mutate parent.pos.
  activeTween: TweenController | null;
};

export type AttachRemotePlayersOptions = {
  // Scene id used to filter the global remote-player list down to the
  // ones standing in the same scene as the local viewer. The overworld
  // passes `"overworld"`; each interior passes
  // `"interior:<BuildingKey>"`. Without this filter the overworld would
  // render a visitor who's inside a building at the door tile (the
  // heartbeat re-publishes the last known overworld position).
  scene: string;
  onPositionsChanged?: () => void;
};

export function attachRemotePlayers(
  k: KAPLAYCtx,
  opts: AttachRemotePlayersOptions,
): () => void {
  const active = new Map<string, ActiveRemote>();

  function spawn(player: RemotePlayer): ActiveRemote {
    const parent = k.add([
      k.pos(player.tx * TILE, player.ty * TILE),
      k.z(50),
      "remote-player",
    ]) as unknown as RemoteGameObj;
    parent.rTile = { tx: player.tx, ty: player.ty };
    parent.participantKey = player.participantKey;
    parent.displayName = player.name;

    const spriteBaselineY = TILE - REMOTE_SPRITE_H;
    const sprite = parent.add([
      k.sprite(player.character),
      k.pos(0, spriteBaselineY),
      k.opacity(player.idle ? 0.55 : 1),
      k.z(50),
    ]);
    const zzz = parent.add([
      k.text("z z z", { size: 6 }),
      k.anchor("center"),
      k.pos(TILE / 2, spriteBaselineY - 6),
      k.color(hex(k, INK)),
      k.opacity(player.idle ? 0.9 : 0),
      k.z(52),
    ]);

    return {
      parent,
      sprite,
      zzz,
      currentCharacter: player.character,
      activeTween: null,
    };
  }

  function update(entry: ActiveRemote, player: RemotePlayer) {
    if (entry.currentCharacter !== player.character) {
      entry.sprite.destroy();
      const spriteBaselineY = TILE - REMOTE_SPRITE_H;
      entry.sprite = entry.parent.add([
        k.sprite(player.character),
        k.pos(0, spriteBaselineY),
        k.opacity(player.idle ? 0.55 : 1),
        k.z(50),
      ]);
      entry.currentCharacter = player.character;
    }
    // Sync sleeping state every update so a wake/sleep transition
    // takes effect immediately, even when no position change came
    // with it.
    entry.sprite.opacity = player.idle ? 0.55 : 1;
    entry.zzz.opacity = player.idle ? 0.9 : 0;
    entry.parent.rTile = { tx: player.tx, ty: player.ty };
    entry.parent.displayName = player.name;
    const targetX = player.tx * TILE;
    const targetY = player.ty * TILE;
    if (entry.parent.pos.x === targetX && entry.parent.pos.y === targetY) return;
    // Cancel any in-flight tween before starting a new one. Otherwise
    // each tween's lerp keeps writing to parent.pos every frame and
    // the sprite oscillates.
    entry.activeTween?.cancel();
    const fromX = entry.parent.pos.x;
    const fromY = entry.parent.pos.y;
    const tw = k.tween(
      0,
      1,
      TWEEN_S,
      (t) => {
        entry.parent.pos = k.vec2(
          fromX + (targetX - fromX) * t,
          fromY + (targetY - fromY) * t,
        );
      },
      k.easings.linear,
    );
    entry.activeTween = tw;
    tw.onEnd(() => {
      if (entry.activeTween === tw) entry.activeTween = null;
    });
  }

  function reconcile() {
    const current = new Map<string, RemotePlayer>();
    for (const p of getRemotePlayersForScene(opts.scene)) {
      current.set(p.participantKey, p);
    }

    for (const [key, entry] of active) {
      if (!current.has(key)) {
        entry.activeTween?.cancel();
        entry.parent.destroy();
        active.delete(key);
      }
    }
    for (const [key, player] of current) {
      let entry = active.get(key);
      if (entry) {
        update(entry, player);
      } else {
        entry = spawn(player);
        active.set(key, entry);
      }
    }

    opts.onPositionsChanged?.();
  }

  reconcile();
  const unsub = onRemotesChange(reconcile);

  return () => {
    unsub();
    for (const entry of active.values()) {
      entry.activeTween?.cancel();
      entry.parent.destroy();
    }
    active.clear();
  };
}
