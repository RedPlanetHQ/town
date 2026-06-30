"use client";

// Fullscreen intro cinematic. Drops two letterbox bars over the kaplay
// canvas, scripts a helicopter pan (cinematic.runFlyover), and types out
// the welcome lines into the bottom bar.
//
// Recording side: instead of capturing only the kaplay canvas, we draw
// the whole composition (kaplay frame + letterbox + caption + welcome
// line) into a hidden compositor canvas every frame, then run
// MediaRecorder against THAT canvas's captureStream. The downloaded
// clip looks identical to what the visitor sees on screen.
//
// Mime preference is mp4/h264 first so the file plays in QuickTime,
// macOS Preview, Safari, and most native players. Browsers without
// mp4 encoder (Firefox) fall back to webm.

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cancelFlyover, runFlyover } from "../game/cinematic";

const FLYOVER_DURATION_MS = 4500;

// Each caption line types in over this fraction of its slot, then
// HOLDS the full text for the remainder of the slot. Without the hold,
// the last character lands on the very last frame — MediaRecorder
// routinely misses that frame and the downloaded clip shows "welcome
// to cor" instead of "welcome to core".
const TYPE_FRACTION = 0.7;

// Extra time after the cinematic ends to let MediaRecorder flush the
// last drawn frame to the encoder before we stop the stream.
const FLUSH_TAIL_MS = 150;

// Compositor (recording) dimensions. 16:9 1280×720 is a safe sweet
// spot — small enough to encode in real time even on modest CPUs, big
// enough to read well when uploaded. The proportions of the letterbox
// bars and caption match the on-screen overlay so the recording feels
// like a faithful capture.
const COMPOSITOR_W = 1280;
const COMPOSITOR_H = 720;
const TOP_BAR_FRACTION = 0.22;
const BOTTOM_BAR_FRACTION = 0.26;

interface FlyoverProps {
  townName: string | null;
  onClose: () => void;
}

interface CaptionLine {
  text: string;
  /** Fraction of the cinematic at which this line starts typing in. */
  startAt: number;
}

function buildLines(townName: string | null): CaptionLine[] {
  // Three-beat opener that frames the town as a meeting place for
  // mixed inhabitants. Line 1 establishes the population (humans +
  // agents) without explaining the why. Line 2 names what the town
  // is for (the place they meet). Line 3 lands on the specific town.
  const welcome = townName ? `Welcome to ${townName}` : "Welcome home";
  return [
    { text: "Some neighbours are people, some are agents", startAt: 0.0 },
    { text: "the towns are where they meet", startAt: 0.33 },
    { text: welcome, startAt: 0.66 },
  ];
}

