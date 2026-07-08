"use client";

// Module-level audio singleton + a React subscription so multiple
// components (the button label, the popover transport) see the same
// playback state. There is exactly one <audio> element that lives in
// `audioEl` and survives component unmounts.
//
// State is driven by the audio element's native events (`play`,
// `pause`, `ended`, `error`) rather than by hand-rolled notify() calls
// in each action. That way every path that changes playback — toggle,
// auto-advance, OS media keys, devtools — keeps the UI in lockstep
// with what's actually happening, and the play/pause icon flips the
// moment the browser commits to the state change.

import { useEffect, useState } from "react";

import { TOWN_RADIO_TRACKS, type RadioTrack } from "./town-radio-tracks";

interface RadioState {
  index: number;
  playing: boolean;
  error: boolean;
}

const PAUSED_STORAGE_KEY = "town-radio:paused";

function readPausedPreference(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PAUSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function writePausedPreference(paused: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PAUSED_STORAGE_KEY, paused ? "1" : "0");
  } catch {
    // Storage may be unavailable (private mode, quota) — the radio still
    // works, it just won't remember the preference next reload.
  }
}

let audioEl: HTMLAudioElement | null = null;
let state: RadioState = { index: 0, playing: false, error: false };
const listeners = new Set<() => void>();

function notify(): void {
  for (const fn of listeners) fn();
}

function setState(patch: Partial<RadioState>): void {
  const next = { ...state, ...patch };
  if (
    next.index === state.index &&
    next.playing === state.playing &&
    next.error === state.error
  ) {
    return;
  }
  state = next;
  notify();
}

function ensureAudio(): HTMLAudioElement | null {
  if (typeof window === "undefined") return null;
  if (audioEl) return audioEl;
  const a = new Audio();
  a.preload = "metadata";

  // Authoritative state mirrors — every action below just calls
  // a.play()/a.pause() and trusts these listeners to update React.
  a.addEventListener("play", () => setState({ playing: true, error: false }));
  a.addEventListener("playing", () =>
    setState({ playing: true, error: false }),
  );
  a.addEventListener("pause", () => setState({ playing: false }));
  a.addEventListener("error", () =>
    setState({ playing: false, error: true }),
  );
  a.addEventListener("ended", () => {
    // Auto-advance to the next track. If autoplay is blocked the next
    // play() will reject and the error listener will surface it.
    const nextIndex = (state.index + 1) % TOWN_RADIO_TRACKS.length;
    loadAndPlay(nextIndex);
  });

  audioEl = a;
  return a;
}

function loadAndPlay(index: number): void {
  const a = ensureAudio();
  if (!a) return;
  const track = TOWN_RADIO_TRACKS[index];
  if (!track) return;
  // Set src + the React index immediately so the popover highlights
  // the new row even while the file is still buffering.
  a.src = track.src;
  setState({ index, error: false });
  void a.play().catch(() => {
    setState({ playing: false, error: true });
  });
}

// Default-play arm. Browsers reject Audio.play() without a user
// gesture, so we wait for the first keydown / pointerdown anywhere
// on the page and use that as the implicit "yes, start the radio"
// signal. The arm is idempotent + a no-op after the first fire so
// re-mounting components doesn't restart the playlist.
let autoplayArmed = false;
function armDefaultPlay(): void {
  if (autoplayArmed) return;
  if (typeof window === "undefined") return;
  autoplayArmed = true;

  const begin = () => {
    window.removeEventListener("pointerdown", begin);
    window.removeEventListener("keydown", begin);
    // Don't trample on a user who already pressed play in the popover.
    if (state.playing) return;
    // Respect a persisted pause: if the user paused the radio in a
    // previous session, don't spring it back to life on their next click.
    if (readPausedPreference()) return;
    loadAndPlay(0);
  };
  window.addEventListener("pointerdown", begin, { once: true });
  window.addEventListener("keydown", begin, { once: true });
}

export interface UseTownRadio {
  tracks: readonly RadioTrack[];
  current: RadioTrack;
  index: number;
  playing: boolean;
  error: boolean;
  toggle: () => void;
  next: () => void;
  prev: () => void;
  select: (index: number) => void;
}

export function useTownRadio(): UseTownRadio {
  const [snap, setSnap] = useState<RadioState>(() => state);

  useEffect(() => {
    const cb = () => setSnap(state);
    listeners.add(cb);
    // Re-sync on mount in case the singleton state changed between
    // the initial useState() and the effect firing.
    cb();
    // Arm default playback once per page lifetime. The arm itself is
    // idempotent so calling it from every hook mount is fine.
    armDefaultPlay();
    return () => {
      listeners.delete(cb);
    };
  }, []);

  const current = TOWN_RADIO_TRACKS[snap.index] ?? TOWN_RADIO_TRACKS[0]!;

  function toggle() {
    const a = ensureAudio();
    if (!a) return;
    if (state.playing) {
      writePausedPreference(true);
      a.pause();
      return;
    }
    writePausedPreference(false);
    if (!a.src) {
      loadAndPlay(state.index);
      return;
    }
    void a.play().catch(() => {
      setState({ playing: false, error: true });
    });
  }

  function next() {
    writePausedPreference(false);
    loadAndPlay((state.index + 1) % TOWN_RADIO_TRACKS.length);
  }

  function prev() {
    writePausedPreference(false);
    loadAndPlay(
      (state.index - 1 + TOWN_RADIO_TRACKS.length) % TOWN_RADIO_TRACKS.length,
    );
  }

  function select(index: number) {
    if (index < 0 || index >= TOWN_RADIO_TRACKS.length) return;
    writePausedPreference(false);
    loadAndPlay(index);
  }

  return {
    tracks: TOWN_RADIO_TRACKS,
    current,
    index: snap.index,
    playing: snap.playing,
    error: snap.error,
    toggle,
    next,
    prev,
    select,
  };
}
