// CRUD around `ModelKey`. Store keeps the plaintext key out of the
// caller — encryption/decryption happens here.

import { prisma } from "@/lib/db";
import { decryptKey, encryptKey, last4 } from "./encryption";

export const BYOK_PROVIDERS = ["anthropic", "openai", "ollama"] as const;
export type BYOKProvider = (typeof BYOK_PROVIDERS)[number];

export function isBYOKProvider(s: string): s is BYOKProvider {
  return (BYOK_PROVIDERS as readonly string[]).includes(s);
}

export async function saveModelKey(
  userId: string,
  provider: BYOKProvider,
  apiKey: string,
): Promise<{ provider: BYOKProvider; last4: string }> {
  const trimmed = apiKey.trim();
  if (!trimmed) throw new Error("byok: empty key");
  const encryptedKey = encryptKey(trimmed);
  const tail = last4(trimmed);

  await prisma.modelKey.upsert({
    where: { userId_provider: { userId, provider } },
    create: { userId, provider, encryptedKey, last4: tail },
    update: { encryptedKey, last4: tail },
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

/** UI shape — the plaintext key never leaves the server. */
export async function listModelKeysForUser(userId: string): Promise<
  Array<{ provider: BYOKProvider; last4: string; updatedAt: Date }>
> {
  const rows = await prisma.modelKey.findMany({
    where: { userId },
    select: { provider: true, last4: true, updatedAt: true },
    orderBy: { provider: "asc" },
  });
  return rows.filter((r) => isBYOKProvider(r.provider)) as Array<{
    provider: BYOKProvider;
    last4: string;
    updatedAt: Date;
  }>;
}

/** Server-only helper: decrypts and returns the plaintext key for the
 *  given (user, provider), or `null` if none is stored. Called from the
 *  chat model resolver and never returned to the client. */
export async function getPlaintextModelKey(
  userId: string,
  provider: BYOKProvider,
): Promise<string | null> {
  const row = await prisma.modelKey.findUnique({
    where: { userId_provider: { userId, provider } },
    select: { encryptedKey: true },
  });
  if (!row) return null;
  try {
    return decryptKey(row.encryptedKey);
  } catch (err) {
    console.warn("[byok] decrypt failed for", userId, provider, err);
    return null;
  }
}

/** Pick the best BYOK key for a user given the platform's provider
 *  preference (LLM_PROVIDER env). Returns `null` when the user has no
 *  keys or Ollama-only (Ollama BYOK isn't wired into getChatModel yet).
 *  Called from chat routes to decide whether the town owner is
 *  self-paying this turn. */
export async function resolveByokForUser(
  userId: string,
): Promise<{ provider: BYOKProvider; apiKey: string } | null> {
  const [anthropicKey, openaiKey] = await Promise.all([
    getPlaintextModelKey(userId, "anthropic"),
    getPlaintextModelKey(userId, "openai"),
  ]);
  const explicit = (process.env.LLM_PROVIDER ?? "").toLowerCase().trim();
  if (explicit === "openai" && openaiKey) return { provider: "openai", apiKey: openaiKey };
  if (explicit === "anthropic" && anthropicKey) return { provider: "anthropic", apiKey: anthropicKey };
  if (anthropicKey) return { provider: "anthropic", apiKey: anthropicKey };
  if (openaiKey) return { provider: "openai", apiKey: openaiKey };
  return null;
}
