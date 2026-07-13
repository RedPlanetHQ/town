"use client";

import { useState } from "react";

export function CopyLinkButton({ href, label = "Copy share link" }: { href: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(href);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          // clipboard denied — fall back to a select prompt
          window.prompt("Copy this link:", href);
        }
      }}
      className="border-2 border-paper/30 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10"
    >
      {copied ? "Copied ✓" : label}
    </button>
  );
}
