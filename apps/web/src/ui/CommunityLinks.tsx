"use client";

// Top-left community pills: GitHub stars + Discord. Rendered as
// HudButton siblings to the identity card so the three sit side-by-side
// at the same height. The star count is pulled live from the public
// GitHub API; the badge falls back to the bare "GitHub" label on
// network failure.

import { useEffect, useState } from "react";

import { HudButton } from "./HudButton";

const GITHUB_REPO = "redplanethq/core";
const DISCORD_INVITE = "https://discord.gg/YGUZcvDjUa";

function formatCount(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function useGithubStars(): number | null {
  const [stars, setStars] = useState<number | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: { accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (!body || typeof body !== "object") return;
        const n = (body as { stargazers_count?: number }).stargazers_count;
        if (typeof n === "number") setStars(n);
      })
      .catch(() => undefined);
    return () => ctrl.abort();
  }, []);
  return stars;
}

export function CommunityLinks() {
  const stars = useGithubStars();
  return (
    <>
      <HudButton
        href={`https://github.com/${GITHUB_REPO}`}
        target="_blank"
        rel="noopener noreferrer"
        title="Star Town on GitHub"
        aria-label="GitHub"
        icon={<GithubGlyph />}
      >
        {stars === null ? "GitHub" : `★ ${formatCount(stars)}`}
      </HudButton>
      <HudButton
        href={DISCORD_INVITE}
        target="_blank"
        rel="noopener noreferrer"
        title="Join the CORE Discord"
        aria-label="Discord"
        icon={<DiscordGlyph />}
      >
        Discord
      </HudButton>
      <HudButton
        href="/explore"
        title="Browse the public towns leaderboard"
        aria-label="Explore"
        icon={<ExploreGlyph />}
      >
        Explore
      </HudButton>
    </>
  );
}

function ExploreGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.2 6.2-3 7.4-7.4 3 3-7.4 7.4-3ZM12 10.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" />
    </svg>
  );
}

function GithubGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M12 .5C5.73.5.5 5.73.5 12c0 5.08 3.29 9.39 7.86 10.91.58.11.79-.25.79-.55v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.34-1.28-1.7-1.28-1.7-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.71 0-1.26.45-2.29 1.19-3.1-.12-.29-.52-1.47.11-3.07 0 0 .98-.31 3.2 1.18a11.1 11.1 0 0 1 5.82 0c2.22-1.49 3.2-1.18 3.2-1.18.63 1.6.23 2.78.11 3.07.74.81 1.19 1.84 1.19 3.1 0 4.44-2.7 5.41-5.26 5.7.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.55 4.56-1.53 7.85-5.84 7.85-10.91C23.5 5.73 18.27.5 12 .5Z" />
    </svg>
  );
}

function DiscordGlyph() {
  return (
    <svg width={12} height={12} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M20.317 4.369A19.79 19.79 0 0 0 16.558 3a13.3 13.3 0 0 0-.617 1.249 18.7 18.7 0 0 0-5.882 0A12.7 12.7 0 0 0 9.442 3a19.74 19.74 0 0 0-3.76 1.369C2.06 9.74 1.078 14.97 1.568 20.13a19.94 19.94 0 0 0 5.99 3.001c.484-.652.916-1.345 1.288-2.075a12.86 12.86 0 0 1-2.029-.957c.17-.123.337-.252.498-.384 3.91 1.795 8.14 1.795 12.005 0 .163.132.33.261.499.384a12.9 12.9 0 0 1-2.03.957c.372.73.804 1.423 1.288 2.075a19.93 19.93 0 0 0 5.99-3.001c.575-5.9-1.027-11.087-4.75-15.761Zm-12.65 12.6c-1.183 0-2.157-1.075-2.157-2.4 0-1.327.953-2.402 2.157-2.402 1.205 0 2.179 1.075 2.157 2.402 0 1.325-.952 2.4-2.157 2.4Zm7.946 0c-1.184 0-2.156-1.075-2.156-2.4 0-1.327.952-2.402 2.156-2.402 1.205 0 2.179 1.075 2.157 2.402 0 1.325-.952 2.4-2.157 2.4Z" />
    </svg>
  );
}
