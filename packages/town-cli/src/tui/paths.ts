// Tiny helpers shared by the TUI surface.

import { homedir } from "node:os";

/** Replace the user's home dir with `~` for status-bar display. */
export function tildeify(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(home + "/")) return "~" + path.slice(home.length);
  return path;
}
