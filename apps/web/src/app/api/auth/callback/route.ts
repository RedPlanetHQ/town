// CORE redirects here with ?code=…&state=… after the user clicks Allow.
//
// We:
//   1. look up the OAuthState row for `state` (and delete it — single use)
//   2. exchange the code for tokens via PKCE
//   3. resolve the CORE user via /oauth/userinfo
//   4. upsert the User row keyed on `sub`
//   5. create a Session row holding the tokens
//   6. set the opaque session cookie and redirect back into the app

import { NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";

import { prisma } from "@/lib/db";
import {
  exchangeCodeForTokens,
  fetchMe,
  fetchUserInfo,
  getOAuthConfig,
  getPublicBaseUrl,
} from "@/lib/oauth";
import { ensurePassportId } from "@/lib/passport/id";
import { createSession, setSessionCookie } from "@/lib/session";

export async function GET(req: NextRequest) {
  const cfg = getOAuthConfig();
  const url = new URL(req.url);

  const error = url.searchParams.get("error");
  if (error) {
    const description =
      url.searchParams.get("error_description") ?? "unknown error";
    return redirectToError(req, `${error}: ${description}`);
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return redirectToError(req, "missing code or state");
  }

  // State is single-use. Pull it out first so a duplicate callback (back
  // button, retry) doesn't double-exchange the code.
  const stored = await prisma.oAuthState.findUnique({ where: { state } });
  if (!stored) return redirectToError(req, "invalid or expired state");
  await prisma.oAuthState.delete({ where: { state } }).catch(() => {});
  if (stored.expiresAt.getTime() < Date.now()) {
    return redirectToError(req, "state expired");
  }

  let tokens;
  try {
    tokens = await exchangeCodeForTokens(cfg, code, stored.codeVerifier);
  } catch (e) {
    return redirectToError(req, errMessage(e));
  }

  // /oauth/userinfo gives us {sub, email, name}; /api/v1/me gives us
  // workspaceId (the userinfo endpoint intentionally omits workspace
  // context). Fetch both in parallel.
  let info;
  let me;
  try {
    [info, me] = await Promise.all([
      fetchUserInfo(cfg, tokens.access_token),
      fetchMe(cfg, tokens.access_token),
    ]);
  } catch (e) {
    return redirectToError(req, errMessage(e));
  }

  if (!info.sub) {
    return redirectToError(req, "CORE userinfo missing sub");
  }

  const workspaceId = me.workspaceId ?? null;
  if (!workspaceId) {
    // No workspace on the CORE side — refuse to create a town-next
    // account rather than silently inserting a (coreUserId, NULL)
    // row that the composite unique can't deduplicate.
    return redirectToError(
      req,
      "CORE login is missing a workspace — open app.getcore.me, pick a workspace, then try again.",
    );
  }
  const email = info.email ?? me.email ?? "";
  const name = info.name ?? info.preferred_username ?? me.name ?? "Traveler";

  // One-shot grace: if a pre-migration row exists with workspaceId =
  // null for this coreUserId, adopt it instead of inserting a new
  // row. Fires until that row is filled, then becomes a no-op.
  let user;
  const legacy = await prisma.user.findFirst({
    where: { coreUserId: info.sub, workspaceId: null },
  });
  if (legacy) {
    user = await prisma.user.update({
      where: { id: legacy.id },
      data: { workspaceId, email, name },
    });
  } else {
    user = await prisma.user.upsert({
      where: {
        coreUserId_workspaceId: { coreUserId: info.sub, workspaceId },
      },
      create: { coreUserId: info.sub, workspaceId, email, name },
      update: { email, name },
    });
  }

  // Idempotent — assigns a passportId for brand-new users, and covers any
  // legacy row that somehow slipped past the backfill migration.
  await ensurePassportId(user.id).catch(() => {
    // A failure here shouldn't block sign-in; the /passport page falls
    // back to a TP-PENDING label and the next login retries.
  });

  const session = await createSession({ userId: user.id, tokens });
  await setSessionCookie(session.id);

  // Best-effort cleanup of any stale OAuthState rows. Cheap and only fires
  // on the human-rate path (login completion), so no need for a cron.
  await prisma.oAuthState
    .deleteMany({ where: { expiresAt: { lt: new Date() } } })
    .catch(() => {});

  // Bust both the Router Cache entry and the layout's RSC payload so
  // the post-redirect render reflects the new session immediately.
  // Without this, the previously-served guest page (rendered when the
  // user clicked Sign in) could be re-used after the redirect, hiding
  // the just-created onboarding screen until a hard refresh.
  const target = stored.redirectAfter ?? "/";
  try {
    revalidatePath(target, "page");
    revalidatePath(target, "layout");
  } catch {
    // revalidatePath is unavailable during edge contexts we don't
    // hit today; silently ignore so the login still completes.
  }

  return NextResponse.redirect(absolute(req, target));
}

function redirectToError(req: NextRequest, message: string) {
  const target = absolute(req, "/");
  target.searchParams.set("auth_error", message);
  return NextResponse.redirect(target);
}

/** Build an absolute URL for a post-callback redirect. We *deliberately
 *  don't* derive the host from `req.url` — in production behind a
 *  reverse proxy that value is the internal container URL (e.g.
 *  `http://web:3000`), which is exactly how users were ending up on
 *  localhost after a successful login. Public base lives in env (with a
 *  production default in oauth.ts), so the redirect always lands on a
 *  user-visible host. */
function absolute(_req: NextRequest, path: string) {
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return new URL(normalized, getPublicBaseUrl());
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : "unknown error";
}
