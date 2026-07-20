"use client";

// In-chat "Share access" control. Lets a signed-in visitor lend
// this NPC their OWN CORE integrations, so the NPC can act on the visitor's
// accounts during the conversation. Self-contained: renders its own button
// in the chat header and an anchored popover; no game/store wiring.
//
// Visibility & flow:
//   • On open it reads GET /api/npcs/<id>/visitor-access:
//       needed    = integrations this NPC is configured to use
//       connected = which of those the visitor has connected in CORE
//       granted   = what they've already shared
//       signedIn  = whether the caller has a CORE session
//   • No `needed` → the NPC uses no integrations → render nothing.
//   • Anonymous guest (signedIn=false) → the button sends them through CORE
//     sign-in first (granting needs their own account).
//   • Signed-in → popover lists only the integrations the visitor has
//     connected in CORE, each as a toggle; Save persists via PUT (unchecking
//     + Save revokes). If none of the NPC's integrations are connected, an
//     empty state names what the NPC uses so they know what to connect.

import { useCallback, useEffect, useRef, useState } from "react";

import { startLogin } from "../game/auth";

interface ConnectedIntegration {
  slug: string;
  name: string;
  integration_account_id: string;
}

interface AccessData {
  needed: string[];
  connected: ConnectedIntegration[];
  granted: string[];
  signedIn: boolean;
  isOwner: boolean;
  warning?: string;
}

export function VisitorAccess({
  npcId,
  townSlug,
}: {
  npcId: string;
  townSlug: string | null;
}) {
  const [data, setData] = useState<AccessData | null>(null);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/npcs/${encodeURIComponent(npcId)}/visitor-access`,
      );
      if (!res.ok) return;
      const d = (await res.json()) as AccessData;
      setData(d);
      setSelected(new Set(d.granted));
    } catch (error) {
      // Best-effort: on any failure the button just stays hidden.
    }
  }, [npcId]);

  // One read on mount to decide whether the button even shows.
  useEffect(() => {
    void load();
  }, [load]);

  // Close the popover on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  // No button for the town owner (they grant via mdx), or when the NPC
  // declares no integrations.
  if (!data || data.isOwner || data.needed.length === 0) return null;

  const connectedBySlug = new Map(data.connected.map((c) => [c.slug, c]));

  const onButtonClick = () => {
    if (!data.signedIn) {
      // Granting needs the visitor's own CORE account.
      startLogin(townSlug ? `/${townSlug}` : "/");
      return;
    }
    setOpen((o) => !o);
    setSaved(false);
    void load(); // refresh connected/granted each open
  };

  const toggle = (slug: string) => {
    if (!connectedBySlug.has(slug)) return; // only grantable rows toggle
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
    setSaved(false);
  };

  const save = async () => {
    setBusy(true);
    try {
      const res = await fetch(
        `/api/npcs/${encodeURIComponent(npcId)}/visitor-access`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ slugs: [...selected] }),
        },
      );
      if (res.ok) {
        const d = (await res.json()) as { granted?: string[] };
        setSelected(new Set(d.granted ?? []));
        setSaved(true);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={onButtonClick}
        className="border border-white/15 px-2 py-1 text-[11px] font-bold uppercase tracking-wider text-paper/70 hover:text-paper"
        title="Let this character use your connected tools"
      >
        Share access{data.granted.length > 0 ? ` (${data.granted.length})` : ""}
      </button>

      {open ? (
        <div className="absolute right-0 top-full z-50 mt-2 w-72 border border-white/15 bg-[#0e1116] p-3 text-paper shadow-xl">
          <div className="text-[13px] font-black">Share your tools</div>
          <div className="mt-1 text-[11px] leading-snug text-paper/60">
            Let {"this character"} act on your own connected accounts while you
            chat. You can revoke anytime.
          </div>

          {data.connected.length === 0 ? (
            // Nothing the NPC uses is connected on the visitor's side. Show a
            // plain message (not disabled checkboxes) and, as a hint, name the
            // integrations the NPC uses so they know what to connect in CORE.
            <div className="mt-3 text-[11px] leading-snug text-paper/60">
              You have no connected tools that this character can use.
              {data.needed.length > 0 ? (
                <>
                  {" "}
                  Connect any of{" "}
                  <span className="text-paper/80">
                    {data.needed.join(", ")}
                  </span>{" "}
                  in CORE, then reopen this to share it.
                </>
              ) : null}
            </div>
          ) : (
            <>
              <div className="mt-3 flex flex-col gap-2">
                {data.connected.map((conn) => {
                  const checked = selected.has(conn.slug);
                  return (
                    <label
                      key={conn.slug}
                      className="flex cursor-pointer items-center gap-2"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={checked}
                        onChange={() => toggle(conn.slug)}
                      />
                      <span className="text-[12px] font-bold">{conn.name}</span>
                    </label>
                  );
                })}
              </div>

              <div className="mt-3 flex items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save()}
                  className="border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide hover:bg-white/20"
                >
                  {busy ? "Saving…" : saved ? "Saved ✓" : "Save"}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}
