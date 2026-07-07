// /explore — public leaderboard of opted-in towns.
//
// Server component. Loads every Town with isPublic = true (plus its
// aura + owner name + visit count), computes score = aura.current +
// SCORE_VISITOR_WEIGHT * distinctVisitors, sorts desc, caps at 100.
// Row links go to /{slug}?invite_code={shareCode} so a visitor lands
// on the gate with the code pre-filled — they only type their name.

import Link from "next/link";
import type { Metadata } from "next";

import { prisma } from "@/lib/db";
import { InfoPageShell } from "@/ui/InfoPageShell";

// Weight applied to distinct-visitor count when ranking towns. One
// visitor ≈ 10 aura, so a bustling town with a modest aura reserve
// still outranks a big town nobody visits. Tune here.
const SCORE_VISITOR_WEIGHT = 10;
const MAX_ROWS = 100;

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Leaderboard",
  description: "Top public towns ranked by aura + visitors.",
};

type Row = {
  slug: string;
  name: string;
  description: string | null;
  shareCode: string;
  ownerName: string;
  aura: number;
  visitors: number;
  score: number;
};

async function loadRows(): Promise<Row[]> {
  const towns = await prisma.town.findMany({
    where: { isPublic: true, status: "active" },
    select: {
      slug: true,
      name: true,
      description: true,
      shareCode: true,
      owner: { select: { name: true } },
      aura: { select: { current: true } },
      _count: { select: { visits: true } },
    },
  });

  return towns
    .map((t) => {
      const aura = t.aura?.current ?? 0;
      const visitors = t._count.visits;
      return {
        slug: t.slug,
        name: t.name,
        description: t.description,
        shareCode: t.shareCode,
        ownerName: t.owner.name,
        aura,
        visitors,
        score: aura + SCORE_VISITOR_WEIGHT * visitors,
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_ROWS);
}

export default async function ExplorePage() {
  const rows = await loadRows();

  return (
    <InfoPageShell
      maxWidth="3xl"
      title={
        <>
          Public <span className="text-primary">town</span> leaderboard
        </>
      }
      subtitle={`Ranked by aura + ${SCORE_VISITOR_WEIGHT} × visitors. Owners opt in from the identity menu.`}
    >
      {rows.length === 0 ? <EmptyState /> : <LeaderboardTable rows={rows} />}
    </InfoPageShell>
  );
}

function EmptyState() {
  return (
    <section
      className="nb-card-dark flex flex-col items-center gap-2 p-8 text-center"
      style={{ borderColor: "rgba(246, 243, 234, 0.12)" }}
    >
      <p className="text-sm font-bold uppercase tracking-wider text-paper/80">
        No public towns yet.
      </p>
      <p className="text-xs uppercase tracking-wider text-paper/50">
        Owners publish from the identity menu → &ldquo;Publish to /explore&rdquo;.
      </p>
    </section>
  );
}

function LeaderboardTable({ rows }: { rows: Row[] }) {
  return (
    <section
      className="nb-card-dark flex flex-col p-2"
      style={{ borderColor: "rgba(246, 243, 234, 0.12)" }}
    >
      <div className="grid grid-cols-[36px_1fr_80px_80px_100px] items-center gap-3 border-b-2 border-paper/15 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-paper/50">
        <span>#</span>
        <span>Town</span>
        <span className="text-right">Aura</span>
        <span className="text-right">Visits</span>
        <span className="text-right">Score</span>
      </div>
      {rows.map((row, i) => (
        <LeaderboardRow key={row.slug} rank={i + 1} row={row} />
      ))}
    </section>
  );
}

function LeaderboardRow({ rank, row }: { rank: number; row: Row }) {
  // Podium rows lean on the site's primary blue for the top slot and
  // fall back to muted paper for everyone else — no yellow/silver/bronze
  // scale that would fight the existing palette.
  const rankColor = rank === 1 ? "text-primary" : "text-paper/50";

  // Preserve the owner's original casing on the description line —
  // the rest of the row is uppercase tracking, but a description is
  // prose. Lower-case with normal tracking reads as content, not chrome.
  const description = row.description?.trim();

  return (
    <Link
      href={`/${row.slug}?invite_code=${row.shareCode}`}
      className="grid grid-cols-[36px_1fr_80px_80px_100px] items-center gap-3 border-b border-paper/10 px-3 py-3 text-xs font-bold uppercase tracking-wider last:border-b-0 hover:bg-white/5"
    >
      <span className={`font-mono ${rankColor}`}>{rank}</span>
      <span className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden
          className="flex h-8 w-8 flex-none items-center justify-center border-2 border-paper/20 bg-paper/5 font-mono text-sm text-paper"
        >
          {row.name.slice(0, 1).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm text-paper">{row.name}</span>
            <span className="truncate text-[10px] uppercase tracking-wider text-paper/50">
              @{row.ownerName}
            </span>
          </span>
          {description ? (
            <span className="truncate text-[11px] font-medium normal-case tracking-normal text-paper/55">
              {description}
            </span>
          ) : null}
        </span>
      </span>
      <span className="text-right font-mono text-paper/70">{row.aura}</span>
      <span className="text-right font-mono text-paper/70">{row.visitors}</span>
      <span className="text-right font-mono text-paper">
        {row.score.toLocaleString()}
      </span>
    </Link>
  );
}
