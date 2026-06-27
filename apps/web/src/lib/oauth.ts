// CORE OAuth 2.0 (Authorization Code + PKCE) helpers.
//
// CORE's OAuth endpoints (see apps/webapp/app/routes/oauth.*.tsx):
//   GET  /oauth/authorize    — user-facing consent screen
//   POST /oauth/token        — code + verifier → { access_token, refresh_token, ... }
//   GET  /oauth/userinfo     — Bearer access_token → { sub, email, name, ... }
//
// We use the standard auth-code flow with PKCE and `state`. The browser
// never sees access tokens — they live in the Session row in Postgres.

import crypto from "node:crypto";

export type OAuthConfig = {
  base: string;          // e.g. https://app.getcore.me
  clientId: string;
  clientSecret: string;  // CORE issues confidential clients; we have a backend
  redirectUri: string;   // must match an entry on the registered OAuth client
  scope: string;         // comma-separated per CORE's parser, e.g. "profile,email,openid"
};

/** Public production base for the town frontend. Used as the default for
 *  any URL that has to round-trip through CORE (the OAuth `redirect_uri`)
 *  or back into a user-visible link (the post-login redirect). Without
 *  this default, an unset env var falls back to `req.url`, which in
 *  production behind a reverse proxy is the internal container URL
 *  (`http://web:3000` or worse, the dev `localhost:3000` baked into a
 *  local `.env`). That's why "I logged in and landed on localhost"
 *  happens. */
export const DEFAULT_PUBLIC_BASE_URL = "https://town.getcore.me";

export function getPublicBaseUrl(): string {
  const v = process.env.PUBLIC_BASE_URL?.trim();
  return (v && v.length > 0 ? v : DEFAULT_PUBLIC_BASE_URL).replace(/\/$/, "");
}

export function getOAuthConfig(): OAuthConfig {
  const base = required("CORE_OAUTH_BASE");
  return {
    base: base.replace(/\/$/, ""),
    clientId: required("CORE_OAUTH_CLIENT_ID"),
    clientSecret: required("CORE_OAUTH_CLIENT_SECRET"),
    // Falls back to the public base + the standard callback path so a
    // missing env var lands users back on the production host instead
    // of localhost:3000 (the previous behaviour when `.env` was forgotten
    // in deploy). Override via CORE_OAUTH_REDIRECT_URI when running in
    // a different environment (staging, preview, etc.).
    redirectUri:
      process.env.CORE_OAUTH_REDIRECT_URI?.trim() ||
      `${getPublicBaseUrl()}/api/auth/callback`,
    scope: process.env.CORE_OAUTH_SCOPE ?? "profile,email,openid",
  };
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

// PKCE: code_verifier is a high-entropy random string; code_challenge is
// SHA-256(code_verifier) base64url-encoded. CORE validates challenge ↔
// verifier when we exchange the auth code.
export function generatePkcePair(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = base64url(crypto.randomBytes(64));
  const hash = crypto.createHash("sha256").update(codeVerifier).digest();
  const codeChallenge = base64url(hash);
  return { codeVerifier, codeChallenge };
}

export function generateState(): string {
  return base64url(crypto.randomBytes(32));
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export type TokenResponse = {
  access_token: string;
  token_type: string;
  expires_in?: number;          // seconds
  refresh_token?: string;
  refresh_expires_in?: number;
  scope?: string;
  id_token?: string;
};

export async function exchangeCodeForTokens(
  cfg: OAuthConfig,
  code: string,
  codeVerifier: string,
): Promise<TokenResponse> {
  const res = await fetch(`${cfg.base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `CORE /oauth/token ${res.status}: ${await safeText(res)}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

export async function refreshAccessToken(
  cfg: OAuthConfig,
  refreshToken: string,
): Promise<TokenResponse> {
  const res = await fetch(`${cfg.base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  if (!res.ok) {
    throw new Error(
      `CORE /oauth/token (refresh) ${res.status}: ${await safeText(res)}`,
    );
  }
  return (await res.json()) as TokenResponse;
}

export type UserInfo = {
  sub: string;          // stable CORE user id
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  // NOTE: CORE's /oauth/userinfo intentionally does NOT include
  // workspace_id — it's a minimal OIDC endpoint. We fetch the
  // workspace separately via fetchMe() below. The field is kept on
  // this type only as a defensive optional for any callers that read
  // older logs.
  workspace_id?: string;
};

export async function fetchUserInfo(
  cfg: OAuthConfig,
  accessToken: string,
): Promise<UserInfo> {
  const res = await fetch(`${cfg.base}/oauth/userinfo`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `CORE /oauth/userinfo ${res.status}: ${await safeText(res)}`,
    );
  }
  return (await res.json()) as UserInfo;
}

// /api/v1/me — the authenticated "current user" endpoint. Returns the
// caller's workspace_id (an OAuth token is workspace-scoped at issue
// time; this endpoint reads it off the auth context). Used by the
// OAuth callback to learn the workspace since /oauth/userinfo omits it.
export type CoreMe = {
  id: string;
  email?: string | null;
  name?: string | null;
  workspaceId?: string | null;
};

export async function fetchMe(
  cfg: OAuthConfig,
  accessToken: string,
): Promise<CoreMe> {
  const res = await fetch(`${cfg.base}/api/v1/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `CORE /api/v1/me ${res.status}: ${await safeText(res)}`,
    );
  }
  return (await res.json()) as CoreMe;
}

export function buildAuthorizeUrl(
  cfg: OAuthConfig,
  state: string,
  codeChallenge: string,
): string {
  const url = new URL(`${cfg.base}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("scope", cfg.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}
