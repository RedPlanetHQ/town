"use client";

// NPC Access panel — owner-only editor for which CORE integrations each
// NPC may use during chat. Renders as a HudButton ("ACCESS") in
// TownGame's top-right owner row, opening a right-side drawer styled
// after Suggestions.tsx. Owns its own open/close state rather than
// going through ui/store.ts — nothing in the game engine needs it.
//
// Talks only to Town routes (browser never holds CORE tokens):
// GET /api/npcs?town= for the roster, GET/PUT
// /api/npcs/<id>/permissions for grants (permissions normalised
// server-side), and ...?actions_for=<accountId> to lazy-load one
// integration's action list. Grant shape mirrors NpcPermissions
// (lib/npc-templates.ts): absent = no access, {slug} = all actions,
// {slug, actions} = whitelist, owner_only = visitor-invisible.

import { useCallback, useEffect, useState } from "react";

import { HudButton } from "./HudButton";

interface NpcRow {
  id: string;
  name: string;
  description: string;
}

interface AvailableIntegration {
  integration_account_id: string;
  slug: string;
  name: string;
}

interface IntegrationGrant {
  slug: string;
  actions?: string[];
  owner_only?: boolean;
}

// Local editable copy of the full permissions blob. Non-integration keys
// (core / skills / town) are carried through untouched on save so this
// panel can't accidentally strip memory_search or award grants.
type PermissionsBlob = Record<string, unknown> & {
  integrations?: IntegrationGrant[];
};

interface ActionInfo {
  name: string;
  description: string;
}

