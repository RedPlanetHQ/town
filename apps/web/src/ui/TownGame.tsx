"use client";

import { useEffect, useRef, useState } from "react";
import { bootGame, type GameContext } from "../game/boot";
import { BootScreen } from "./BootScreen";
import { refreshSession } from "../game/auth";
import { startSuggestionsPoller } from "../game/suggestions";
import { startWorkspaceSync } from "../game/workspace";
import { startNpcsSync, getNpcCount, onNpcsChange, refreshNpcs } from "../game/npcs";
import { setOwnerTownSlug, setViewerTownSlug } from "../game/plotClient";
import {
  CLIENT_AURA_SLEEP_THRESHOLD,
  getAura as getAuraFromStore,
  onAuraChange,
  setAura as publishAura,
} from "../game/aura";
import { setPlayerCharacter } from "../game/character";
import {
  startRealtime,
  getRemotePlayers,
  getLocalScene,
  onLocalSceneChange,
  onRemotesChange,
  type RealtimeHandle,
} from "../game/realtime";
import { startPendingPoller } from "../game/dmPending";
import { OWNER_DEFAULT_CHARACTER } from "../lib/characters";
import { useUiState } from "./useUiStore";
import { Hud } from "./Hud";
import { InteractionPrompt } from "./InteractionPrompt";
import { Panel } from "./Panel";
import { Explorer } from "./Explorer";
import { Dialogue } from "./Dialogue";
import { Chat } from "./Chat";
import { Invite } from "./Invite";
import { ShareImage } from "./ShareImage";
import { Suggestions } from "./Suggestions";
import { Dm } from "./Dm";
import { ItemsBadge } from "./ItemsBadge";
import { RemoteCards } from "./RemoteCards";
import { VisitorHud } from "./VisitorHud";
import { PALETTE } from "../game/config";
import { ui } from "./store";
import { GroupChatPrompt, GroupChatSurface } from "../features/group-chat";
import { BottomBar } from "./BottomBar";
import { BuildTownCta } from "./BuildTownCta";
import { CommunityLinks } from "./CommunityLinks";
import { Flyover } from "./Flyover";
import { HudButton } from "./HudButton";
import { AuraBar } from "./AuraBar";
import { LeaderboardPopover } from "./LeaderboardPopover";
import { PopulationPopover, type Aura } from "./PopulationPopover";
import { TownInstructionsModal } from "./TownInstructionsModal";
import { TownRadio } from "./TownRadio";
import { TransitionLoading } from "./TransitionLoading";

// The mount point: a canvas owned by React, populated by kaplay in useEffect,
// and a sibling overlay layer for the React-rendered UI (HUD, prompt, panels).
//
// `viewerMode` switches the page between owner-mode (full feature set) and
// visitor-mode (read-only canvas of someone else's town):
//   • owner    — what was here before. Boots pollers + own-plot fetch.
//   • visitor  — points plotClient at /api/plot?town=<slug>, skips the
//                owner-only pollers (workspace).
//
// Owner is the default so the existing root `/` page keeps working
// unchanged.
export type TownGameProps =
  | {
      viewerMode?: "owner";
      ownerCharacter?: string;
      // Omitted only when rendering the guest playground at `/` — that
      // path has no Town and no realtime.
      townSlug?: string;
      // Display name for the Invite modal's heading. Multi-town owners
      // open Invite on whichever town they're viewing, so we pass both
      // slug + name down from the [town] page rather than guessing
      // server-side (the old /api/towns/me path returned the OLDEST
      // town, which was wrong for multi-town owners).
      townName?: string;
      /** Owner's welcome pitch — surfaces as the first-load dialogue.
       *  Null when the owner hasn't authored one; the dialogue falls
       *  back to a generic "welcome to <town>" line. */
      townDescription?: string | null;
    }
  | {
      viewerMode: "visitor";
      townSlug: string;
      townName: string;
      townDescription?: string | null;
      visitorName: string;
      visitorCharacter: string;
      // Owner's participantKey (e.g. "user:<userId>"). Used by the
      // population badge to tell the invitee whether the owner is
      // currently in the town.
      ownerParticipantKey: string;
    };

