// CRUD around `ModelKey`. Store keeps the plaintext key out of the
// caller — encryption/decryption happens here.

import { prisma } from "@/lib/db";
import { decryptKey, encryptKey, last4 } from "./encryption";

// "openai_proxy" is stored as its own row because a user may want BOTH a
// direct api.openai.com key AND a proxy configured — they configure them
// separately in the UI and pick a winner via LLM_PROVIDER (or the natural
// preference chain in resolveByokForUser).
export const BYOK_PROVIDERS = [
  "anthropic",
  "openai",
  "openai_proxy",
  "ollama",
] as const;
export type BYOKProvider = (typeof BYOK_PROVIDERS)[number];

export function isBYOKProvider(s: string): s is BYOKProvider {
  return (BYOK_PROVIDERS as readonly string[]).includes(s);
}

/** Providers that accept a proxy `baseUrl`. Ollama and openai_proxy do by
 *  definition; anthropic/openai only accept the pinned `model` field. */
function proxyRequired(provider: BYOKProvider): boolean {
  return provider === "openai_proxy";
}
function proxyOptional(provider: BYOKProvider): boolean {
  return provider === "ollama";
}

export interface SaveModelKeyExtras {
  /** Proxy base URL for openai / anthropic (LiteLLM, core-gateway, etc.).
   *  Ignored for ollama (Ollama BYOK auth is per-request). Falsy/empty
   *  string clears the stored value. */
  baseUrl?: string | null;
  /** Pinned model id — proxy routing key when baseUrl is set, or a
   *  provider-native model override when it isn't. Ignored for ollama.
   *  Falsy/empty string clears. */
  model?: string | null;
}

export async function saveModelKey(
  userId: string,
  provider: BYOKProvider,
  apiKey: string,
  extras: SaveModelKeyExtras = {},
): Promise<{ provider: BYOKProvider; last4: string }> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("byok: empty key");

  const rawBaseUrl =
    typeof extras.baseUrl === "string" ? extras.baseUrl.trim() : "";
  const rawModel =
    typeof extras.model === "string" ? extras.model.trim() : "";

  // Enforce baseUrl requirement for openai_proxy — a proxy config with no
  // base URL is useless and would silently look identical to a direct
  // OpenAI key.
  if (proxyRequired(provider) && !rawBaseUrl) {
    throw new Error("byok: openai_proxy requires baseUrl");
  }

  // Only providers that accept baseUrl get to persist one. Everyone can
  // pin a model (anthropic / openai use it as a direct model override;
  // openai_proxy / ollama use it as the routing key).
  const acceptsBaseUrl = proxyRequired(provider) || proxyOptional(provider);
  const baseUrl = acceptsBaseUrl && rawBaseUrl ? rawBaseUrl : null;
  const model = rawModel || null;

  const encryptedKey = encryptKey(trimmed);
  const tail = last4(trimmed);

  await prisma.modelKey.upsert({
    where: { userId_provider: { userId, provider } },
    create: { userId, provider, encryptedKey, last4: tail, baseUrl, model },
    update: { encryptedKey, last4: tail, baseUrl, model },
  });
  return { provider, last4: tail };
}

export async function deleteModelKey(
  userId: string,
  provider: BYOKProvider,
): Promise<void> {
  await prisma.modelKey
    .delete({ where: { userId_provider: { userId, provider } } })
    .catch(() => {
      // no-op if the row didn't exist — DELETE is idempotent
    });
}

/** UI shape — the plaintext key never leaves the server. Returns
 *  baseUrl + model for the OpenAI row so the settings page can render the
 *  current proxy config; both are `null` when unset. */
export async function listModelKeysForUser(userId: string): Promise<
  Array<{
    provider: BYOKProvider;
    last4: string;
    baseUrl: string | null;
    model: string | null;
    updatedAt: Date;
  }>
> {
  const rows = await prisma.modelKey.findMany({
    where: { userId },
    select: {
      provider: true,
      last4: true,
      baseUrl: true,
      model: true,
      updatedAt: true,
    },
    orderBy: { provider: "asc" },
  });
  return rows.filter((r) => isBYOKProvider(r.provider)) as Array<{
    provider: BYOKProvider;
    last4: string;
    baseUrl: string | null;
    model: string | null;
    updatedAt: Date;
  }>;
}

export interface PlaintextKey {
  apiKey: string;
  /** Proxy base URL when the user configured one (openai / anthropic). */
  baseUrl: string | null;
  /** Pinned model id when the user set one (openai / anthropic). */
  model: string | null;
}

/** Server-only helper: decrypts and returns the plaintext key + optional
 *  proxy config for the given (user, provider), or `null` if none is
 *  stored. Called from the chat model resolver and never returned to the
 *  client. */
export async function getPlaintextModelKey(
  userId: string,
  provider: BYOKProvider,
): Promise<PlaintextKey | null> {
  const row = await prisma.modelKey.findUnique({
    where: { userId_provider: { userId, provider } },
    select: { encryptedKey: true, baseUrl: true, model: true },
  });
  if (!row) return null;
  try {
    return {
      apiKey: decryptKey(row.encryptedKey),
      baseUrl: row.baseUrl,
      model: row.model,
    };
  } catch (err) {
    console.warn("[byok] decrypt failed for", userId, provider, err);
    return null;
  }
}

export interface ResolvedByok {
  provider: BYOKProvider;
  apiKey: string;
  /** Set when the user configured a proxy for this provider. */
  baseUrl?: string | null;
  /** Set when the user pinned a specific model id. */
  model?: string | null;
}

/** Pick the best BYOK key for a user given the platform's provider
 *  preference (LLM_PROVIDER env). Returns `null` when the user has no
 *  keys. Called from chat routes to decide whether the town owner is
 *  self-paying this turn. */
export async function resolveByokForUser(
  userId: string,
): Promise<ResolvedByok | null> {
  const [anthropicKey, openaiKey, openaiProxyKey, ollamaKey] = await Promise.all([
    getPlaintextModelKey(userId, "anthropic"),
    getPlaintextModelKey(userId, "openai"),
    getPlaintextModelKey(userId, "openai_proxy"),
    getPlaintextModelKey(userId, "ollama"),
  ]);
  const toResolved = (
    provider: BYOKProvider,
    row: PlaintextKey,
  ): ResolvedByok => ({
    provider,
    apiKey: row.apiKey,
    baseUrl: row.baseUrl,
    model: row.model,
  });

  const explicit = (process.env.LLM_PROVIDER ?? "").toLowerCase().trim();

  // Explicit LLM_PROVIDER match wins if the corresponding key is stored.
  // For "openai" we prefer the proxy variant if configured — proxy is a
  // deliberate override; the direct openai row acts as a fallback.
  if (explicit === "openai" && openaiProxyKey)
    return toResolved("openai_proxy", openaiProxyKey);
  if (explicit === "openai" && openaiKey) return toResolved("openai", openaiKey);
  if (explicit === "anthropic" && anthropicKey)
    return toResolved("anthropic", anthropicKey);
  if (explicit === "ollama" && ollamaKey) return toResolved("ollama", ollamaKey);

  // No/unmatched explicit — anthropic first, then openai_proxy (if the
  // user configured one they clearly intended to use it), then plain
  // openai, then ollama.
  if (anthropicKey) return toResolved("anthropic", anthropicKey);
  if (openaiProxyKey) return toResolved("openai_proxy", openaiProxyKey);
  if (openaiKey) return toResolved("openai", openaiKey);
  if (ollamaKey) return toResolved("ollama", ollamaKey);
  return null;
}
