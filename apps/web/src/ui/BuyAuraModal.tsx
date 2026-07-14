"use client";

// Small modal for buying an aura top-up for a specific town. Renders
// three fixed tiers; clicking one POSTs to the checkout API and
// redirects the browser to Stripe.

import { useEffect, useState } from "react";

const TIERS = [
  { cents: 500,  aura: 5000  },
  { cents: 1000, aura: 10000 },
  { cents: 2500, aura: 25000 },
];

export function BuyAuraModal({
  townSlug,
  townName,
  onClose,
}: {
  townSlug: string;
  townName: string;
  onClose: () => void;
}) {
  const [busyCents, setBusyCents] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function pick(cents: number) {
    setBusyCents(cents);
    setError(null);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "aura_pack", townSlug, amountCents: cents }),
      });
      if (!res.ok) {
        setError(`Failed to start checkout (${res.status})`);
        setBusyCents(null);
        return;
      }
      const body = (await res.json()) as { url?: string };
      if (!body.url) {
        setError("No checkout URL returned");
        setBusyCents(null);
        return;
      }
      window.location.href = body.url;
    } catch {
      setError("Network error — try again?");
      setBusyCents(null);
    }
  }

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
              Buy aura
            </div>
            <h2 className="mt-1 text-2xl font-black leading-tight text-paper">
              Top up {townName}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="border-2 border-paper/30 px-2 py-1 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10"
            aria-label="Close"
          >
            ESC
          </button>
        </div>

        <p className="text-sm font-bold text-paper/80">
          Aura top-ups add to your town's current aura above the regen cap.
          Spend it however you want — regen keeps refilling to your base
          pool in the background.
        </p>

        <div className="flex flex-col gap-2">
          {TIERS.map((t) => {
            const busy = busyCents === t.cents;
            return (
              <button
                key={t.cents}
                type="button"
                disabled={busyCents !== null}
                onClick={() => pick(t.cents)}
                className="flex items-center justify-between border-2 border-paper/30 px-4 py-3 text-left text-sm font-bold uppercase tracking-wider text-paper hover:bg-white/10 disabled:opacity-40"
              >
                <span>
                  {t.aura.toLocaleString()} aura
                </span>
                <span className="font-mono normal-case tracking-normal text-paper/70">
                  {busy ? "…" : `$${(t.cents / 100).toFixed(0)}`}
                </span>
              </button>
            );
          })}
        </div>

        {error ? (
          <div className="border-2 border-red-500/50 bg-red-500/10 px-3 py-2 text-xs font-bold uppercase tracking-wider text-red-200">
            {error}
          </div>
        ) : null}
      </div>
    </div>
  );
}
