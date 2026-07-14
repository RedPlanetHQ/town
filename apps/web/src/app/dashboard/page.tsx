// /dashboard — landing surface for signed-in players.
//
// Custom shell (not `InfoPageShell`) so we can host a proper top nav
// with the logo + Explore + GitHub links, and grow sections for
// passport, towns, settings (BYOK), and billing without fighting the
// simpler info-page template.

import { redirect } from "next/navigation";
import type { Metadata } from "next";

import { prisma } from "@/lib/db";
import { loadPassportData } from "@/lib/passport/load";
import { renderSpread, spreadCountFor } from "@/lib/passport/render";
import { isPricingEnabled } from "@/lib/pricing";
import { getSessionFromCookie } from "@/lib/session";
import { getTownsByOwner } from "@/lib/town";
import { BillingPurchases } from "@/ui/BillingPurchases";
import { BYOKSection } from "@/ui/BYOKSection";
import { CopyLinkButton } from "@/ui/CopyLinkButton";
import { NewTownButton } from "@/ui/NewTownButton";
import { PassportBook } from "@/ui/PassportBook";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Your Town dashboard — passport, towns, settings, and billing.",
};

const GITHUB_URL = "https://github.com/RedPlanetHQ/town";

export default async function DashboardPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/api/auth/login?next=/dashboard");

  const [towns, purchases, passport] = await Promise.all([
    getTownsByOwner(session.user.id),
    prisma.entitlementGrant.findMany({
      where: { userId: session.user.id, source: "purchase" },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    loadPassportData(session.userId),
  ]);
  const townCount = towns.length;
  const pricingOn = isPricingEnabled();
  const stampCount = passport?.stamps.length ?? 0;
  // Pre-render every spread server-side. `PassportBook` toggles which
  // one is visible client-side — no data fetching on nav.
  const passportSpreads = passport
    ? Array.from({ length: spreadCountFor(stampCount) }, (_, i) =>
        renderSpread(passport, i),
      )
    : [];
  const shareUrl =
    passport && passport.passportId !== "TP-PENDING"
      ? `/passport/${passport.passportId}`
      : null;

  return (
    <main className="h-screen overflow-y-auto bg-black text-paper">
      {/* Top nav — Explore left, logo centered, GitHub right. */}
      <nav className="border-b-2 border-paper/10">
        <div className="mx-auto grid max-w-5xl grid-cols-3 items-center px-4 py-3">
          <a
            href="/explore"
            className="justify-self-start text-xs font-bold uppercase tracking-wider text-paper/70 hover:text-paper"
          >
            Explore
          </a>
          <a
            href="/dashboard"
            aria-label="Dashboard"
            className="flex items-center justify-center gap-2 justify-self-center"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/town_logo_light.svg" alt="" aria-hidden className="h-6 w-6" />
            <span className="text-sm font-black uppercase tracking-widest">Town</span>
          </a>
          <a
            href={GITHUB_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="justify-self-end text-xs font-bold uppercase tracking-wider text-paper/70 hover:text-paper"
          >
            GitHub ↗
          </a>
        </div>
      </nav>

      <div className="mx-auto flex max-w-5xl flex-col gap-10 px-4 py-10">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold uppercase tracking-wider">Dashboard</h1>
          <p className="text-sm uppercase tracking-wider text-paper/60">
            {session.user.name} · {townCount} town{townCount === 1 ? "" : "s"}
          </p>
        </header>

        {/* Passport — inline SVG so the dashboard shows the artifact
            itself, not a card that navigates away. */}
        <section>
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <div>
              <h2 className="text-xs font-bold uppercase tracking-widest text-paper/50">
                Passport
              </h2>
              {passport ? (
                <div className="mt-1 text-[10px] font-mono uppercase tracking-widest text-paper/40">
                  {stampCount} stamp{stampCount === 1 ? "" : "s"} · {passport.passportId}
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              {shareUrl ? <CopyLinkButton href={shareUrl} /> : null}
              <a
                href="/api/passport/pdf"
                className="border-2 border-paper/30 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10"
                download
              >
                Download PDF
              </a>
            </div>
          </div>
          {passportSpreads.length > 0 ? (
            <PassportBook spreads={passportSpreads} stampCount={stampCount} />
          ) : (
            <div className="border-2 border-paper/15 p-6 text-center text-xs uppercase tracking-widest text-paper/50">
              Passport unavailable
            </div>
          )}
        </section>

        {/* Towns */}
        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-xs font-bold uppercase tracking-widest text-paper/50">
              Your towns
            </h2>
            <NewTownButton />
          </div>

          {townCount === 0 ? (
            <div className="flex flex-col items-center gap-3 border-2 border-paper/15 p-6 text-center">
              <p className="text-sm font-bold text-paper/80">
                You don&apos;t have any towns yet.
              </p>
              <NewTownButton className="border-2 border-paper/30 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10">
                + New town
              </NewTownButton>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {towns.map((t) => {
                const aura = t.aura
                  ? { current: t.aura.current, max: t.aura.max }
                  : { current: 1000, max: 1000 };
                const pct = Math.min(100, Math.max(0, (aura.current / aura.max) * 100));
                return (
                  // Plain <a> (not next/link) so entering a town does a full
                  // document load — kaplay canvas + module-level realtime
                  // state need a fresh mount, otherwise the client-side
                  // navigation lands on a blank canvas.
                  <a
                    key={t.id}
                    href={`/${t.slug}`}
                    className="group flex flex-col gap-3 border-2 border-paper/15 p-4 hover:border-paper/40 hover:bg-white/5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-lg font-black">{t.name}</div>
                        <div className="mt-0.5 text-[10px] font-mono uppercase tracking-widest text-paper/50">
                          /{t.slug}
                        </div>
                      </div>
                      <span className="text-xs font-bold uppercase tracking-wider text-paper/50 group-hover:text-paper">
                        Enter →
                      </span>
                    </div>
                    <div>
                      <div className="flex items-center justify-between text-[10px] font-mono uppercase tracking-widest text-paper/50">
                        <span>Aura</span>
                        <span>
                          {aura.current.toLocaleString()} / {aura.max.toLocaleString()}
                        </span>
                      </div>
                      <div className="mt-1 h-1 w-full border border-paper/20 bg-paper/5">
                        <div className="h-full bg-paper/70" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  </a>
                );
              })}
            </div>
          )}
        </section>

        {/* Settings — BYOK */}
        <BYOKSection />

        {/* Billing */}
        <section className="border-2 border-paper/15 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <div className="text-xs font-bold uppercase tracking-widest text-paper/50">
                Billing
              </div>
              <div className="mt-1 text-lg font-black">Purchases &amp; top-ups</div>
              <p className="mt-2 text-xs text-paper/70">
                Aura top-ups and town-slot purchases. Every grant is logged
                below with the Stripe session id.
              </p>

              {pricingOn ? (
                <div className="mt-4">
                  <BillingPurchases
                    towns={towns.map((t) => ({ slug: t.slug, name: t.name }))}
                  />
                </div>
              ) : null}

              {purchases.length > 0 ? (
                <ul className="mt-4 flex flex-col gap-2">
                  {purchases.map((p) => (
                    <li
                      key={p.id}
                      className="flex items-center justify-between border border-paper/10 px-3 py-2 text-xs"
                    >
                      <span className="font-mono uppercase tracking-widest">
                        {p.target} · +{p.delta.toLocaleString()}
                      </span>
                      <span className="text-paper/50">
                        {p.createdAt.toISOString().slice(0, 10)}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 text-xs text-paper/50">No purchases yet.</p>
              )}
            </div>
            {pricingOn ? null : (
              <span className="shrink-0 border-2 border-paper/20 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-paper/50">
                Disabled
              </span>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
