// AES-256-GCM at rest for user LLM API keys.
//
// Master key comes from `BYOK_ENCRYPTION_KEY` — must be a 32-byte
// key encoded as 64 hex chars (e.g. `openssl rand -hex 32`). Rotating
// the master key requires re-encrypting existing rows; not automated
// yet — flag as a TODO if we need it.
//
// Stored ciphertext is `iv:tag:cipher`, all base64url. IV is a fresh
// 12-byte random per call, so the same plaintext key produces
// different ciphertexts every save.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_BYTES = 12;

function masterKey(): Buffer {
  const raw = process.env.BYOK_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "BYOK_ENCRYPTION_KEY is not set — generate one with `openssl rand -hex 32`",
    );
  }
  const buf = Buffer.from(raw.trim(), "hex");
  if (buf.length !== 32) {
    throw new Error(
      "BYOK_ENCRYPTION_KEY must decode to 32 bytes (64 hex chars)",
    );
  }
  return buf;
}

function b64u(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function unb64u(s: string): Buffer {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function encryptKey(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const cipherText = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${b64u(iv)}:${b64u(tag)}:${b64u(cipherText)}`;
}

export function decryptKey(payload: string): string {
  const parts = payload.split(":");
  if (parts.length !== 3) throw new Error("byok: malformed ciphertext");
  const [ivB64, tagB64, cipherB64] = parts;
  const iv = unb64u(ivB64!);
  const tag = unb64u(tagB64!);
  const cipher = unb64u(cipherB64!);
  const decipher = createDecipheriv(ALGO, masterKey(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(cipher), decipher.final()]);
  return plaintext.toString("utf8");
}

export function last4(apiKey: string): string {
  const trimmed = apiKey.trim();
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4);
}
