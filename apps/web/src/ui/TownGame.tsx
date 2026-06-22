"use client";

import { useEffect, useRef, useState } from "react";
import { bootGame, type GameContext } from "../game/boot";
import { BootScreen } from "./BootScreen";
import { refreshSession } from "../game/auth";
import { startSuggestionsPoller } from "../game/suggestions";
import { startWorkspaceSync } from "../game/workspace";
import { startNpcsSync, getNpcCount, onNpcsChange } from "../game/npcs";
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
import { ActivityFeed } from "./ActivityFeed";
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
      setViewerTownSlug(null);
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
    const stopSuggestions = startSuggestionsPoller();

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
          up positions from kaplay via the projection helper. The town
          slug (owner or visitor mode resolves to the same string) lets
          RemoteCards poll the head-tag endpoint and stack pills above
          each player's name card. */}
      <RemoteCards canvasRef={canvasRef} townSlug={ownerSlug ?? visitorSlug} />

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
          <Hud hud={hud} />
        </div>
      ) : null}

      {/* Top-right stack. Population badge sits on top for both owner +
          visitor — it's a shared "how busy is this town" signal, and
          it now hosts the inline FEED toggle for the right-edge
          activity panel (only when a real town slug is in scope, not
          on the guest `/` playground). Owner gets Suggestions below
          it; visitors get the Items badge that self-hides when the
          inventory is empty. */}
      <div className="pointer-events-auto absolute right-4 top-4 z-30 flex flex-col items-end gap-2">
        <PopulationBadge
          ownerParticipantKey={
            isVisitor
              ? (props as { ownerParticipantKey: string }).ownerParticipantKey
              : null
          }
          showFeedToggle={!!(ownerSlug || visitorSlug)}
          feedOpen={!!feed}
        />
        {isVisitor ? (
          <ItemsBadge townSlug={(props as { townSlug: string }).townSlug} />
        ) : null}
        {!isVisitor ? <SuggestionsBadge count={suggestions.count} /> : null}
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

      {/* Group chat — non-modal Twitch-style overlay + floating [G]
          prompt. Both internally gate on `groupChatStore` state, which
          stays null until the player walks into a building whose
          `groupChatEnabled` flag is on. Deleting these two lines + the
          features/group-chat folder + the building flag removes the
          feature. */}
      <GroupChatPrompt />
      <GroupChatSurface />

      {/* Town activity feed (slide-in right panel). Only renders for
          real towns — the guest playground at / has no slug. */}
      {feed && (ownerSlug || visitorSlug) ? (
        <ActivityFeed townSlug={(ownerSlug ?? visitorSlug)!} />
      ) : null}

      {/* Bottom-left tile — combines the visitor pitch (only in visitor
          mode) with the always-on "Town from core" attribution into a
          single card. Sits left so the bottom-right corner stays clear
          for the group chat overlay and the 1-1 DM panel. */}
      <div className="pointer-events-auto absolute left-4 bottom-4 z-30">
        <BottomLeftCard showBuildCta={isVisitor} />
      </div>

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

// Top-right "Population: N | Feed" card. Counts every NPC the user has
// authored plus every remote player the realtime bus knows about plus
// the local viewer. The right half is an inline FEED toggle that opens
// the activity panel — packaged into the same card so the corner stays
// quiet (one tile instead of two). The Feed segment hides on the guest
// `/` playground where there's no slug to fetch against.
function PopulationBadge({
  ownerParticipantKey,
  showFeedToggle,
  feedOpen,
}: {
  ownerParticipantKey: string | null;
  showFeedToggle: boolean;
  feedOpen: boolean;
}) {
  const [remotes, setRemotes] = useState(() => getRemotePlayers());
  const [npcCount, setNpcCount] = useState(() => getNpcCount());
  useEffect(() => {
    const update = () => setRemotes(getRemotePlayers());
    update();
    return onRemotesChange(update);
  }, []);
  useEffect(() => {
    const update = () => setNpcCount(getNpcCount());
    update();
    return onNpcsChange(update);
  }, []);
  // remotes + NPCs + viewer themselves.
  const total = remotes.length + npcCount + 1;
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
          ? `${total} in town (NPCs + visitors) · owner isn't here right now`
          : `${total} in town — NPCs + visitors + you`
      }
    >
      <span className="flex items-center gap-2 text-[12px] font-bold leading-tight text-ink">
        <span>Population: {total}</span>
        {showFeedToggle ? (
          <>
            <span aria-hidden className="opacity-30">
              |
            </span>
            <button
              type="button"
              onClick={() => ui.toggleFeed()}
              aria-pressed={feedOpen}
              title={feedOpen ? "Hide activity feed" : "Show activity feed"}
              className="flex items-center gap-1 text-[12px] font-bold uppercase tracking-wider hover:opacity-70"
              style={{ color: feedOpen ? "#b58900" : "inherit" }}
            >
              Feed
            </button>
          </>
        ) : null}
      </span>
      {ownerAway ? (
        <span className="text-[10px] font-bold uppercase leading-tight tracking-wide text-ink opacity-60">
          Owner not in town
        </span>
      ) : null}
    </div>
  );
}

// Bottom-left card. Two segments inside one tile:
//   • Visitor pitch (visitor mode only): logo + "Build your own town"
//     opening town.getcore.me in a new tab.
//   • "Town from core" attribution — two open-source links — that's
//     ALWAYS shown so credit travels with every deployed instance.
// Owners see just the attribution row.
function BottomLeftCard({ showBuildCta }: { showBuildCta: boolean }) {
  return (
    <div
      className="nb-card flex flex-col items-start"
      style={{ background: "#ffffff" }}
      title="Open-source projects from RedPlanet HQ"
    >
      {showBuildCta ? (
        <a
          href="https://town.getcore.me"
          target="_blank"
          rel="noopener noreferrer"
          className="flex w-full items-center gap-2 px-3 py-2 hover:bg-black/5"
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
      ) : null}
      <div
        className={
          "px-3 py-2 text-[12px] font-bold leading-tight text-ink" +
          (showBuildCta ? " border-t border-ink/10 opacity-80" : "")
        }
      >
        <a
          href="https://github.com/redplanethq/town"
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-2 hover:underline"
        >
          Town
        </a>
        <span className="mx-1 opacity-60">from</span>
        <a
          href="https://github.com/redplanethq/core"
          target="_blank"
          rel="noopener noreferrer"
          className="underline-offset-2 hover:underline"
        >
          core
        </a>
      </div>
    </div>
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
