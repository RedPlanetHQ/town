// Bridge between React UI (CommandBar / Cmd+K) and the kaplay overworld
// scene. The scene registers a teleport handler on mount and clears it
// on leave. React callers invoke `teleportTo(buildingId)` without knowing
// or caring whether a scene is currently mounted — it's a no-op if not.

export type TeleportHandler = (buildingId: string) => void;

let handler: TeleportHandler | null = null;

export function registerTeleport(fn: TeleportHandler | null): void {
  handler = fn;
}

export function teleportTo(buildingId: string): boolean {
  if (!handler) return false;
  handler(buildingId);
  return true;
}
