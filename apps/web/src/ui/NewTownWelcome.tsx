"use client";

import { logout } from "../game/auth";
import { NewTownInstructions } from "./NewTownInstructions";

// First-run welcome card — surfaced from app/page.tsx when a signed-in
// user has no Town row yet. Towns are created from the CLI now, so the
// browser just shows the three commands and a sign-out escape hatch.
export function NewTownWelcome({ userName }: { userName: string }) {
  const greeting = (userName ?? "").trim().split(/\s+/)[0] || "there";

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-wall p-6">
      <div className="nb-card flex w-full max-w-md flex-col gap-5 p-6">
        <div>
          <div className="text-xs font-bold uppercase tracking-wide text-ink opacity-60">
            Welcome, {greeting}
          </div>
          <h1 className="mt-1 text-2xl font-black leading-tight text-ink">
            Spin up your town from the CLI
          </h1>
          <p className="mt-2 text-sm text-ink opacity-70">
            Towns are built from the command line so you can edit them
            next to your editor. Run these three commands and you're
            live.
          </p>
        </div>

        <NewTownInstructions variant="page" />

        <div className="mt-1 flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              void logout().then(() => window.location.reload());
            }}
            className="text-xs font-bold uppercase tracking-wide text-ink opacity-60 hover:opacity-100"
          >
            Sign out
          </button>
          <span className="text-xs font-bold uppercase tracking-wide text-ink opacity-40">
            Stuck? Refresh after `town new`.
          </span>
        </div>
      </div>
    </div>
  );
}