export function TownGame(props: TownGameProps = {}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<GameContext | null>(null);
  // Single startup overlay: the CORE OS boot screen sits over the
  // canvas, runs its 1.4s sweep, then waits for the kaplay scene to
  // flip ui.worldReady before dismissing. That collapses what used
  // to be three loading states (browser flash → boot → in-canvas
  // "loading town…") into one continuous screen. sessionStorage skip
  // is intentionally NOT applied here — we always want the overlay
  // to wait for the scene to finish drawing, even on soft navs.
  const [bootVisible, setBootVisible] = useState(true);
  const {
    hud,
    prompt,
    panel,
    explorer,
    dialogue,
    chat,
    invite,
    shareImage,
    instructions,
    feed,
    proximity,
    dm,
    suggestions,
    worldReady,
  } = useUiState();

  const isVisitor = props.viewerMode === "visitor";
  // Extract scalar values from `props` so the boot effect only re-runs
  // when something that actually changes the kaplay setup changes. JSX
  // hands TownGame a fresh `props` object every parent render — depending
  // on `props` directly tore down + re-booted kaplay on every Landing
  // re-render, which is what surfaced the "KAPLAY already initialized"
  // warning and a white canvas after the Try-the-demo click.
  const ownerSlug = !isVisitor
    ? (props as { townSlug?: string }).townSlug
    : undefined;
  const ownerName = !isVisitor
    ? (props as { townName?: string }).townName
    : undefined;
  const visitorSlug = isVisitor
    ? (props as { townSlug: string }).townSlug
    : undefined;
  const ownerCharacter = !isVisitor
    ? (props as { ownerCharacter?: string }).ownerCharacter
    : undefined;
  const visitorCharacter = isVisitor
    ? (props as { visitorCharacter: string }).visitorCharacter
    : undefined;
  const townDescription = (
    props as { townDescription?: string | null }
  ).townDescription;
  const activeSlug = ownerSlug ?? visitorSlug ?? null;
  const activeName = ownerName ?? (isVisitor ? (props as { townName: string }).townName : null);

  // Instructions modal auto-open — replaces the old auto-fire welcome
  // dialogue. Fires on every page load once the scene is drawn. Shows
  // the town description on top + a fixed how-to-play cheatsheet below;
  // dismissed by the "Explore town" button, the ESC key, or backdrop
  // click. Reachable any time from the Instructions pill in the bottom
  // toolbar. The ref guards against React StrictMode double-mount in
  // dev; a real page reload wipes it and the modal re-opens.
  const instructionsFiredRef = useRef(false);
  useEffect(() => {
    if (!activeSlug || !activeName) return;
    if (!worldReady) return;
    if (instructionsFiredRef.current) return;
    instructionsFiredRef.current = true;
    ui.openInstructions();
  }, [activeSlug, activeName, worldReady]);

  useEffect(() => {
    if (!canvasRef.current) return;
    if (ctxRef.current) return;

    // Route plot fetches + pick the player sprite BEFORE the scene mounts.
    if (isVisitor) {
      setViewerTownSlug(visitorSlug ?? null);
      setPlayerCharacter(visitorCharacter ?? OWNER_DEFAULT_CHARACTER);
    } else {
      // Owner-mode: pass the active slug so plotClient can disambiguate
      // when the user owns multiple towns. Falls back to null when the
      // page is the guest playground at `/` (no slug, single-town flow
      // still works because the server returns the only town).
      setOwnerTownSlug(ownerSlug ?? null);
      setPlayerCharacter(ownerCharacter ?? OWNER_DEFAULT_CHARACTER);
    }

    const ctx = bootGame(canvasRef.current);
    ctxRef.current = ctx;

    // Tear-downs shared across both branches — kaplay context first so
    // the GL canvas is released before React unmounts the <canvas>.
    const disposeKaplay = () => {
      try {
        ctx.quit();
      } catch {
        // quit can throw if the context was already released; safe to
        // swallow.
      }
      ctxRef.current = null;
    };

    if (isVisitor) {
      // Visitor: skip owner-scoped pollers, but still join the realtime
      // bus so they see (and are seen by) the owner + other visitors.
      const slug = visitorSlug!;
      let visitorRt: RealtimeHandle | null = null;
      void startRealtime({ slug }).then((handle) => {
        visitorRt = handle;
      });
      const stopPending = startPendingPoller(slug);
      const stopNpcs = startNpcsSync();
      return () => {
        visitorRt?.stop();
        stopPending();
        stopNpcs();
        disposeKaplay();
      };
    }

    void refreshSession();
    const stopWorkspace = startWorkspaceSync();
    const stopNpcs = startNpcsSync();
    const stopSuggestions = startSuggestionsPoller(ownerSlug ?? null);

    let rt: RealtimeHandle | null = null;
    let stopPending: (() => void) | null = null;
    if (ownerSlug) {
      void startRealtime({ slug: ownerSlug }).then((handle) => {
        rt = handle;
      });
      stopPending = startPendingPoller(ownerSlug);
    }
    return () => {
      stopWorkspace();
      stopNpcs();
      stopSuggestions();
      rt?.stop();
      stopPending?.();
      disposeKaplay();
    };
  }, [isVisitor, ownerSlug, visitorSlug, ownerCharacter, visitorCharacter]);

  // Refocus the canvas every time the last open modal closes. Modal
  // inputs / buttons keep DOM focus after they unmount; that focus is
  // technically "nowhere" but Chrome/Firefox still route arrow keys to
  // the previously-focused element instead of bubbling to kaplay's
  // canvas-level keydown listener — which is why the player can't
  // immediately walk after pressing Esc to close a chat / panel.
  // Blurring + re-focusing the canvas wires arrows straight back to
  // the game loop with no extra click.
  const anyModalOpen =
    !!chat ||
    !!dialogue ||
    !!panel ||
    !!invite ||
    !!shareImage ||
    !!dm ||
    !!explorer ||
    suggestions.open;
  useEffect(() => {
    if (anyModalOpen) return;
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body) active.blur?.();
    canvasRef.current?.focus?.();
  }, [anyModalOpen]);

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-ink-shadow">
      <canvas
        ref={canvasRef}
        // tabIndex makes the canvas focusable so canvasRef.current.focus()
        // actually lands keyboard focus here when a modal closes.
        tabIndex={0}
        // data-town-canvas tags the kaplay canvas for the Flyover
        // overlay to grab via querySelector — saves threading a ref
        // through the bottom-bar tray to the cinematic surface.
        data-town-canvas
        className="absolute inset-0 h-full w-full focus:outline-none"
        style={{
          imageRendering: "pixelated",
          // Barely-there retro cast — hint of warmth + slight pixel-art
          // snap. Global brightness/saturation left untouched so the
          // plot stays vibrant; the vignette below carries most of the
          // "retro" weight and darkens the corners where the HUD / bar
          // buttons live so they read clearly.
          filter: "sepia(0.06) contrast(1.05)",
        }}
      />

      {/* Film-grain noise — procedural SVG turbulence, desaturated to
          clean grayscale, tiled across the canvas. Sits above the
          canvas and below the vignette (DOM order: canvas → noise →
          vignette) so the corner darkening still reads cleanly. Plain
          alpha blend (no mix-blend-mode) so the grain is unambiguously
          visible on top of the pixel art. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10"
        style={{
          backgroundImage: `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='200' height='200'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='2' stitchTiles='stitch'/><feColorMatrix type='saturate' values='0'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>")`,
          backgroundRepeat: "repeat",
          opacity: 0.22,
        }}
      />

      {/* Corner vignette — pointer-events-none, above the canvas but
          below every interactive UI overlay (z-30). Transparent through
          the middle 55% of the screen and fades to a soft black at the
          corners, giving the HUD/bottom-bar/community-links a darker
          patch to sit on without dulling the middle of the plot. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 z-10"
        style={{
          background:
            "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.45) 100%)",
        }}
      />

      {/* React-rendered cards floating above each remote player. Picks
          up positions from kaplay via the projection helper. The town
          slug (owner or visitor mode resolves to the same string) lets
          RemoteCards poll the head-tag endpoint and stack pills above
          each player's name card. */}
      <RemoteCards canvasRef={canvasRef} townSlug={ownerSlug ?? visitorSlug} />

      {/* Top-left row — identity HudButton + community pills (GitHub,
          Discord). All siblings so they sit side-by-side at the same
          height. Owner gets Hud; visitor gets the visiting/exit pair. */}
      <div className="pointer-events-auto absolute left-3 top-3 z-30 flex items-center gap-2">
        {isVisitor ? (
          <VisitorHud
            townName={(props as { townName: string }).townName}
            visitorName={(props as { visitorName: string }).visitorName}
            townSlug={(props as { townSlug: string }).townSlug}
          />
        ) : hud ? (
          <Hud hud={hud} activeSlug={ownerSlug ?? null} />
        ) : null}
        <CommunityLinks />
      </div>

      {/* Top-right row — population + items (visitor) / suggestions
          (owner) as same-height HudButton siblings. */}
      <div className="pointer-events-auto absolute right-3 top-3 z-30 flex items-center gap-2">
        <PopulationBadge
          townSlug={ownerSlug ?? visitorSlug}
          ownerParticipantKey={
            isVisitor
              ? (props as { ownerParticipantKey: string }).ownerParticipantKey
              : null
          }
        />
        {ownerSlug ?? visitorSlug ? (
          <LeaderboardBadge townSlug={(ownerSlug ?? visitorSlug) as string} />
        ) : null}
        {isVisitor ? (
          <ItemsBadge townSlug={(props as { townSlug: string }).townSlug} />
        ) : null}
        {!isVisitor ? <SuggestionsBadge count={suggestions.count} /> : null}
      </div>

      {prompt ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-12 z-30 flex justify-center">
          <InteractionPrompt prompt={prompt} />
        </div>
      ) : proximity ? (
        // Bottom-center prompt for the closest nearby player. Same vocab
        // as the building-interaction prompts so SPACE always means the
        // same thing visually.
        <div className="pointer-events-none absolute inset-x-0 bottom-12 z-30 flex justify-center">
          <InteractionPrompt
            prompt={{
              label: `SPACE to talk to ${proximity.name}`,
              accent: "#1db954",
            }}
          />
        </div>
      ) : null}

      {/* All modal overlays remain rendered. Visitor's underlying API calls
          will 401/403 — fine for the initial cut; we'll tighten later by
          gating these on viewerMode. */}
      {panel ? <Panel panel={panel} /> : null}
      {explorer ? <Explorer /> : null}
      {dialogue ? <Dialogue dialogue={dialogue} /> : null}
      {chat ? <Chat chat={chat} /> : null}
      {!isVisitor && invite && ownerSlug ? (
        <Invite townSlug={ownerSlug} townName={ownerName ?? ownerSlug} />
      ) : null}
      {!isVisitor && shareImage && ownerSlug ? (
        <ShareImage townSlug={ownerSlug} townName={ownerName ?? ownerSlug} />
      ) : null}
      {instructions && activeName ? (
        <TownInstructionsModal
          townName={activeName}
          townDescription={townDescription ?? null}
        />
      ) : null}
      {!isVisitor && suggestions.open ? (
        <Suggestions list={suggestions.list} />
      ) : null}
      {dm ? (
        <Dm
          townSlug={dm.townSlug}
          otherKey={dm.otherKey}
          otherName={dm.otherName}
        />
      ) : null}

      {/* Group chat — non-modal Twitch-style overlay + floating [G]
          prompt. Both internally gate on `groupChatStore` state, which
          stays null until the player walks into a building whose
          `groupChatEnabled` flag is on. Deleting these two lines + the
          features/group-chat folder + the building flag removes the
          feature. */}
      <GroupChatPrompt />
      <GroupChatSurface />

      {/* Left-side toolbar that floats just above the BottomBar: the
          "Build your own town" CTA (visitor only) sits alongside the
          Town Radio music player and the Flyover intro launcher. One
          row keeps the left corner readable as a single peer to the
          activity ticker. The Flyover button only makes sense from
          the overworld — hide it inside building interiors so the
          intro doesn't try to fly over a scene with no plot loaded. */}
      <BottomToolbar
        isVisitor={isVisitor}
        townName={
          isVisitor
            ? (props as { townName: string }).townName
            : (ownerName ?? null)
        }
      />


      {/* Bottom-bar — town activity toggle + rotating ticker + "Town
          from core" attribution. Spans the full width of the screen. */}
      <BottomBar
        townSlug={ownerSlug ?? visitorSlug}
        feedOpen={!!feed && !!(ownerSlug || visitorSlug)}
      />

      {bootVisible ? (
        <BootScreen ready={worldReady} onDone={() => setBootVisible(false)} />
      ) : !worldReady ? (
        // Mid-game scene transition (interior → overworld is the loud
        // one). BootScreen has already dismissed, so without this card
        // the player sees a blank green canvas for ~1s while the new
        // scene fetches + redraws.
        <TransitionLoading />
      ) : null}

      {/* Dim overlay when the town's aura is under the sleep threshold.
          Non-blocking (pointer-events: none) so the player can still
          wander around — building entry is what actually gets gated by
          the bouncer dialogue in overworld-plot.ts. */}
      <SleepingOverlay />
    </div>
  );
}

