// /dashboard — landing surface for signed-in players.
//
// Custom shell (not `InfoPageShell`) so we can host a proper top nav
// with the logo + Explore + GitHub links, and grow sections for
// passport, towns, settings (BYOK), and billing without fighting the
// simpler info-page template.

import { redirect } from "next/navigation";
import type { Metadata } from "next";

import { prisma } from "@/lib/db";
import { isPricingEnabled } from "@/lib/pricing";
import { getSessionFromCookie } from "@/lib/session";
import { getTownsByOwner } from "@/lib/town";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Your Town dashboard — passport, towns, settings, and billing.",
};

const GITHUB_URL = "https://github.com/RedPlanetHQ/town";

export default async function DashboardPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/api/auth/login?next=/dashboard");

  const [towns, purchases] = await Promise.all([
    getTownsByOwner(session.user.id),
    prisma.entitlementGrant.findMany({
      where: { userId: session.user.id, source: "purchase" },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);
  const townCount = towns.length;
  const pricingOn = isPricingEnabled();

  return (
    <main className="min-h-screen bg-black text-paper">
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

        {/* Passport */}
        <section className="border-2 border-paper/15 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs font-bold uppercase tracking-widest text-paper/50">
                Passport
              </div>
              <div className="mt-1 text-lg font-black">Your Town passport</div>
              <p className="mt-2 text-xs text-paper/70">
                Every town you visit lands a stamp. Shareable, downloadable,
                follows you across towns.
              </p>
            </div>
            <a
              href="/passport"
              className="shrink-0 border-2 border-paper/30 px-3 py-1.5 text-xs font-bold uppercase tracking-wider hover:bg-white/10"
            >
              Open passport →
            </a>
          </div>
        </section>

        {/* Towns */}
        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-xs font-bold uppercase tracking-widest text-paper/50">
              Your towns
            </h2>
            <a
              href="https://town.getcore.me"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-bold uppercase tracking-wider text-paper/70 hover:text-paper"
            >
              + New town
            </a>
          </div>

          {townCount === 0 ? (
            <div className="border-2 border-paper/15 p-6 text-center">
              <p className="text-sm font-bold text-paper/80">
                You don&apos;t have any towns yet.
              </p>
              <p className="mt-2 text-xs text-paper/60">
                Use the CLI ({<code className="font-mono">pnpm dlx @redplanethq/town init</code>}) or the &ldquo;+ New town&rdquo; link above.
              </p>
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
        <section className="border-2 border-paper/15 p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs font-bold uppercase tracking-widest text-paper/50">
                Settings
              </div>
              <div className="mt-1 text-lg font-black">Model keys · BYOK</div>
              <p className="mt-2 text-xs text-paper/70">
                Bring your own OpenAI, Anthropic, or Ollama Cloud key — chats
                that use your key skip the aura debit entirely. Coming soon.
              </p>
            </div>
            <span className="shrink-0 border-2 border-paper/20 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-paper/50">
              Coming soon
            </span>
          </div>
        </section>

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
            <span
              className={`shrink-0 border-2 px-3 py-1.5 text-xs font-bold uppercase tracking-wider ${
                pricingOn
                  ? "border-paper/30 text-paper"
                  : "border-paper/20 text-paper/50"
              }`}
            >
              {pricingOn ? "Live" : "Disabled"}
            </span>
          </div>
        </section>
      </div>
    </main>
  );
}
