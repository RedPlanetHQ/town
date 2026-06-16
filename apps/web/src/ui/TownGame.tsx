"use client";

import { useEffect, useRef, useState } from "react";
import { bootGame, type GameContext } from "../game/boot";
import { BootScreen } from "./BootScreen";
import { refreshSession } from "../game/auth";
import { startInboxPoller } from "../game/inbox";
import { startNowPlayingPoller } from "../game/spotify";
import { startSuggestionsPoller } from "../game/suggestions";
import { startWorkspaceSync } from "../game/workspace";
import { setViewerTownSlug } from "../game/plotClient";
import { setPlayerCharacter } from "../game/character";
import {
  startRealtime,
  getRemotePlayers,
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
import { Tasks } from "./Tasks";
import { Dialogue } from "./Dialogue";
import { Chat } from "./Chat";
import { NowPlaying } from "./NowPlaying";
import { Invite } from "./Invite";
import { ShareImage } from "./ShareImage";
import { Suggestions } from "./Suggestions";
import { Dm } from "./Dm";
import { RemoteCards } from "./RemoteCards";
import { VisitorHud } from "./VisitorHud";
import { PALETTE } from "../game/config";
import { ui } from "./store";

// The mount point: a canvas owned by React, populated by kaplay in useEffect,
// and a sibling overlay layer for the React-rendered UI (HUD, prompt, panels).
//
// `viewerMode` switches the page between owner-mode (full feature set) and
// visitor-mode (read-only canvas of someone else's town):
//   • owner    — what was here before. Boots pollers + own-plot fetch.
//   • visitor  — points plotClient at /api/plot?town=<slug>, skips the
//                owner-only pollers (inbox / spotify / workspace).
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
    tasks,
    dialogue,
    chat,
    inbox,
    nowPlaying,
    invite,
    shareImage,
    proximity,
    dm,
    suggestions,
    worldReady,
  } = useUiState();

  const isVisitor = props.viewerMode === "visitor";

  useEffect(() => {
    if (!canvasRef.current) return;
    if (ctxRef.current) return;

    // Route plot fetches + pick the player sprite BEFORE the scene mounts.
    if (isVisitor) {
      const v = props as { townSlug: string; visitorCharacter: string };
      setViewerTownSlug(v.townSlug);
      setPlayerCharacter(v.visitorCharacter);
    } else {
      const o = props as { ownerCharacter?: string };
      setViewerTownSlug(null);
      setPlayerCharacter(o.ownerCharacter ?? OWNER_DEFAULT_CHARACTER);
    }

    ctxRef.current = bootGame(canvasRef.current);

    if (isVisitor) {
      // Visitor: skip owner-scoped pollers, but still join the realtime
      // bus so they see (and are seen by) the owner + other visitors.
      const slug = (props as { townSlug: string }).townSlug;
      let visitorRt: RealtimeHandle | null = null;
      void startRealtime({ slug }).then((handle) => {
        visitorRt = handle;
      });
      const stopPending = startPendingPoller(slug);
      return () => {
        visitorRt?.stop();
        stopPending();
        ctxRef.current = null;
      };
    }

    void refreshSession();
    const stopInbox = startInboxPoller();
    const stopWorkspace = startWorkspaceSync();
    const stopNowPlaying = startNowPlayingPoller();
    const stopSuggestions = startSuggestionsPoller();

    let rt: RealtimeHandle | null = null;
    let stopPending: (() => void) | null = null;
    const ownerSlug = (props as { townSlug?: string }).townSlug;
    if (ownerSlug) {
      void startRealtime({ slug: ownerSlug }).then((handle) => {
        rt = handle;
      });
      stopPending = startPendingPoller(ownerSlug);
    }
    return () => {
      stopInbox();
      stopWorkspace();
      stopNowPlaying();
      stopSuggestions();
      rt?.stop();
      stopPending?.();
      ctxRef.current = null;
    };
  }, [isVisitor, props]);

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
    !!tasks ||
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
        className="absolute inset-0 h-full w-full focus:outline-none"
        style={{ imageRendering: "pixelated" }}
      />

      {/* React-rendered cards floating above each remote player. Picks
          up positions from kaplay via the projection helper. */}
      <RemoteCards canvasRef={canvasRef} />

      {/* HUD — owner-mode renders the identity badge; visitor-mode renders
          the "Visiting X" card. */}
      {isVisitor ? (
        <div className="pointer-events-auto absolute left-4 top-4 z-30">
          <VisitorHud
            townName={(props as { townName: string }).townName}
            visitorName={(props as { visitorName: string }).visitorName}
            townSlug={(props as { townSlug: string }).townSlug}
          />
        </div>
      ) : hud ? (
        <div className="pointer-events-auto absolute left-4 top-4 z-30">
          <Hud hud={hud} inbox={inbox} />
        </div>
      ) : null}

      {/* Top-right stack. Population badge sits on top for both owner +
          visitor — it's a shared "how busy is this town" signal. Owner
          also gets Suggestions + NowPlaying below it. */}
      <div className="pointer-events-auto absolute right-4 top-4 z-30 flex flex-col items-end gap-2">
        <PopulationBadge
          ownerParticipantKey={
            isVisitor
              ? (props as { ownerParticipantKey: string }).ownerParticipantKey
              : null
          }
          alwaysShow={isVisitor}
        />
        {!isVisitor ? (
          <>
            <SuggestionsBadge count={suggestions.count} />
            <NowPlaying state={nowPlaying} />
          </>
        ) : null}
      </div>

      {prompt ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-8 z-30 flex justify-center">
          <InteractionPrompt prompt={prompt} />
        </div>
      ) : proximity ? (
        // Bottom-center prompt for the closest nearby player. Same vocab
        // as the building-interaction prompts so SPACE always means the
        // same thing visually.
        <div className="pointer-events-none absolute inset-x-0 bottom-8 z-30 flex justify-center">
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
      {tasks ? <Tasks /> : null}
      {dialogue ? <Dialogue dialogue={dialogue} /> : null}
      {chat ? <Chat chat={chat} /> : null}
      {!isVisitor && invite ? <Invite /> : null}
      {!isVisitor && shareImage ? <ShareImage /> : null}
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

      {/* Bottom-right CTA — visitor only. Pitches the invitee on
          building their own town; opens town.getcore.me in a new tab
          so they don't lose their current visit. */}
      {isVisitor ? (
        <div className="pointer-events-auto absolute right-4 bottom-4 z-30">
          <BuildYourOwnTownCta />
        </div>
      ) : null}

      {bootVisible ? (
        <BootScreen
          ready={worldReady}
          onDone={() => setBootVisible(false)}
        />
      ) : null}
    </div>
  );
}

