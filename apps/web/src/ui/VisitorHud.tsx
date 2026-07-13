"use client";

import { useEffect, useRef, useState } from "react";

import { getPlayerCharacter } from "../game/character";
import { startLogin } from "../game/auth";
import { CharacterAvatar } from "./CharacterAvatar";
import { HudButton } from "./HudButton";

// HUD shown to a non-owner viewing /{slug}. The identity pill is a
// dropdown trigger: clicking it opens a small menu with Passport, Build
// your own town, and Sign in with CORE. Exit stays as a sibling pill so
// leaving the town is always one click away.
export function VisitorHud({
  townName,
  visitorName,
  townSlug,
}: {
  townName: string;
  visitorName: string;
  townSlug: string;
}) {
  const character = getPlayerCharacter();
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
    <>
      <div ref={rootRef} className="relative inline-flex">
        <HudButton
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          title={`Visiting ${townName}`}
          active={open}
          icon={<CharacterAvatar character={character} seed={visitorName} size={20} />}
        >
          Visiting {townName}
        </HudButton>
        {open ? (
          <div
            role="menu"
            className="nb-card-dark absolute left-0 top-full z-40 mt-1 flex min-w-[220px] flex-col p-1"
          >
            <a
              role="menuitem"
              href="/passport"
              className="w-full px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/5"
              onClick={() => setOpen(false)}
            >
              Passport…
            </a>
            <a
              role="menuitem"
              href="https://town.getcore.me"
              target="_blank"
              rel="noopener noreferrer"
              className="w-full px-2.5 py-1.5 text-left text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/5"
              onClick={() => setOpen(false)}
            >
              Build your own town…
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
      <HudButton href="/" title={`Leave ${townSlug}`}>
        Exit
      </HudButton>
    </>
  );
}
