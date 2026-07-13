"use client";

import { useEffect, useRef, useState } from "react";

import { getPlayerCharacter } from "../game/character";
import { logout, startLogin } from "../game/auth";
import { CharacterAvatar } from "./CharacterAvatar";
import { HudButton } from "./HudButton";
import { NewTownInstructions } from "./NewTownInstructions";
import { ui } from "./store";
import type { HudKind } from "./store";

// Identity pill (overworld) or room name card (interior).
// Click the identity pill to open a small dropdown with Invite / Share /
// Switch town / Logout.
export function Hud({
  hud,
  activeSlug,
}: {
  hud: HudKind;
  activeSlug: string | null;
}) {
  if (hud.kind === "overworld") {
    const session = hud.session;
    const name = session?.user.name ?? "Guest";
    const character = getPlayerCharacter();

    if (!session) {
      // Guest — small dropdown with Passport + Sign in with CORE.
      return <GuestMenu name={name} character={character} />;
    }

    return (
      <IdentityMenu
        name={name}
        character={character}
        activeSlug={activeSlug}
      />
    );
  }

  // interior — title pill, accent stripe on the left.
  return (
    <HudButton
      icon={
        <span
          aria-hidden
          className="inline-block h-3 w-1.5"
          style={{ background: hud.accent }}
        />
      }
      title="Walk to door to leave"
    >
      {hud.title}
    </HudButton>
  );
}

// Click-to-open dropdown on the identity pill. Actions: Invite (URL +
// code modal), Share (screenshot + Twitter/WhatsApp/Download modal),
// Switch town (submenu flyout listing owned towns + new-town entry),
// and Logout. Closes on outside click + on Escape.
function IdentityMenu({
  name,
  character,
  activeSlug,
}: {
  name: string;
  character: string;
  activeSlug: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [showNewModal, setShowNewModal] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <HudButton
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Open menu"
        active={open}
        icon={<CharacterAvatar character={character} seed={name} size={20} />}
      >
        {name}
      </HudButton>
      {open ? (
        <div
          role="menu"
          className="nb-card-dark absolute left-0 top-full z-40 mt-1 flex min-w-[180px] flex-col p-1"
        >
          <button
            type="button"
            role="menuitem"
            className="w-full px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/5"
            onClick={() => {
              setOpen(false);
              ui.openInvite();
            }}
          >
            Invite…
          </button>
          <button
            type="button"
            role="menuitem"
            className="w-full px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/5"
            onClick={() => {
              setOpen(false);
              ui.openShareImage();
            }}
          >
            Share…
          </button>
          <a
            role="menuitem"
            href="/passport"
            className="w-full px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/5"
            onClick={() => setOpen(false)}
          >
            Passport…
          </a>
          <SwitchTownItem
            activeSlug={activeSlug}
            onPick={() => setOpen(false)}
            onNewTown={() => {
              setOpen(false);
              setShowNewModal(true);
            }}
          />
          {activeSlug ? (
            <VisibilityToggleItem
              activeSlug={activeSlug}
              onDone={() => setOpen(false)}
            />
          ) : null}
          <a
            role="menuitem"
            href="/explore"
            className="w-full px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/5"
            onClick={() => setOpen(false)}
          >
            Browse towns…
          </a>
          <button
            type="button"
            role="menuitem"
            className="w-full px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/5"
            onClick={() => {
              setOpen(false);
              void logout().then(() => {
                window.location.href = "/";
              });
            }}
          >
            Logout
          </button>
        </div>
      ) : null}
      {showNewModal ? (
        <NewTownModal onClose={() => setShowNewModal(false)} />
      ) : null}
    </div>
  );
}

