"use client";

import { useState } from "react";

// Shared "how to create a town" content. Towns are scaffolded from the
// CLI so users authoring next to their editor get the same workflow as
// any other deploy artifact.
//
// Rendered as a full-page card on `/` when a signed-in user has no
// town yet, and as a modal body from the identity dropdown's "+ New
// town" entry.
const STEPS: Array<{ label: string; cmd: string }> = [
  { label: "Install the CLI", cmd: "npm install -g @redplanethq/town" },
  { label: "Authenticate", cmd: "town login" },
  { label: "Create your town", cmd: "town new <name>" },
];

export function NewTownInstructions({
  variant = "modal",
}: {
  variant?: "modal" | "page";
}) {
  const [copied, setCopied] = useState<number | null>(null);

  function copy(idx: number, cmd: string) {
    void navigator.clipboard.writeText(cmd).then(() => {
      setCopied(idx);
      setTimeout(() => setCopied((current) => (current === idx ? null : current)), 1500);
    });
  }

  const isModal = variant === "modal";
  const labelClass = isModal
    ? "text-xs font-bold uppercase tracking-wide text-paper/60"
    : "text-xs font-bold uppercase tracking-wide text-ink opacity-60";
  const rowClass = isModal
    ? "flex items-center justify-between gap-2 border-2 border-paper/20 bg-black/30 px-3 py-2"
    : "flex items-center justify-between gap-2 border-2 border-ink/20 bg-paper px-3 py-2";
  const cmdClass = isModal
    ? "truncate font-mono text-sm font-bold text-paper"
    : "truncate font-mono text-sm font-bold text-ink";
  const copyClass = isModal
    ? "text-xs font-bold uppercase tracking-wide text-paper/60 hover:text-paper"
    : "text-xs font-bold uppercase tracking-wide text-ink/60 hover:text-ink";

  return (
    <div className="flex flex-col gap-3">
      {STEPS.map((step, idx) => (
        <div key={step.cmd} className="flex flex-col gap-1">
          <span className={labelClass}>
            {idx + 1}. {step.label}
          </span>
          <div className={rowClass}>
            <code className={cmdClass}>{step.cmd}</code>
            <button
              type="button"
              onClick={() => copy(idx, step.cmd)}
              className={copyClass}
            >
              {copied === idx ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
