"use client";

// Client-side settings card for Bring-Your-Own-Key.
//
// Lists the three supported providers with a status pill and add/remove
// controls. Add opens a small inline form that POSTs the key to
// `/api/byok`; delete calls DELETE. The plaintext key is only ever in
// the input's ephemeral state; the response only echoes `last4` back.

import { useEffect, useState } from "react";

const PROVIDERS = [
  { id: "anthropic", label: "Anthropic" },
  { id: "openai",    label: "OpenAI" },
  { id: "ollama",    label: "Ollama Cloud" },
] as const;

type Provider = (typeof PROVIDERS)[number]["id"];

type KeyRow = { provider: Provider; last4: string; updatedAt: string };

export function BYOKSection() {
  const [keys, setKeys] = useState<Record<Provider, KeyRow | null>>({
    anthropic: null,
    openai:    null,
    ollama:    null,
  });
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh() {
    setLoading(true);
    try {
      const res = await fetch("/api/byok", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as { keys: KeyRow[] };
      const map: Record<Provider, KeyRow | null> = {
        anthropic: null, openai: null, ollama: null,
      };
      for (const k of body.keys) map[k.provider] = k;
      setKeys(map);
    } finally {
      setLoading(false);
    }
  }

  async function save(provider: Provider) {
    const value = draft.trim();
    if (value.length < 8) {
      setError("Key looks too short");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/byok", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, apiKey: value }),
      });
      if (!res.ok) {
        setError(`Save failed (${res.status})`);
        return;
      }
      setEditing(null);
      setDraft("");
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  async function remove(provider: Provider) {
    setBusy(true);
    try {
      await fetch("/api/byok", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      await refresh();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-2 border-paper/15 p-5">
      <div className="flex flex-col gap-1">
        <div className="text-xs font-bold uppercase tracking-widest text-paper/50">
          Settings
        </div>
        <div className="text-lg font-black">Model keys · BYOK</div>
        <p className="text-xs text-paper/70">
          Store your own OpenAI, Anthropic, or Ollama Cloud key. Chats
          that run against your key skip the aura debit entirely — you
          pay the provider directly.
        </p>
      </div>

      <div className="mt-4 flex flex-col gap-2">
        {PROVIDERS.map((p) => {
          const key = keys[p.id];
          const isEditing = editing === p.id;

          return (
            <div key={p.id} className="border border-paper/10">
              <div className="flex items-center justify-between gap-3 px-3 py-2">
                <div>
                  <div className="text-sm font-bold">{p.label}</div>
                  <div className="text-[10px] font-mono uppercase tracking-widest text-paper/50">
                    {loading
                      ? "Loading…"
                      : key
                        ? `Set · ends in ${key.last4}`
                        : "Not set"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {key ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => remove(p.id)}
                      className="border-2 border-paper/20 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-paper/70 hover:bg-white/5 disabled:opacity-40"
                    >
                      Remove
                    </button>
                  ) : null}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setEditing(isEditing ? null : p.id);
                      setDraft("");
                      setError(null);
                    }}
                    className="border-2 border-paper/30 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest hover:bg-white/10 disabled:opacity-40"
                  >
                    {key ? "Update" : "Add key"}
                  </button>
                </div>
              </div>

              {isEditing ? (
                <div className="flex flex-col gap-2 border-t border-paper/10 bg-white/5 px-3 py-3">
                  <input
                    type="password"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={
                      p.id === "anthropic"
                        ? "sk-ant-…"
                        : p.id === "openai"
                          ? "sk-…"
                          : "ollama_…"
                    }
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={busy}
                    className="w-full border-2 border-paper/30 bg-black px-2 py-1.5 font-mono text-xs text-paper placeholder-paper/30 focus:border-paper/60 focus:outline-none"
                  />
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[10px] text-paper/50">
                      Stored encrypted at rest. Only the last 4 chars are visible.
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setEditing(null);
                          setDraft("");
                          setError(null);
                        }}
                        className="border-2 border-paper/20 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest text-paper/70 hover:bg-white/5"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void save(p.id)}
                        className="border-2 border-paper/30 px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest hover:bg-white/10 disabled:opacity-40"
                      >
                        {busy ? "Saving…" : "Save"}
                      </button>
                    </div>
                  </div>
                  {error ? (
                    <div className="text-[10px] font-bold uppercase tracking-widest text-red-300">
                      {error}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
