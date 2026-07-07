import type { Metadata } from "next";

import { InfoPageShell } from "@/ui/InfoPageShell";

export const metadata: Metadata = {
  title: "Feedback",
  description:
    "Ways to help town keep growing — join the Discord, star the repo, or report a bug.",
};

const DISCORD_INVITE = "https://discord.gg/YGUZcvDjUa";
const REPO_URL = "https://github.com/redplanethq/town";
const NEW_ISSUE_URL = "https://github.com/redplanethq/town/issues/new";

export default function FeedbackPage() {
  return (
    <InfoPageShell
      title={
        <>
          Help keep <span className="text-primary">town</span> alive
        </>
      }
      subtitle="Town is open source and built by a small team. Three ways to help the project keep growing."
    >
      <FeedbackCard
        number="01"
        title="Join the Discord"
        description="Talk to other players, follow updates, and help shape what gets built next."
        href={DISCORD_INVITE}
        linkLabel="discord.gg/YGUZcvDjUa"
      />

      <FeedbackCard
        number="02"
        title="Star on GitHub"
        description="A star helps more developers discover town. Takes one click."
        href={REPO_URL}
        linkLabel="github.com/redplanethq/town"
      />

      <FeedbackCard
        number="03"
        title="Report a bug"
        description="Found something broken? File an issue on GitHub — screenshots and repro steps help most."
        href={NEW_ISSUE_URL}
        linkLabel="Open new issue →"
      />
    </InfoPageShell>
  );
}

function FeedbackCard({
  number,
  title,
  description,
  href,
  linkLabel,
}: {
  number: string;
  title: string;
  description: string;
  href: string;
  linkLabel: string;
}) {
  return (
    <section
      className="nb-card-dark flex flex-col gap-3 p-5"
      style={{ borderColor: "rgba(246, 243, 234, 0.12)" }}
    >
      <h2 className="text-sm font-bold uppercase tracking-wider">
        <span className="text-primary">{number}.</span>{" "}
        <span className="text-paper">{title}</span>
      </h2>
      <p className="text-xs uppercase tracking-wider text-paper/60">
        {description}
      </p>
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="self-start rounded-sm border-2 border-paper/20 px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-paper/80 hover:border-primary hover:text-primary"
      >
        {linkLabel}
      </a>
    </section>
  );
}