/** Dark tint + small "Town sleeping" pill while aura is below
 *  CLIENT_AURA_SLEEP_THRESHOLD. Reads from the same pub-sub the
 *  overworld's entry gate uses, so both surfaces agree on the state. */
function SleepingOverlay() {
  const [sleeping, setSleeping] = useState(
    () =>
      (getAuraFromStore()?.current ?? Number.POSITIVE_INFINITY) <
      CLIENT_AURA_SLEEP_THRESHOLD,
  );
  useEffect(() => {
    const update = () => {
      const aura = getAuraFromStore();
      setSleeping(
        aura !== null && aura.current < CLIENT_AURA_SLEEP_THRESHOLD,
      );
    };
    update();
    return onAuraChange(update);
  }, []);
  if (!sleeping) return null;
  return (
    <div
      className="pointer-events-none absolute inset-0 z-20"
      style={{ background: "rgba(8, 10, 18, 0.4)" }}
      aria-hidden
    >
      <div className="pointer-events-none absolute inset-x-0 top-16 flex justify-center">
        <div
          className="rounded border-2 border-black bg-ink px-3 py-1 text-xs font-black uppercase tracking-wider text-paper shadow-md"
          style={{ background: "#0e1116" }}
        >
          Zzz · Town is sleeping · Aura low
        </div>
      </div>
    </div>
  );
}

