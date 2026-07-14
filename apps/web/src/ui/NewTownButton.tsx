"use client";

// Small client wrapper for the dashboard: a link-styled "+ New town"
// trigger that opens the shared `NewTownModal`. Keeps the modal state
// in a client leaf so the dashboard can stay a server component.

import { useState } from "react";

import { NewTownModal } from "./NewTownModal";

export function NewTownButton({
  className,
  children = "+ New town",
}: {
  className?: string;
  children?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "text-xs font-bold uppercase tracking-wider text-paper/70 hover:text-paper"
        }
      >
        {children}
      </button>
      {open ? <NewTownModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}