export function Flyover({ townName, onClose }: FlyoverProps) {
  const [progress, setProgress] = useState(0);
  const [recording, setRecording] = useState<"idle" | "running" | "ready" | "unsupported">("idle");
  const [download, setDownload] = useState<{ url: string; mime: string } | null>(null);
  // Parent (TownGame → BottomToolbar) now passes townName for both
  // owner and visitor modes. We previously fell back to /api/towns/me
  // when null, but that endpoint returns the OLDEST owned town — so
  // multi-town owners viewing /{slug2} got a flyover captioned with
  // slug1's name. The ref version is what the raf draw loop reads so
  // it doesn't need to re-attach when the React state updates.
  const resolvedName = townName;
  const resolvedNameRef = useRef<string | null>(townName);
  resolvedNameRef.current = resolvedName;

  // Portal mount gate — without this the first SSR / initial client
  // render calls createPortal before document.body exists.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const downloadRef = useRef<{ url: string; mime: string } | null>(null);
  downloadRef.current = download;

  // Cinematic + recording. One useEffect that owns the source
  // canvas lookup, the compositor canvas, the draw loop, and the
  // MediaRecorder lifecycle.
  useEffect(() => {
    let cancelled = false;
    let rafId: number | null = null;
    const startTs = performance.now();

    const sourceCanvas =
      typeof document !== "undefined"
        ? document.querySelector<HTMLCanvasElement>("canvas[data-town-canvas]")
        : null;

    // Compositor — 2D canvas we draw the whole picture into. captureStream
    // from this so the recording shows everything the viewer sees.
    let compositor: HTMLCanvasElement | null = null;
    let captureOk = false;
    if (
      sourceCanvas &&
      typeof window.MediaRecorder !== "undefined"
    ) {
      compositor = document.createElement("canvas");
      compositor.width = COMPOSITOR_W;
      compositor.height = COMPOSITOR_H;
      try {
        const stream = compositor.captureStream(30);
        const mime = pickMimeType();
        if (mime) {
          const rec = new MediaRecorder(stream, { mimeType: mime });
          rec.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
          };
          rec.onstop = () => {
            const blob = new Blob(chunksRef.current, { type: mime });
            const url = URL.createObjectURL(blob);
            setDownload({ url, mime });
            setRecording("ready");
          };
          rec.start();
          recorderRef.current = rec;
          captureOk = true;
          setRecording("running");
        }
      } catch {
        // fall through to unsupported
      }
    }
    if (!captureOk) {
      setRecording("unsupported");
    }

    // Draw loop. Runs even when recording is unsupported so a future
    // surface (a "preview" inline preview) could read from compositor
    // without rewiring this hook.
    function renderFrame() {
      if (cancelled) return;
      const elapsed = performance.now() - startTs;
      const t = Math.min(1, elapsed / FLYOVER_DURATION_MS);
      if (compositor && sourceCanvas) {
        const ctx = compositor.getContext("2d");
        if (ctx) {
          drawCompositorFrame(
            ctx,
            sourceCanvas,
            t,
            resolvedNameRef.current,
          );
        }
      }
      if (t < 1) {
        rafId = requestAnimationFrame(renderFrame);
      }
    }
    rafId = requestAnimationFrame(renderFrame);

    // Camera + on-screen typewriter progress.
    void runFlyover({
      durationMs: FLYOVER_DURATION_MS,
      onProgress: ({ t }) => {
        if (cancelled) return;
        setProgress(t);
      },
    }).then(() => {
      if (cancelled) return;
      // Give the recorder one final raf tick at progress=1 (welcome
      // line fully shown, camera held at end anchor) before stopping.
      window.setTimeout(() => {
        if (!cancelled) stopRecording();
      }, FLUSH_TAIL_MS);
    });

    return () => {
      cancelled = true;
      cancelFlyover();
      stopRecording();
      if (rafId !== null) cancelAnimationFrame(rafId);
      // Defer URL revocation so a click on Download fired on the same
      // tick has time to grab the href.
      const dl = downloadRef.current;
      if (dl) {
        const url = dl.url;
        window.setTimeout(() => URL.revokeObjectURL(url), 5000);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Esc skips. Same dismissal as the SKIP button.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handleSkip();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopRecording = useCallback(() => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      try {
        rec.stop();
      } catch {
        // ignore
      }
    }
  }, []);

  const handleSkip = useCallback(() => {
    cancelFlyover();
    stopRecording();
    onClose();
  }, [onClose, stopRecording]);

  function triggerDownload() {
    if (!download) return;
    const ext = mimeToExt(download.mime);
    const a = document.createElement("a");
    a.href = download.url;
    a.download = `${(resolvedName ?? "town").toLowerCase().replace(/\s+/g, "-")}-flyover.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  const lines = buildLines(resolvedName);
  const slotLength = 1 / lines.length;

  if (!mounted) return null;

  return createPortal(
    <div
      className="pointer-events-none fixed inset-0 z-[60] flex flex-col justify-between"
      role="dialog"
      aria-label="Town flyover"
    >
      {/* Top letterbox bar. */}
      <div
        className="pointer-events-auto flex items-center justify-end px-6"
        style={{ background: "#000", height: `${TOP_BAR_FRACTION * 100}vh` }}
      >
        <button
          type="button"
          onClick={handleSkip}
          aria-label="Skip flyover"
          className="text-xs font-bold uppercase tracking-[0.25em] text-paper/80 hover:text-paper"
        >
          Skip ›
        </button>
      </div>

      {/* Bottom letterbox bar — caption + download. */}
      <div
        className="pointer-events-auto flex items-end justify-between gap-6 px-6 pb-6 pt-6"
        style={{ background: "#000", height: `${BOTTOM_BAR_FRACTION * 100}vh` }}
      >
        <div className="flex-1">
          {lines.map((line, i) => {
            const local = Math.max(
              0,
              Math.min(1, (progress - line.startAt) / slotLength),
            );
            const shown = Math.floor(local * line.text.length);
            const visible = line.text.slice(0, shown);
            const highlight = i === lines.length - 1;
            return (
              <div
                key={i}
                className={
                  highlight
                    ? "mt-1 font-mono text-2xl font-black uppercase tracking-[0.18em] text-paper"
                    : "font-mono text-base uppercase tracking-[0.18em] text-paper/80"
                }
              >
                {visible}
                {local > 0 && local < 1 ? (
                  <span
                    className="ml-0.5 inline-block w-2 bg-paper align-middle"
                    style={{ height: "0.85em" }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-2">
          {recording === "ready" && download ? (
            <button
              type="button"
              onClick={triggerDownload}
              className="border-2 border-paper/30 bg-paper px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-ink hover:bg-paper/90"
            >
              Download .{mimeToExt(download.mime)} ↓
            </button>
          ) : recording === "running" ? (
            <span className="text-xs uppercase tracking-wider text-paper/50">
              Recording…
            </span>
          ) : recording === "unsupported" ? (
            <span className="text-xs uppercase tracking-wider text-paper/40">
              Recording unsupported
            </span>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Draw one frame into the compositor: kaplay view scaled to fill,
// black letterbox bars on top + bottom, caption text typed in.
function drawCompositorFrame(
  ctx: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  progress: number,
  townName: string | null,
): void {
  const W = COMPOSITOR_W;
  const H = COMPOSITOR_H;

  // Background black so transparent pixels (e.g. the kaplay letterbox
  // when its aspect != ours) don't show stale frames.
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, H);

  // Kaplay view, stretched to fill the compositor. Kaplay's own
  // stretch+letterbox means content already adapts to its canvas size;
  // we let the compositor mirror that 1:1.
  if (source.width > 0 && source.height > 0) {
    try {
      ctx.drawImage(source, 0, 0, W, H);
    } catch {
      // Cross-origin or context loss — skip the frame; the bars + text
      // still record.
    }
  }

  // Letterbox bars.
  const topH = Math.round(H * TOP_BAR_FRACTION);
  const bottomH = Math.round(H * BOTTOM_BAR_FRACTION);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, W, topH);
  ctx.fillRect(0, H - bottomH, W, bottomH);

  // Caption — match the DOM's typewriter pacing.
  const padX = 36;
  const fontFamily =
    '"JetBrains Mono", "SFMono-Regular", "Monaco", "Menlo", monospace';
  const lines = buildLines(townName);
  const slotLen = 1 / lines.length;

  // Top of the bottom bar's text block. Two small lines stacked, then
  // the welcome line in larger weight at the baseline.
  const bottomTop = H - bottomH;
  let cursorY = bottomTop + Math.round(bottomH * 0.18);

  ctx.textBaseline = "top";
  ctx.fillStyle = "rgba(246, 243, 234, 0.85)";
  ctx.font = `bold 22px ${fontFamily}`;
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    const local = Math.max(0, Math.min(1, (progress - line.startAt) / slotLen));
    const shown = Math.floor(local * line.text.length);
    const visible = line.text.slice(0, shown).toUpperCase();
    ctx.fillText(visible, padX, cursorY);
    cursorY += 32;
  }

  const welcome = lines[lines.length - 1]!;
  const wLocal = Math.max(0, Math.min(1, (progress - welcome.startAt) / slotLen));
  const wShown = Math.floor(wLocal * welcome.text.length);
  const wVisible = welcome.text.slice(0, wShown).toUpperCase();
  ctx.fillStyle = "#f6f3ea";
  ctx.font = `900 44px ${fontFamily}`;
  const welcomeY = H - Math.round(bottomH * 0.32);
  ctx.fillText(wVisible, padX, welcomeY);
}

// Pick the first MediaRecorder mime type the browser supports. mp4
// goes first so the downloaded file plays in QuickTime / Preview /
// Safari without a converter. webm is the fallback for Firefox-like
// browsers that don't ship an mp4 encoder.
function pickMimeType(): string | null {
  if (
    typeof window === "undefined" ||
    typeof window.MediaRecorder === "undefined"
  ) {
    return null;
  }
  const candidates = [
    "video/mp4;codecs=h264",
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const c of candidates) {
    if (window.MediaRecorder.isTypeSupported(c)) return c;
  }
  return null;
}

function mimeToExt(mime: string): "mp4" | "webm" {
  if (mime.startsWith("video/mp4")) return "mp4";
  return "webm";
}