// Guest identity pill dropdown — smaller menu than IdentityMenu, only
// Passport (provisional) + Sign in with CORE. Guests can still download
// their provisional passport as a PDF.
function GuestMenu({
  name,
  character,
}: {
  name: string;
  character: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onPointer(e: PointerEvent) {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative inline-flex">
      <HudButton
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Open menu"
        active={open}
        icon={<CharacterAvatar character={character} seed={name} size={20} />}
      >
        {name}
      </HudButton>
      {open ? (
        <div
          role="menu"
          className="nb-card-dark absolute left-0 top-full z-40 mt-1 flex min-w-[200px] flex-col p-1"
        >
          <a
            role="menuitem"
            href="/passport"
            className="w-full px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/5"
            onClick={() => setOpen(false)}
          >
            Passport…
          </a>
          <button
            type="button"
            role="menuitem"
            className="w-full px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/5"
            onClick={() => {
              setOpen(false);
              startLogin(window.location.pathname);
            }}
          >
            Sign in with CORE…
          </button>
        </div>
      ) : null}
    </div>
  );
}

// "Switch town ›" — hovering or clicking the row opens a flyout to the
// right with every town the signed-in owner owns plus a "+ New town"
// entry. Mirrors the CORE workspace-switcher pattern.
type TownEntry = {
  id: string;
  slug: string;
  name: string;
  aura: { current: number; max: number };
};

type TownsMineResponse = {
  towns: TownEntry[];
  activeSlug: string | null;
};

function SwitchTownItem({
  activeSlug,
  onPick,
  onNewTown,
}: {
  activeSlug: string | null;
  onPick: () => void;
  onNewTown: () => void;
}) {
  const [hover, setHover] = useState(false);
  const [towns, setTowns] = useState<TownEntry[] | null>(null);

  useEffect(() => {
    if (!hover || towns) return;
    let cancelled = false;
    void fetch("/api/towns/mine", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: TownsMineResponse | null) => {
        if (cancelled) return;
        setTowns(data?.towns ?? []);
      })
      .catch(() => {
        if (!cancelled) setTowns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [hover, towns]);

  return (
    <div
      role="menuitem"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      className="relative"
    >
      <div
        className={`flex w-full items-center justify-between px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-paper ${
          hover ? "bg-white/5" : ""
        }`}
      >
        <span>Switch town</span>
        <span aria-hidden className="opacity-60">›</span>
      </div>
      {hover ? (
        <div
          role="menu"
          className="nb-card-dark absolute left-full top-0 z-50 ml-1 flex min-w-[220px] flex-col p-1"
        >
          {towns === null ? (
            <div className="px-2.5 py-1.5 text-xs font-bold uppercase tracking-wider text-paper/50">
              Loading…
            </div>
          ) : towns.length === 0 ? (
            <div className="px-2.5 py-1.5 text-xs font-bold uppercase tracking-wider text-paper/50">
              No other towns
            </div>
          ) : (
            towns.map((t) => {
              const isActive = t.slug === activeSlug;
              return (
                // Plain <a> (not next/link) so switching town does a
                // full document load. The town view holds module-level
                // caches (NPCs, realtime remotes, plot client state) +
                // a kaplay GL context that aren't worth tearing down
                // and rebuilding in-place when the user is asking for
                // a different town entirely.
                <a
                  key={t.id}
                  href={`/${t.slug}`}
                  onClick={onPick}
                  className={`flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/5 ${
                    isActive ? "bg-white/5" : ""
                  }`}
                >
                  <span className="truncate">{t.name}</span>
                  <span className="flex items-center gap-2 text-paper/50">
                    <span className="font-mono normal-case tracking-normal">
                      {t.aura.current}/{t.aura.max}
                    </span>
                    {isActive ? (
                      <span aria-hidden className="text-paper">✓</span>
                    ) : null}
                  </span>
                </a>
              );
            })
          )}
          <div className="my-1 border-t border-paper/15" />
          <button
            type="button"
            role="menuitem"
            className="w-full px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/5"
            onClick={onNewTown}
          >
            + New town
          </button>
        </div>
      ) : null}
    </div>
  );
}

// "Make public / Make private" — flips Town.isPublic via PATCH
// /api/towns/[slug]/visibility. Public towns appear on /explore and
// their share code is embedded in the row link so anyone can enter
// without knowing it up front. Fetches the current flag lazily on
// mount so the label matches server state.
function VisibilityToggleItem({
  activeSlug,
  onDone,
}: {
  activeSlug: string;
  onDone: () => void;
}) {
  const [isPublic, setIsPublic] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch(`/api/towns/${activeSlug}/visibility`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { isPublic?: boolean } | null) => {
        if (cancelled) return;
        if (data && typeof data.isPublic === "boolean") setIsPublic(data.isPublic);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [activeSlug]);

  async function toggle() {
    if (isPublic === null || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/towns/${activeSlug}/visibility`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isPublic: !isPublic }),
      });
      if (res.ok) {
        const body = (await res.json()) as { isPublic: boolean };
        setIsPublic(body.isPublic);
      }
    } finally {
      setBusy(false);
      onDone();
    }
  }

  const label =
    isPublic === null
      ? "Loading…"
      : isPublic
        ? "Make private"
        : "Publish to /explore…";

  return (
    <button
      type="button"
      role="menuitem"
      disabled={isPublic === null || busy}
      className="w-full px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/5 disabled:opacity-50"
      onClick={() => void toggle()}
    >
      {label}
    </button>
  );
}

function NewTownModal({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="nb-card-dark flex w-full max-w-md flex-col gap-4 p-6">
        <div className="flex items-start justify-between gap-3 border-b-2 border-paper/15 pb-3">
          <div>
            <div className="text-xs font-bold uppercase tracking-wide text-paper/60">
              New town
            </div>
            <h2 className="mt-1 text-2xl font-black leading-tight text-paper">
              Create another town
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="border-2 border-paper/30 px-2 py-1 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10"
            aria-label="Close new town"
          >
            ESC
          </button>
        </div>
        <p className="text-sm font-bold text-paper/80">
          Towns are created from the CLI so you can keep authoring next
          to your editor.
        </p>
        <NewTownInstructions variant="modal" />
      </div>
    </div>
  );
}
