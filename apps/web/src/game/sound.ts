// Tiny WebAudio-synthesized chimes for game-level notifications.
// We synthesize instead of shipping an asset so this stays a zero-byte
// dependency and works identically across browsers.
//
// The very first call after a hard load can be silent on Chromium /
// Safari if the user hasn't interacted yet — autoplay policy. The town
// page requires keyboard interaction to play, so by the time a DM lands
// the AudioContext is already allowed to ring.

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (ctx) return ctx;
  const Ctor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }
  return ctx;
}

function blip(c: AudioContext, at: number, freq: number, dur: number) {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(0.18, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

// Quick two-note chime — E5 then G5 — for incoming DMs.
export function playMessageDing(): void {
  const c = getCtx();
  console.log("[sound] playMessageDing called", {
    ctx: !!c,
    state: c?.state,
    currentTime: c?.currentTime,
  });
  if (!c) return;
  if (c.state === "suspended") {
    console.log("[sound] resuming suspended AudioContext");
    c.resume()
      .then(() => console.log("[sound] resume() resolved, state=", c.state))
      .catch((e) => console.warn("[sound] resume() rejected", e));
  }
  const now = c.currentTime;
  blip(c, now, 659.25, 0.12);
  blip(c, now + 0.08, 783.99, 0.18);
  console.log("[sound] scheduled blips at", now);
}
