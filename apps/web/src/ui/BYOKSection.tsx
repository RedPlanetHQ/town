"use client";

// Client-side settings card for Bring-Your-Own-Key.
//
// Lists the three supported providers with a status pill and add/remove
// controls. Add opens a small inline form that POSTs the key to
// `/api/byok`; delete calls DELETE. The plaintext key is only ever in
// the input's ephemeral state; the response only echoes `last4` back.

import { useEffect, useState } from "react";

const PROVIDERS = [
  { id: "anthropic",    label: "Anthropic" },
  { id: "openai",       label: "OpenAI" },
  { id: "openai_proxy", label: "OpenAI Proxy" },
  { id: "ollama",       label: "Ollama Cloud" },
] as const;

type Provider = (typeof PROVIDERS)[number]["id"];

// Providers whose row exposes a baseUrl input alongside the key. On
// openai_proxy the URL is required; on ollama it defaults to
// https://ollama.com/v1 when omitted.
const BASEURL_CAPABLE: readonly Provider[] = ["openai_proxy", "ollama"];
function acceptsBaseUrl(p: Provider): boolean {
  return BASEURL_CAPABLE.includes(p);
}
function requiresBaseUrl(p: Provider): boolean {
  return p === "openai_proxy";
}

type KeyRow = {
  provider: Provider;
  last4: string;
  /** OpenAI only — user-configured proxy base URL. Null when unset. */
  baseUrl: string | null;
  /** OpenAI only — user-pinned model id (proxy routing key). Null when unset. */
  model: string | null;
  updatedAt: string;
};

export function BYOKSection() {
  const [keys, setKeys] = useState<Record<Provider, KeyRow | null>>({
    anthropic:    null,
    openai:       null,
    openai_proxy: null,
    ollama:       null,
  });
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Provider | null>(null);
  const [draft, setDraft] = useState("");
  // OpenAI-only proxy fields — captured alongside `draft` when the OpenAI
  // row is being edited; ignored for the other providers.
  const [draftBaseUrl, setDraftBaseUrl] = useState("");
  const [draftModel, setDraftModel] = useState("");
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
        anthropic: null, openai: null, openai_proxy: null, ollama: null,
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
    const baseUrl = acceptsBaseUrl(provider) ? draftBaseUrl.trim() : "";
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      setError("Base URL must start with http:// or https://");
      return;
    }
    if (requiresBaseUrl(provider) && !baseUrl) {
      setError("OpenAI Proxy requires a base URL");
      return;
    }
    const model = draftModel.trim();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/byok", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider,
          apiKey: value,
          // Server drops baseUrl for providers that don't accept it.
          // Model can be pinned on any provider.
          baseUrl: acceptsBaseUrl(provider) ? (baseUrl || null) : null,
          model: model || null,
        }),
      });
      if (!res.ok) {
        setError(`Save failed (${res.status})`);
        return;
      }
      setEditing(null);
      setDraft("");
      setDraftBaseUrl("");
      setDraftModel("");
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
          Bring your own model access. Four slots: Anthropic (direct),
          OpenAI (direct), OpenAI Proxy (LiteLLM / core-gateway / any
          OpenAI-compatible endpoint), and Ollama Cloud or a self-hosted
          daemon. Any chat that runs against your key skips the aura
          debit entirely — you pay the provider directly.
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
                  {key?.baseUrl || key?.model ? (
                    <div className="mt-1 flex flex-col gap-0.5 text-[10px] font-mono text-paper/40 normal-case tracking-normal">
                      {key.baseUrl ? <span>url · {key.baseUrl}</span> : null}
                      {key.model ? <span>model · {key.model}</span> : null}
                    </div>
                  ) : null}
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
                      const next = isEditing ? null : p.id;
                      setEditing(next);
                      setDraft("");
                      // Prefill proxy fields from the saved row when opening
                      // the OpenAI editor so the user can tweak just one
                      // field without retyping everything.
                      setDraftBaseUrl(
                        next && acceptsBaseUrl(next) ? key?.baseUrl ?? "" : "",
                      );
                      setDraftModel(next ? key?.model ?? "" : "");
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
                          : p.id === "openai_proxy"
                            ? "Proxy security key"
                            : "ollama_…"
                    }
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={busy}
                    className="w-full border-2 border-paper/30 bg-black px-2 py-1.5 font-mono text-xs text-paper placeholder-paper/30 focus:border-paper/60 focus:outline-none"
                  />
                  {acceptsBaseUrl(p.id) ? (
                    <input
                      type="text"
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={
                        p.id === "openai_proxy"
                          ? "Base URL (required) — e.g. https://your-proxy.example.com/v1"
                          : "Base URL (optional) — defaults to https://ollama.com/v1"
                      }
                      value={draftBaseUrl}
                      onChange={(e) => setDraftBaseUrl(e.target.value)}
                      disabled={busy}
                      className="w-full border-2 border-paper/30 bg-black px-2 py-1.5 font-mono text-xs text-paper placeholder-paper/30 focus:border-paper/60 focus:outline-none"
                    />
                  ) : null}
                  <input
                    type="text"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={
                      p.id === "anthropic"
                        ? "Model id (optional) — e.g. claude-opus-4-7"
                        : p.id === "openai"
                          ? "Model id (optional) — e.g. gpt-5.4-mini"
                          : p.id === "openai_proxy"
                            ? "Model id (optional) — e.g. claude-sonnet-4-6"
                            : "Model id (optional) — e.g. gpt-oss:120b-cloud"
                    }
                    value={draftModel}
                    onChange={(e) => setDraftModel(e.target.value)}
                    disabled={busy}
                    className="w-full border-2 border-paper/30 bg-black px-2 py-1.5 font-mono text-xs text-paper placeholder-paper/30 focus:border-paper/60 focus:outline-none"
                  />
                  <div className="text-[10px] text-paper/50">
                    {p.id === "anthropic" &&
                      "Uses api.anthropic.com. Pin a model to override the default."}
                    {p.id === "openai" &&
                      "Uses api.openai.com. Pin a model to override the default."}
                    {p.id === "openai_proxy" &&
                      "Sends the key to your proxy as the bearer token. The model id is your proxy's routing key."}
                    {p.id === "ollama" &&
                      "Defaults to Ollama Cloud. Set a base URL to point at a self-hosted daemon."}
                  </div>
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
                          setDraftBaseUrl("");
                          setDraftModel("");
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