// Top-right "Population: N" pill. Counts every NPC the user has
// authored plus every remote player the realtime bus knows about plus
// the local viewer. Clicking the pill opens a directory popover that
// breaks the count down into NPCs vs Guests with a name search.
function PopulationBadge({
  townSlug,
  ownerParticipantKey,
}: {
  townSlug: string | undefined;
  ownerParticipantKey: string | null;
}) {
  const [remotes, setRemotes] = useState(() => getRemotePlayers());
  const [npcCount, setNpcCount] = useState(() => getNpcCount());
  const [aura, setAura] = useState<Aura | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const update = () => setRemotes(getRemotePlayers());
    update();
    return onRemotesChange(update);
  }, []);
  useEffect(() => {
    const update = () => setNpcCount(getNpcCount());
    update();
    // Defensive re-fetch — startNpcsSync's teardown wipes the cache,
    // and in StrictMode dev that can land between the mount/cleanup
    // cycle, leaving the count stuck at 0 with no listener to update
    // it. Triggering a fresh fetch from the consumer guarantees we
    // populate even if the cache was just nuked.
    void refreshNpcs();
    return onNpcsChange(update);
  }, []);
  // Poll aura on a 30s cadence so LLM-driven drains surface quickly
  // enough for the sleeping overlay to react. Also publishes to the
  // shared game/aura store so the interior scene (💤 above each NPC)
  // consumes the same value.
  useEffect(() => {
    if (!townSlug) {
      setAura(null);
      publishAura(null);
      return;
    }
    let cancelled = false;
    const url = `/api/towns/${encodeURIComponent(townSlug)}/aura`;
    const fetchOnce = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as Aura;
        if (cancelled) return;
        const next = { current: body.current, max: body.max };
        setAura(next);
        publishAura(next);
      } catch {
        // Network blip — keep the last value.
      }
    };
    void fetchOnce();
    const id = window.setInterval(fetchOnce, 30 * 1000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [townSlug]);
  // remotes + NPCs + viewer themselves.
  const total = remotes.length + npcCount + 1;
  const ownerAway =
    !!ownerParticipantKey &&
    !remotes.some((r) => r.participantKey === ownerParticipantKey);
  const populationLabel = ownerAway
    ? `Population: ${total} · owner away`
    : `Population: ${total}`;
  return (
    <div className="relative inline-flex">
      <HudButton
        onClick={() => setOpen((v) => !v)}
        active={open}
        aria-label={`Population: ${total}${ownerAway ? ", owner not in town" : ""}${
          aura ? `, aura ${aura.current} of ${aura.max}` : ""
        }`}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          ownerAway
            ? `${total} in town (NPCs + visitors) · owner isn't here right now`
            : `${total} in town — NPCs + visitors + you`
        }
      >
        <span className="inline-flex items-center gap-1.5">
          <span>{populationLabel}</span>
          {aura ? (
            <>
              <span aria-hidden className="text-paper/30">·</span>
              <AuraBar current={aura.current} max={aura.max} />
            </>
          ) : null}
        </span>
      </HudButton>
      {open ? (
        <PopulationPopover aura={aura} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}

// Icon-only HudButton sibling to the Population pill. Opens a popover
// with the per-town leaderboard (visitors ranked by items + tags earned
// inside this town). The trophy glyph is the recognizable "leaderboard"
// signifier at pill height — no label, so the pill stays compact next
// to the wider Population one.
function LeaderboardBadge({ townSlug }: { townSlug: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-flex">
      <HudButton
        onClick={() => setOpen((v) => !v)}
        active={open}
        aria-label="Open leaderboard"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="Leaderboard — top visitors in this town"
      >
        <TrophyIcon />
      </HudButton>
      {open ? (
        <LeaderboardPopover townSlug={townSlug} onClose={() => setOpen(false)} />
      ) : null}
    </div>
  );
}

function TrophyIcon() {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
    >
      <path
        d="M8 4h8v4a4 4 0 0 1-8 0V4zM5 5h3v3H6a2 2 0 0 1-2-2V5h1zm14 0h-3v3h2a2 2 0 0 0 2-2V5h-1zM10 14h4l1 5h-6l1-5z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="square"
      />
    </svg>
  );
}

