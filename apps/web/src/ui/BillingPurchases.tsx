"use client";

// Dashboard-side purchase entry points. Two buttons at the top of the
// Billing card: Buy town slot (direct, fixed price) and Buy aura
// (opens a modal that picks which town + tier).
//
// Aura tiers are bulk-discounted — bigger buys give more aura per
// dollar. The server keeps the source of truth (checkout API rejects
// anything not in its allowlist), so this copy is presentation only.

import { useEffect, useState } from "react";

import { Select } from "./Select";

const TIERS = [
  { cents:  500, aura:  100 }, // $5  →  100 aura
  { cents: 1000, aura:  500 }, // $10 →  500 aura
  { cents: 1500, aura: 1000 }, // $15 → 1000 aura
];

// Per-town permanent cap upgrade.
const UPGRADES = [
  { cents: 5000, newMax: 10000 }, // $50 → 10,000 max
];

export interface DashboardTown {
  slug: string;
  name: string;
}

export function BillingPurchases({ towns }: { towns: DashboardTown[] }) {
  const [showAura, setShowAura] = useState(false);
  const [busySlot, setBusySlot] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function buyTownSlot() {
    setBusySlot(true);
    setError(null);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent: "town_slot" }),
      });
      if (!res.ok) {
        setError(`Failed to start checkout (${res.status})`);
        return;
      }
      const body = (await res.json()) as { url?: string };
      if (body.url) {
        window.location.href = body.url;
        return;
      }
      setError("No checkout URL");
    } finally {
      setBusySlot(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={towns.length === 0}
          onClick={() => setShowAura(true)}
          className="border-2 border-paper/30 px-3 py-1.5 text-xs font-bold uppercase tracking-wider hover:bg-white/10 disabled:opacity-40"
        >
          Buy aura…
        </button>
        <button
          type="button"
          disabled={busySlot}
          onClick={() => void buyTownSlot()}
          className="border-2 border-paper/30 px-3 py-1.5 text-xs font-bold uppercase tracking-wider hover:bg-white/10 disabled:opacity-40"
        >
          {busySlot ? "Loading…" : "Buy town slot · $10"}
        </button>
      </div>
      {error ? (
        <div className="text-[10px] font-bold uppercase tracking-widest text-red-300">
          {error}
        </div>
      ) : null}
      {showAura ? (
        <BuyAuraModal towns={towns} onClose={() => setShowAura(false)} />
      ) : null}
    </div>
  );
}

function BuyAuraModal({
  towns,
  onClose,
}: {
  towns: DashboardTown[];
  onClose: () => void;
}) {
  const [townSlug, setTownSlug] = useState(towns[0]?.slug ?? "");
  const [busy, setBusy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function pick(intent: "aura_pack" | "aura_upgrade", cents: number) {
    if (!townSlug) return;
    setBusy(cents);
    setError(null);
    try {
      const res = await fetch("/api/stripe/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ intent, townSlug, amountCents: cents }),
      });
      if (!res.ok) {
        setError(`Failed to start checkout (${res.status})`);
        setBusy(null);
        return;
      }
      const body = (await res.json()) as { url?: string };
      if (!body.url) {
        setError("No checkout URL");
        setBusy(null);
        return;
      }
      window.location.href = body.url;
    } catch {
      setError("Network error — try again?");
      setBusy(null);
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
              Top up a town
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

        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-widest text-paper/50">
            Which town?
          </span>
          <Select
            value={townSlug}
            onChange={setTownSlug}
            disabled={busy !== null}
            ariaLabel="Which town to top up"
            options={towns.map((t) => ({
              value: t.slug,
              label: t.name,
              hint: `/${t.slug}`,
            }))}
          />
        </div>

        <div className="flex flex-col gap-1">
          <span className="text-[10px] font-bold uppercase tracking-widest text-paper/50">
            Top up (one-time burst above the cap)
          </span>
          <div className="flex flex-col gap-2">
            {TIERS.map((t) => {
              const isBusy = busy === t.cents;
              return (
                <button
                  key={t.cents}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void pick("aura_pack", t.cents)}
                  className="flex items-center justify-between border-2 border-paper/30 px-4 py-3 text-left text-sm font-bold uppercase tracking-wider text-paper hover:bg-white/10 disabled:opacity-40"
                >
                  <span>{t.aura.toLocaleString()} aura</span>
                  <span className="font-mono normal-case tracking-normal text-paper/70">
                    {isBusy ? "…" : `$${(t.cents / 100).toFixed(0)}`}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="border-t border-paper/15 pt-4">
          <div className="mb-1 text-[10px] font-bold uppercase tracking-widest text-paper/50">
            Upgrade the town&apos;s cap (permanent)
          </div>
          <div className="flex flex-col gap-2">
            {UPGRADES.map((u) => {
              const isBusy = busy === u.cents;
              return (
                <button
                  key={u.cents}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void pick("aura_upgrade", u.cents)}
                  className="flex items-center justify-between border-2 border-paper/30 px-4 py-3 text-left text-sm font-bold uppercase tracking-wider text-paper hover:bg-white/10 disabled:opacity-40"
                >
                  <span>Cap → {u.newMax.toLocaleString()}</span>
                  <span className="font-mono normal-case tracking-normal text-paper/70">
                    {isBusy ? "…" : `$${(u.cents / 100).toFixed(0)}`}
                  </span>
                </button>
              );
            })}
          </div>
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
