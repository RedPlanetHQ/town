// /dashboard — landing surface for signed-in players.
//
// Ships the minimum useful shell for now: passport, list of owned
// towns with aura, and the entry point for creating another. Grows
// later into settings, billing, and a world-map view.

import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";

import { getSessionFromCookie } from "@/lib/session";
import { getTownsByOwner } from "@/lib/town";
import { InfoPageShell } from "@/ui/InfoPageShell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Dashboard",
  description: "Your Town dashboard — passport, towns, and settings.",
};

export default async function DashboardPage() {
  const session = await getSessionFromCookie();
  if (!session) redirect("/api/auth/login?next=/dashboard");

  const towns = await getTownsByOwner(session.user.id);
  const townCount = towns.length;

  return (
    <InfoPageShell
      title="Dashboard"
      subtitle={`${session.user.name} · ${townCount} town${townCount === 1 ? "" : "s"}`}
      maxWidth="4xl"
    >
      <div className="flex flex-col gap-8">

        {/* Passport card */}
        <section className="border-2 border-paper/15 p-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs font-bold uppercase tracking-widest text-paper/50">
                Passport
              </div>
              <div className="mt-1 text-lg font-black text-paper">
                Your Town passport
              </div>
              <p className="mt-2 text-xs text-paper/70">
                Every town you visit lands a stamp on your passport.
                Shareable, downloadable, follows you across towns.
              </p>
            </div>
            <Link
              href="/passport"
              className="shrink-0 border-2 border-paper/30 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-paper hover:bg-white/10"
            >
              Open passport →
            </Link>
          </div>
        </section>

        {/* Towns list */}
        <section>
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="text-xs font-bold uppercase tracking-widest text-paper/50">
              Your towns
            </h2>
            <Link
              href="https://town.getcore.me"
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs font-bold uppercase tracking-wider text-paper/70 hover:text-paper"
            >
              + New town
            </Link>
          </div>

          {townCount === 0 ? (
            <div className="border-2 border-paper/15 p-6 text-center">
              <p className="text-sm font-bold text-paper/80">
                You don't have any towns yet.
              </p>
              <p className="mt-2 text-xs text-paper/60">
                Use the CLI (<code className="font-mono">pnpm dlx @redplanethq/town init</code>) or the &ldquo;+ New town&rdquo; link above to create one.
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
                  <Link
                    key={t.id}
                    href={`/${t.slug}`}
                    className="group flex flex-col gap-3 border-2 border-paper/15 p-4 hover:border-paper/40 hover:bg-white/5"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-lg font-black text-paper">{t.name}</div>
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
                        <span>{aura.current.toLocaleString()} / {aura.max.toLocaleString()}</span>
                      </div>
                      <div className="mt-1 h-1 w-full border border-paper/20 bg-paper/5">
                        <div
                          className="h-full bg-paper/70"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </InfoPageShell>
  );
}
