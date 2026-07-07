"use client";

import { startLogin } from "../game/auth";
import { PALETTE } from "../game/config";
import { LandingBackground } from "./LandingBackground";

const PUBLIC_TOWN_URL = "/core-town?invite_code=H4C0TZ";

// Unsigned-root landing surface. A non-interactive game-styled
// backdrop (tiled grass + trees) sits behind a "how this works"
// card that's the only way off the page:
//
//   • Own a town / Login — kicks off the OAuth flow.
//   • Explore CORE town — drops them into the public CORE town;
//     this is also what "see the demo" means for us now.
//
// We used to boot the full kaplay world here as a playground, but
// kept getting confused traffic ("is this my town?") — and the
// kaplay boot pulls in realtime/NPC sync just to render a backdrop.
// A static component is enough.
export function Landing() {
  return (
    <>
      <LandingBackground />
      <WelcomeCard />
    </>
  );
}

function WelcomeCard() {
  return (
    <div
      className="nb-modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="landing-welcome-title"
    >
      <div className="nb-modal-card nb-card-dark flex w-full max-w-sm flex-col gap-4 p-5">
        <div className="flex items-center gap-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/town_logo_light.svg"
            alt=""
            aria-hidden
            className="h-10 w-10 shrink-0"
            draggable={false}
          />
          <h1
            id="landing-welcome-title"
            className="text-lg leading-none text-paper"
            style={{ fontFamily: "var(--font-press-start-2p)" }}
          >
            Town
          </h1>
        </div>

        <p className="text-sm leading-relaxed text-paper/80">
          Your world, as a tiny pixel town that grows itself. The things you
          care about — fitness, films, art, the side project — turn into
          buildings, and locals show up to live in them. Friends wander, meet
          your locals — and learn who you are faster than any profile.
        </p>

        <div className="flex flex-col gap-1.5">
          <div className="text-xs font-bold uppercase tracking-wide text-paper/50">
            How it works
          </div>
          <ul className="flex flex-col gap-0.5 text-sm leading-relaxed text-paper/80">
            <li>
              <span className="font-bold text-paper">Move</span> with the arrow
              keys.
            </li>
            <li>
              <span className="font-bold text-paper">Press SPACE</span> at a
              person to chat.
            </li>
            <li>
              <span className="font-bold text-paper">Sign up</span> to start
              your own town.
            </li>
          </ul>
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => startLogin("/")}
            className="nb-tile px-3 py-2 text-xs font-black uppercase tracking-wide text-ink"
            style={{ background: PALETTE.h240, cursor: "pointer" }}
          >
            Own a town / Login
          </button>
          <a
            href={PUBLIC_TOWN_URL}
            className="nb-tile px-3 py-2 text-center text-xs font-black uppercase tracking-wide text-ink"
            style={{ background: PALETTE.h120, cursor: "pointer" }}
          >
            Explore CORE town
          </a>
          <a
            href="/explore"
            className="text-center text-[11px] font-bold uppercase tracking-widest text-paper/60 hover:text-paper"
          >
            Browse public towns →
          </a>
        </div>
      </div>
    </div>
  );
}
