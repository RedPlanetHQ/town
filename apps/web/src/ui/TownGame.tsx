"use client";

import { useEffect, useRef, useState } from "react";
import { bootGame, type GameContext } from "../game/boot";
import { BootScreen } from "./BootScreen";
import { refreshSession } from "../game/auth";
import { startSuggestionsPoller } from "../game/suggestions";
import { startWorkspaceSync } from "../game/workspace";
import { startNpcsSync, getNpcCount, onNpcsChange, refreshNpcs } from "../game/npcs";
import { setOwnerTownSlug, setViewerTownSlug } from "../game/plotClient";
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
import { PopulationPopover, type Aura } from "./PopulationPopover";
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
    }
  | {
      viewerMode: "visitor";
      townSlug: string;
      townName: string;
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
        style={{ imageRendering: "pixelated" }}
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
  // Fetch aura once on mount, then refresh on a long interval so the
  // hourly cron tick eventually surfaces without a page reload. We
  // don't poll fast — the meter only moves ±50/hour from the cron and
  // by TURN_COST during owner creator turns, neither of which need
  // sub-minute latency.
  useEffect(() => {
    if (!townSlug) {
      setAura(null);
      return;
    }
    let cancelled = false;
    const url = `/api/towns/${encodeURIComponent(townSlug)}/aura`;
    const fetchOnce = async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as Aura;
        if (!cancelled) setAura({ current: body.current, max: body.max });
      } catch {
        // Network blip — keep the last value.
      }
    };
    void fetchOnce();
    const id = window.setInterval(fetchOnce, 5 * 60 * 1000);
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

// Left-side bottom toolbar: BuildTownCta (visitors) + Town Radio +
// Flyover. Subscribes to scene changes so the Flyover button drops
// off the moment the player walks into a building (the cinematic
// fly-over only makes sense over the overworld plot).
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
    </div>
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
