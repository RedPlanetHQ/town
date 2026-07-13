// /passport — your Town passport. Identity page + collected stamps for
// every town you've visited (excluding your own). Server-rendered from
// PassportStamp + User; falls back to a "sign in" invitation when the
// caller has no session.

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import type { Metadata } from "next";

import { getSessionFromCookie } from "@/lib/session";
import { loadGuestPassportData, loadPassportData } from "@/lib/passport/load";
import { renderPreview } from "@/lib/passport/render";
import { CopyLinkButton } from "@/ui/CopyLinkButton";
import { InfoPageShell } from "@/ui/InfoPageShell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Passport",
  description: "Your Town passport — a page for every town you've visited.",
};

export default async function PassportPage() {
  const session = await getSessionFromCookie();
  const data = session
    ? await loadPassportData(session.userId)
    : await loadGuestPassportData();

  if (!data) redirect("/");

  const svg = renderPreview(data);
  const stampCount = data.stamps.length;
  const isGuest = data.kind === "guest";

  // Public share URL — only meaningful for authed passports (guests don't
  // have a stable public id yet). Uses the same absolute-origin resolution
  // pattern as the /[town] page's OG tags.
  let shareUrl: string | null = null;
  if (!isGuest && data.passportId !== "TP-PENDING") {
    const hdrs = await headers();
    const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "town.getcore.me";
    const proto = hdrs.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
    shareUrl = `${proto}://${host}/passport/${data.passportId}`;
  }

  return (
    <InfoPageShell
      title="Passport"
      subtitle={`${stampCount} stamp${stampCount === 1 ? "" : "s"} · ${data.passportId}${isGuest ? " · provisional" : ""}`}
      maxWidth="4xl"
    >
      <div className="flex items-center justify-end gap-2">
        {shareUrl ? <CopyLinkButton href={shareUrl} /> : null}
        <a
          href="/api/passport/pdf"
          className="border-2 border-paper/30 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10"
          download
        >
          Download PDF
        </a>
      </div>
      <div
        className="mt-4 overflow-hidden rounded"
        // Renderer produces trusted SVG from server-side data. No user
        // input flows in unescaped — see esc() in lib/passport/render.ts.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </InfoPageShell>
  );
}