// Top-right "Population: N" card. Counts every remote player the realtime
// bus knows about plus the local viewer.
//
// Visitor mode passes `ownerParticipantKey` + `alwaysShow=true` so the
// invitee always sees the card and, when the owner isn't currently in
// town, an "owner away" tag underneath the count. Owner mode passes
// `null` + `alwaysShow=false` so the card stays hidden until at least
// one *other* person joins.
function PopulationBadge({
  ownerParticipantKey,
  alwaysShow,
}: {
  ownerParticipantKey: string | null;
  alwaysShow: boolean;
}) {
  const [remotes, setRemotes] = useState(() => getRemotePlayers());
  useEffect(() => {
    const update = () => setRemotes(getRemotePlayers());
    update();
    return onRemotesChange(update);
  }, []);
  const remoteCount = remotes.length;
  if (!alwaysShow && remoteCount < 1) return null;
  const total = remoteCount + 1;
  const ownerAway =
    !!ownerParticipantKey &&
    !remotes.some((r) => r.participantKey === ownerParticipantKey);
  return (
    <div
      className="nb-card flex flex-col items-end gap-1 px-3 py-2"
      style={{ background: "#ffffff" }}
      aria-label={`Population: ${total}${ownerAway ? ", owner not in town" : ""}`}
      title={
        ownerAway
          ? `${total} in town · owner isn't here right now`
          : `${total} people in this town`
      }
    >
      <span className="text-[12px] font-bold leading-tight text-ink">
        Population: {total}
      </span>
      {ownerAway ? (
        <span className="text-[10px] font-bold uppercase leading-tight tracking-wide text-ink opacity-60">
          Owner not in town
        </span>
      ) : null}
    </div>
  );
}

// Bottom-right "Build your own town" CTA shown only on visitor view.
// Opens town.getcore.me in a new tab so the invitee can start their
// own town without losing the visit they're already in.
function BuildYourOwnTownCta() {
  return (
    <a
      href="https://town.getcore.me"
      target="_blank"
      rel="noopener noreferrer"
      className="nb-card flex items-center gap-2 px-3 py-1 text-left"
      style={{ background: "#ffffff" }}
      title="Start your own town at town.getcore.me"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/town_logo_dark.svg"
        alt=""
        aria-hidden
        className="h-4 w-4 shrink-0"
      />
      <span className="text-[12px] font-bold leading-tight text-ink">
        Build your own town
      </span>
    </a>
  );
}

// Top-right pill: 🛎 + count. Renders nothing when count = 0 so the corner
// stays quiet until the butler actually has something to propose.
function SuggestionsBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <button
      type="button"
      onClick={() => ui.openSuggestions()}
      className="nb-card flex items-center gap-2 px-3 py-2 text-left"
      style={{ background: PALETTE.h240, color: "var(--ink)" }}
      title="Open suggestions"
      aria-label={`${count} suggestion${count === 1 ? "" : "s"} waiting`}
    >
      <span aria-hidden className="text-base leading-none">
        🛎
      </span>
      <span className="text-[12px] font-bold leading-tight">
        {count === 1 ? "1 suggestion" : `${count} suggestions`}
      </span>
    </button>
  );
}
