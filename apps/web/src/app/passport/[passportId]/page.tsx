// /passport/[passportId] — public passport page.
//
// Anyone can view a passport by its public id (e.g. TP-2026-000042).
// Renders the full SVG spread(s) + a Download PDF button + rich OG tags
// so a pasted link previews as a proper social card. Case-insensitive.

import type { Metadata } from "next";
import { cookies, headers } from "next/headers";
import { notFound } from "next/navigation";

import { loadPassportDataByPassportId } from "@/lib/passport/load";
import { renderPreview } from "@/lib/passport/render";
import { InfoPageShell } from "@/ui/InfoPageShell";

export const dynamic = "force-dynamic";

type Params = { passportId: string };

async function absoluteOrigin(): Promise<string> {
  const hdrs = await headers();
  const host = hdrs.get("x-forwarded-host") ?? hdrs.get("host") ?? "town.getcore.me";
  const proto =
    hdrs.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { passportId } = await params;
  const data = await loadPassportDataByPassportId(passportId);
  if (!data) return {};

  const origin = await absoluteOrigin();
  const canonical = `${origin}/passport/${data.passportId}`;
  const image = `${origin}/passport/${data.passportId}/og.png`;

  const title = `${data.displayName} · Town Passport`;
  const stampCount = data.stamps.length;
  const stampLine = `${stampCount} stamp${stampCount === 1 ? "" : "s"} · ${data.townsOwned} town${data.townsOwned === 1 ? "" : "s"} owned`;
  const description = `${data.passportId} · ${stampLine}. See the towns ${data.displayName} has been to on Town.`;

  return {
    title: `${data.displayName}'s Passport`,
    description,
    openGraph: {
      title,
      description,
      type: "profile",
      url: canonical,
      images: [{ url: image, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [image],
    },
    alternates: { canonical },
  };
}

export default async function PublicPassportPage({
  params,
}: {
  params: Promise<Params>;
}) {
  const { passportId } = await params;
  const data = await loadPassportDataByPassportId(passportId);
  if (!data) notFound();

  const svg = renderPreview(data);
  const stampCount = data.stamps.length;

  // If the viewer isn't the passport owner, hide the "your provisional
  // guest passport" nudge — this page is about the passport in the URL,
  // not the viewer's own state. The dropdown still surfaces their own.
  const jar = await cookies();
  const viewerHasSession = jar.get("core-town:sid") != null;

  return (
    <InfoPageShell
      title={`${data.displayName}'s Passport`}
      subtitle={`${stampCount} stamp${stampCount === 1 ? "" : "s"} · ${data.passportId}`}
      maxWidth="4xl"
    >
      <div className="flex items-center justify-end gap-2">
        <a
          href={`/passport/${data.passportId}/pdf`}
          className="border-2 border-paper/30 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10"
          download
        >
          Download PDF
        </a>
      </div>
      <div
        className="mt-4 overflow-hidden rounded"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      {!viewerHasSession ? (
        <p className="mt-6 text-xs font-bold uppercase tracking-wider text-paper/50">
          Sign in with CORE to start your own passport.
        </p>
      ) : null}
    </InfoPageShell>
  );
}
