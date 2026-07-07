import type { Metadata } from "next";

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
    <main className="min-h-screen bg-black px-4 py-10 text-paper">
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-8">
        <a
          href="/"
          className="self-start text-xs font-bold uppercase tracking-wider text-paper/70 hover:text-paper"
        >
          ← Back to city
        </a>

        <header className="flex flex-col gap-3">
          <h1 className="text-2xl font-bold uppercase tracking-wider">
            Help keep <span className="text-primary">town</span> alive
          </h1>
          <p className="text-sm uppercase tracking-wider text-paper/60">
            Town is open source and built by a small team. Three ways to help
            the project keep growing.
          </p>
        </header>

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
      </div>
    </main>
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
