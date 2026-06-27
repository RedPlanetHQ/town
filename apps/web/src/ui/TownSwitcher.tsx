// Top-left town switcher. Lists every town the signed-in owner has
// in this CORE workspace (the API list is implicitly workspace-
// scoped via the User row). The "+ New town" entry pops a modal
// that copies the `npx town new` CLI command.

"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type TownEntry = {
  id: string;
  slug: string;
  name: string;
  updatedAt: string;
  aura: { current: number; max: number };
};

type TownsMineResponse = {
  towns: TownEntry[];
  activeSlug: string | null;
};

export function TownSwitcher({ activeSlug }: { activeSlug: string }) {
  const [towns, setTowns] = useState<TownEntry[] | null>(null);
  const [open, setOpen] = useState(false);
  const [showModal, setShowModal] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (towns) return;
    fetch("/api/towns/mine", { credentials: "include" })
      .then((r) => r.json())
      .then((data: TownsMineResponse) => setTowns(data.towns))
      .catch(() => setTowns([]));
  }, [open, towns]);

  const active = towns?.find((t) => t.slug === activeSlug);

  return (
    <div className="relative text-sm">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-md bg-zinc-900/80 px-3 py-1.5 text-zinc-100 backdrop-blur hover:bg-zinc-900"
      >
        {active?.name ?? activeSlug}
        <span className="ml-2 opacity-60">{"▾"}</span>
      </button>
      {open && (
        <div className="mt-2 w-64 rounded-md bg-zinc-900/95 p-2 text-zinc-100 shadow-xl backdrop-blur">
          {towns === null && (
            <div className="px-2 py-1 text-zinc-400">Loading…</div>
          )}
          {towns?.map((t) => (
            <Link
              key={t.id}
              href={`/${t.slug}`}
              className={`block rounded px-2 py-1 hover:bg-zinc-800 ${
                t.slug === activeSlug ? "bg-zinc-800" : ""
              }`}
              onClick={() => setOpen(false)}
            >
              <div className="flex items-center justify-between">
                <span>{t.name}</span>
                <span className="text-xs text-zinc-400">
                  {t.aura.current} / {t.aura.max}
                </span>
              </div>
            </Link>
          ))}
          <div className="my-1 border-t border-zinc-700" />
          <button
            onClick={() => {
              setOpen(false);
              setShowModal(true);
            }}
            className="block w-full rounded px-2 py-1 text-left hover:bg-zinc-800"
          >
            + New town
          </button>
          <div className="mt-2 border-t border-zinc-700 pt-1 text-xs text-zinc-500">
            Log out to switch CORE workspace.
          </div>
        </div>
      )}
      {showModal && (
        <NewTownModal onClose={() => setShowModal(false)} />
      )}
    </div>
  );
}

function NewTownModal({ onClose }: { onClose: () => void }) {
  const cmd = "npx town new";
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      onClick={onClose}
    >
      <div
        className="w-[420px] rounded-lg bg-zinc-900 p-5 text-zinc-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Create a new town</h2>
        <p className="mt-2 text-sm text-zinc-300">
          Towns are created from the CLI to keep authoring close to
          your editor.
        </p>
        <div className="mt-3 flex items-center gap-2 rounded border border-zinc-700 bg-zinc-950 px-3 py-2 font-mono text-sm">
          <code className="flex-1">{cmd}</code>
          <button
            onClick={copy}
            className="rounded bg-zinc-800 px-2 py-1 text-xs hover:bg-zinc-700"
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
        <div className="mt-4 text-right">
          <button
            onClick={onClose}
            className="rounded bg-zinc-800 px-3 py-1.5 hover:bg-zinc-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
