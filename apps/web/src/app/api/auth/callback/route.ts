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
  fetchUserInfo,
  getOAuthConfig,
} from "@/lib/oauth";
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

  let info;
  try {
    info = await fetchUserInfo(cfg, tokens.access_token);
  } catch (e) {
    return redirectToError(req, errMessage(e));
  }

  if (!info.sub) {
    return redirectToError(req, "CORE userinfo missing sub");
  }

  const user = await prisma.user.upsert({
    where: { coreUserId: info.sub },
    create: {
      coreUserId: info.sub,
      email: info.email ?? "",
      name: info.name ?? info.preferred_username ?? "Traveler",
      workspaceId: info.workspace_id ?? null,
    },
    update: {
      email: info.email ?? undefined,
      name: info.name ?? info.preferred_username ?? undefined,
      workspaceId: info.workspace_id ?? undefined,
    },
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
  const target = new URL("/", req.url);
  target.searchParams.set("auth_error", message);
  return NextResponse.redirect(target);
}

function absolute(req: NextRequest, path: string) {
  return new URL(path.startsWith("/") ? path : `/${path}`, req.url);
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : "unknown error";
}