// Left-side bottom toolbar: BuildTownCta (visitors) + Town Radio +
// Flyover + Instructions. Subscribes to scene changes so the Flyover
// button drops off the moment the player walks into a building (the
// cinematic fly-over only makes sense over the overworld plot). The
// Instructions pill stays visible in every scene so a confused
// visitor can pull up the controls from anywhere.
function BottomToolbar({
  isVisitor,
  townName,
}: {
  isVisitor: boolean;
  townName: string | null;
}) {
  const [onOverworld, setOnOverworld] = useState(() =>
    getLocalScene() === "overworld",
  );
  useEffect(() => {
    setOnOverworld(getLocalScene() === "overworld");
    return onLocalSceneChange((scene) => {
      setOnOverworld(scene === "overworld");
    });
  }, []);
  return (
    <div
      className="pointer-events-auto absolute left-3 z-30 flex items-end gap-2"
      style={{ bottom: 40 }}
    >
      {isVisitor ? <BuildTownCta /> : null}
      <TownRadio />
      {onOverworld ? <FlyoverButton townName={townName} /> : null}
      <InstructionsButton />
    </div>
  );
}

// "? Instructions" pill — reopens the town instructions modal (auto-
// opened on load, dismissed by "Explore town"). Lives in every scene
// so the player can always pull up the controls, unlike the Flyover
// button which only makes sense on the overworld.
function InstructionsButton() {
  return (
    <HudButton
      onClick={() => ui.openInstructions()}
      aria-label="Open town instructions"
      title="What is this town? How do I play?"
      icon={<span aria-hidden className="font-mono text-[10px]">?</span>}
    >
      Instructions
    </HudButton>
  );
}

// "▶ Flyover" pill — opens the intro cinematic on click. Owns its own
// open/close flag instead of plumbing through the ui store so the
// overlay teardown stays local. Mounted next to TownRadio in the
// bottom-left toolbar.
function FlyoverButton({ townName }: { townName: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <HudButton
        onClick={() => setOpen(true)}
        aria-label="Play town flyover"
        title="Play the town flyover intro"
        icon={<span aria-hidden className="font-mono text-[10px]">▶</span>}
      >
        Flyover
      </HudButton>
      {open ? (
        <Flyover townName={townName} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}

// Top-right pill: 🛎 + count. Renders nothing when count = 0 so the corner
// stays quiet until the butler actually has something to propose. Uses
// the CORE blue accent so it pops out of the dark pill row.
function SuggestionsBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <HudButton
      onClick={() => ui.openSuggestions()}
      style={{ background: PALETTE.h240 }}
      title="Open suggestions"
      aria-label={`${count} suggestion${count === 1 ? "" : "s"} waiting`}
      icon={<span aria-hidden>🛎</span>}
    >
      {count === 1 ? "1 suggestion" : `${count} suggestions`}
    </HudButton>
  );
}