export function NpcAccess({ townSlug }: { townSlug: string }) {
  const [open, setOpen] = useState(false);
  const [npcs, setNpcs] = useState<NpcRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [perms, setPerms] = useState<PermissionsBlob | null>(null);
  const [available, setAvailable] = useState<AvailableIntegration[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [actionsCache, setActionsCache] = useState<
    Record<string, ActionInfo[]>
  >({});
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  // Close on Escape — same affordance as Suggestions.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  // Roster loads once per open; stale-on-reopen is fine (rosters change
  // via deploy/suggestions, not mid-session).
  useEffect(() => {
    if (!open) return;
    void fetch(`/api/npcs?town=${encodeURIComponent(townSlug)}`)
      .then((r) => r.json())
      .then((d: { npcs?: NpcRow[] }) => setNpcs(d.npcs ?? []))
      .catch(() => setNpcs([]));
  }, [open, townSlug]);

  const loadNpc = useCallback((id: string) => {
    setSelected(id);
    setPerms(null);
    setExpanded(null);
    setSaved(false);
    setWarning(null);
    void fetch(`/api/npcs/${encodeURIComponent(id)}/permissions`)
      .then((r) => r.json())
      .then(
        (d: {
          permissions?: PermissionsBlob;
          available?: AvailableIntegration[];
          warning?: string;
        }) => {
          setPerms(d.permissions ?? {});
          setAvailable(d.available ?? []);
          if (d.warning) setWarning(d.warning);
        },
      )
      .catch(() => setWarning("load-failed"));
  }, []);

  const grantFor = (slug: string): IntegrationGrant | undefined =>
    perms?.integrations?.find((g) => g.slug === slug);

  const mutateGrants = (
    fn: (list: IntegrationGrant[]) => IntegrationGrant[],
  ) => {
    setPerms((p) => (p ? { ...p, integrations: fn(p.integrations ?? []) } : p));
    setSaved(false);
  };

  const toggleIntegration = (slug: string) => {
    mutateGrants((list) =>
      list.some((g) => g.slug === slug)
        ? list.filter((g) => g.slug !== slug)
        : // New grants default to owner_only — the safe posture for
          // write-capable integrations. The owner opts INTO visitor
          // access per integration, not out of it.
          [...list, { slug, owner_only: true }],
    );
  };

  const toggleOwnerOnly = (slug: string) => {
    mutateGrants((list) =>
      list.map((g) =>
        g.slug === slug ? { ...g, owner_only: !g.owner_only } : g,
      ),
    );
  };

  const toggleAction = (slug: string, action: string, all: ActionInfo[]) => {
    mutateGrants((list) =>
      list.map((g) => {
        if (g.slug !== slug) return g;
        // `actions` undefined = level-1 "all actions". First uncheck
        // materialises the full list minus the toggled one; re-checking
        // everything collapses back to undefined (level 1).
        const current = g.actions ?? all.map((a) => a.name);
        const next = current.includes(action)
          ? current.filter((a) => a !== action)
          : [...current, action];
        const isAll = all.every((a) => next.includes(a.name));
        const { actions: _drop, ...rest } = g;
        return isAll ? rest : { ...rest, actions: next };
      }),
    );
  };

  const expandActions = (accountId: string) => {
    setExpanded((e) => (e === accountId ? null : accountId));
    if (actionsCache[accountId] || !selected) return;
    void fetch(
      `/api/npcs/${encodeURIComponent(selected)}/permissions?actions_for=${encodeURIComponent(accountId)}`,
    )
      .then((r) => r.json())
      .then((d: { actions?: ActionInfo[] }) =>
        setActionsCache((c) => ({ ...c, [accountId]: d.actions ?? [] })),
      )
      .catch(() => setActionsCache((c) => ({ ...c, [accountId]: [] })));
  };

  const save = async () => {
    if (!selected || !perms) return;
    setBusy(true);
    try {
      const res = await fetch(
        `/api/npcs/${encodeURIComponent(selected)}/permissions`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ permissions: perms }),
        },
      );
      if (res.ok) {
        const d = (await res.json()) as { permissions?: PermissionsBlob };
        // Adopt the server-normalised blob so the panel shows exactly
        // what will gate the next chat (dropped keys disappear here).
        if (d.permissions) setPerms(d.permissions);
        setSaved(true);
      } else {
        setWarning(`save-${res.status}`);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <HudButton onClick={() => setOpen(true)} title="NPC tool access">
        ACCESS
      </HudButton>

      {open ? (
        <>
          {/* Click-outside scrim — same idea as Suggestions, but `fixed`
              instead of `absolute`: this component mounts inside the
              top-right HUD row (an absolutely-positioned flex strip), so
              `absolute inset-0` would resolve against that tiny row and
              clip the drawer to a sliver. Panel.tsx sets the precedent
              for fixed overlays. */}
          <div
            className="fixed inset-0 z-40 bg-black/20"
            onClick={() => setOpen(false)}
          />
          <aside
            className="nb-card pointer-events-auto fixed right-0 top-0 z-50 flex h-full w-100 flex-col gap-3 overflow-y-auto p-4"
            style={{ borderRadius: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-center justify-between">
              <div>
                <div className="text-base font-black leading-tight text-ink">
                  NPC access
                </div>
                <div className="text-[11px] leading-tight text-ink opacity-60">
                  Grant your connected CORE tools to characters.
                </div>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="nb-card px-2 py-1 text-sm font-bold text-ink"
                title="Close (Esc)"
              >
                ×
              </button>
            </header>

            {/* NPC picker */}
            <div className="flex flex-wrap gap-1.5">
              {npcs.map((n) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => loadNpc(n.id)}
                  className={`nb-card px-2 py-1 text-xs font-bold text-ink ${
                    selected === n.id ? "" : "opacity-60 hover:opacity-100"
                  }`}
                >
                  {n.name}
                </button>
              ))}
              {npcs.length === 0 ? (
                <div className="text-xs text-ink opacity-60">No NPCs yet.</div>
              ) : null}
            </div>

            {warning ? (
              <div className="text-[11px] font-bold text-ink opacity-70">
                ⚠{" "}
                {warning === "core-unavailable"
                  ? "CORE session unavailable — showing stored grants read-only."
                  : `Something went wrong (${warning}).`}
              </div>
            ) : null}

            {/* Integration grants for the selected NPC */}
            {selected && perms ? (
              <div className="flex flex-col gap-2">
                {available.length === 0 && !warning ? (
                  <div className="text-xs text-ink opacity-60">
                    No integrations connected in CORE yet — connect one at
                    Settings → MCP Integrations in CORE, then reopen this panel.
                  </div>
                ) : null}
                {available.map((integ) => {
                  const grant = grantFor(integ.slug);
                  const actions = actionsCache[integ.integration_account_id];
                  return (
                    <div
                      key={integ.integration_account_id}
                      className="nb-card p-2"
                    >
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2 text-sm font-bold text-ink">
                          <input
                            type="checkbox"
                            checked={!!grant}
                            onChange={() => toggleIntegration(integ.slug)}
                          />
                          {integ.name}
                          <span className="text-[10px] font-normal opacity-50">
                            {integ.slug}
                          </span>
                        </label>
                        {grant ? (
                          <button
                            type="button"
                            className="text-[11px] font-bold text-ink underline opacity-70 hover:opacity-100"
                            onClick={() =>
                              expandActions(integ.integration_account_id)
                            }
                          >
                            {grant.actions
                              ? `${grant.actions.length} actions`
                              : "all actions"}
                          </button>
                        ) : null}
                      </div>

                      {grant ? (
                        <label className="mt-1 flex items-center gap-2 text-[11px] text-ink opacity-80">
                          <input
                            type="checkbox"
                            checked={!!grant.owner_only}
                            onChange={() => toggleOwnerOnly(integ.slug)}
                          />
                          Owner only - visitors chatting with this NPC can’t
                          trigger it
                        </label>
                      ) : null}

                      {grant && expanded === integ.integration_account_id ? (
                        <div className="mt-2 flex max-h-48 flex-col gap-1 overflow-y-auto border-t border-black/20 pt-2">
                          {!actions ? (
                            <div className="text-[11px] text-ink opacity-60">
                              Loading actions…
                            </div>
                          ) : actions.length === 0 ? (
                            <div className="text-[11px] text-ink opacity-60">
                              Couldn’t load this integration’s actions.
                            </div>
                          ) : (
                            actions.map((a) => {
                              const checked = grant.actions
                                ? grant.actions.includes(a.name)
                                : true;
                              return (
                                <label
                                  key={a.name}
                                  className="flex items-start gap-2 text-[11px] leading-snug text-ink"
                                  title={a.description}
                                >
                                  <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={() =>
                                      toggleAction(integ.slug, a.name, actions)
                                    }
                                  />
                                  <span className="font-mono">{a.name}</span>
                                </label>
                              );
                            })
                          )}
                        </div>
                      ) : null}
                    </div>
                  );
                })}

                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void save()}
                  className="nb-button self-end px-3 py-1.5 text-sm font-bold"
                >
                  {busy ? "Saving…" : saved ? "Saved ✓" : "Save"}
                </button>
              </div>
            ) : selected ? (
              <div className="text-xs text-ink opacity-60">Loading…</div>
            ) : (
              <div className="text-xs text-ink opacity-60">
                Pick a character to manage what they can reach.
              </div>
            )}
          </aside>
        </>
      ) : null}
    </>
  );
}
